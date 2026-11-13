/**
 * IndexedDB-backed Zustand persist storage (v2.5.0).
 *
 * WHY: chat history + memories were persisted to localStorage, whose hard
 * ~5 MB per-origin cap is far too small for real chat history (long threads,
 * inline images, imported transcripts). localStorage is also the wrong tool —
 * it's a tiny synchronous key/value store. The standard fix web apps use is
 * IndexedDB, which is disk-backed and scales to tens of GB (Chromium grants an
 * origin up to ~60% of free disk, more with persistent-storage). LU already
 * uses IndexedDB for RAG chunks + memory embeddings; this brings the chat +
 * memory STORES onto the same durable, large backend.
 *
 * DESIGN:
 *   - idb-first, with a ONE-TIME migration read from the legacy localStorage
 *     key (so existing users keep their chats/memories on upgrade), after which
 *     the localStorage copy is dropped to free that 5 MB.
 *   - SYNC localStorage fallback when IndexedDB is unavailable (the vitest
 *     `node` env, or a degraded webview). Returning a plain value (not a
 *     Promise) there keeps Zustand hydration synchronous in tests — exactly the
 *     old behaviour — so the suite is unaffected. In the real WebView2 app
 *     `indexedDB` exists, so getItem/setItem return Promises and persist
 *     hydrates asynchronously (a sub-100 ms tick on launch).
 *   - `navigator.storage.persist()` is requested once so the browser treats the
 *     data as durable and never evicts it under pressure.
 *
 * Still wrapped in `createJSONStorage(() => idbStorage)` at the call site — the
 * FIX-3 lesson: Zustand v5 `storage` needs a PersistStorage, and createJSONStorage
 * does the object<->string (de)serialisation around this string StateStorage.
 */
import type { StateStorage } from 'zustand/middleware'
import { log } from './logger'
import { isMobile } from './device-kind'
import {
  reportStorageReadFailure,
  reportStorageReadOk,
  reportStorageWriteFailure,
  reportStorageWriteOk,
  requestPersistentStorage,
  storageErrorMeansNoSpace,
} from './storage-health'

const DB_NAME = 'locally-uncensored-store'
const STORE = 'kv'
const DB_VERSION = 1

// FIX-3-era corrupt localStorage value ("[object Object]"). Must never be
// hydrated or migrated — treat it as absent so the store starts clean.
const LEGACY_CORRUPT = '[object Object]'

/** Above this a localStorage fallback cannot succeed (about 5 MB per origin). */
const LS_FALLBACK_MAX_CHARS = 4 * 1024 * 1024

function lsGet(k: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null } catch { return null }
}
function lsSet(k: string, v: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v) } catch { /* quota/SSR */ }
}
function lsDel(k: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k) } catch { /* SSR */ }
}

const hasIDB: boolean = (() => {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null } catch { return false }
})()

let _db: Promise<IDBDatabase> | null = null
function getDB(): Promise<IDBDatabase> {
  if (_db) return _db
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      // A connection the engine closes under us (a full disk makes it drop the
      // backing store, finding N6) must not stay cached: every later call would
      // fail with "The database connection is closing" until the app restarts.
      try {
        db.onclose = () => { if (_db === opening) _db = null }
        db.onversionchange = () => { try { db.close() } catch { /* already closed */ } if (_db === opening) _db = null }
      } catch { /* a stand-in without the handlers */ }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('indexedDB open blocked'))
  })
  _db = opening
  // A FAILED open must not stay cached. Keeping the rejected promise meant one
  // transient failure — a second window blocking the upgrade, a momentarily
  // busy profile dir — turned into "every read and write fails for the rest of
  // the session", i.e. the user's chats silently stopped being saved until
  // restart. Dropping it lets the next call open again.
  opening.catch(() => {
    if (_db === opening) _db = null
  })
  return opening
}

/** The connection we hold was closed by the engine: a new one can work again. */
function connectionIsClosed(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name?: unknown }).name) : ''
  return name === 'InvalidStateError' || /connection is closing|database connection/i.test(String(err))
}

/**
 * Run `run` on the open database. A closed connection is dropped and the call
 * is made once more on a new one, so one dead connection costs one retry and
 * not the rest of the session. Any other failure is passed on.
 */
async function withDB<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  try {
    return await getDB().then(run)
  } catch (err) {
    if (!connectionIsClosed(err)) throw err
    _db = null
    return await getDB().then(run)
  }
}

// A read that FAILED and a key that holds nothing are the same value — `null` —
// to everything above this module, and the two demand opposite reactions: an
// empty store hydrates clean and may be written over, a failed read must never
// be written over. So the failure has to leave the resolve path entirely.
// `db.transaction()` can also throw synchronously (InvalidStateError once the
// connection has been closed under us by a corrupt profile), which the executor
// turns into a rejection for free.
function idbGet(key: string): Promise<string | null> {
  return withDB((db) => new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(key)
    r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => reject(r.error ?? new Error(`indexedDB read failed for ${key}`))
  }))
}
/**
 * The transaction of a write. On a phone it waits for the disk.
 *
 * A write is "relaxed" by default (Chromium since 121): it is reported done
 * once the bytes are handed to the operating system, "strict" waits for the
 * sync to the storage medium as well (IndexedDB 3.0, durability hints). What
 * strict adds is safety against a crash of the whole system; a killed app
 * process does not take bytes along that the system already has. The phone
 * asks for "strict" all the same (finding N2 of the iPhone review). It does
 * NOT close the gap of finding N6b: after a full disk a committed value can
 * still be missing after a kill, see `setPhoneWriteJournal`. The chat store
 * writes at most once per coalescing window (lib/coalescedStorage.ts), so
 * this is a handful of waits per answer.
 */
function writeTransaction(db: IDBDatabase): IDBTransaction {
  if (isMobile()) {
    try {
      return db.transaction(STORE, 'readwrite', { durability: 'strict' })
    } catch {
      // An older WebView does not know the option. The write is then as durable as any other.
    }
  }
  return db.transaction(STORE, 'readwrite')
}

function idbSet(key: string, value: string): Promise<void> {
  return withDB((db) => new Promise<void>((resolve, reject) => {
    const tx = writeTransaction(db)
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}
/**
 * Whether `key` holds anything at all, WITHOUT materialising the value.
 *
 * `get` used to be used for this, and the only question ever asked of the
 * result was `!= null`: for 'chat-conversations' that is several megabytes
 * pulled out of the store, deserialised into a string and dropped again, on
 * every write the read-failure latch refuses — which, while a store is
 * unreadable, is every write zustand makes.
 *
 * `count(key)` is IndexedDB 1.0, so it is available everywhere `get` is. It
 * answers 1 for a row holding a non-string value too, where `get` answered
 * null; refusing to overwrite something unexpected is the safe direction.
 */
function idbHas(key: string): Promise<boolean> {
  return withDB((db) => new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).count(key)
    r.onsuccess = () => resolve((r.result ?? 0) > 0)
    r.onerror = () => reject(r.error ?? new Error(`indexedDB probe failed for ${key}`))
  }))
}
function idbDel(key: string): Promise<void> {
  return getDB().then((db) => new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  }))
}

/**
 * Keys whose last IndexedDB read failed for a reason that is NOT "there is
 * nothing under that key".
 *
 * The whole point of the latch: zustand hydrates from whatever getItem hands
 * back, and a failed read hands back the same `null` an empty database does.
 * The store then holds the DEFAULT state, and zustand persists on the very next
 * set() — one unreadable transaction and an untouched 230k-token history is
 * replaced by `{conversations: []}`. The appData snapshot is rebuilt from the
 * same reads seconds later, so the backup goes the same way.
 */
const readFailed = new Set<string>()

/** True while the last read of `name` failed — i.e. while "empty" cannot be
 *  trusted. Callers that build a snapshot out of these values ask so they can
 *  leave the key OUT rather than record it as empty.
 *
 *  Every way out of the latch runs through a later READ of the same key:
 *  getItem clears it when a read comes back, and holdBackWrite clears it when
 *  the row turns out to be genuinely absent. Anything that consults this flag
 *  must therefore keep reading the key afterwards — a caller that sees `true`
 *  and stops asking pins the latch for the rest of the session. */
export function hasFailedRead(name: string): boolean {
  return readFailed.has(name)
}

type IdbWriteListener = (key: string, value: string | null) => void
const writeListeners = new Set<IdbWriteListener>()

/**
 * Called with the value a persisted store just handed this backend (null on
 * removal). Exists so the appData backup can know WHICH stores changed without
 * re-reading multi-megabyte blobs out of IndexedDB on a timer — the listener
 * already has the exact string a read would have returned.
 *
 * Fires only for writes that are actually attempted: a write refused by the
 * read-failure latch must not be mistaken for the new truth.
 *
 * Load-bearing, and provably so: src/lib/__tests__/store-backup-mirror.test.ts
 * counts the IndexedDB reads the backup tick performs and fails if `emitWrite`
 * stops firing from either branch of setItem (or from removeItem).
 */
export function onIdbWrite(fn: IdbWriteListener): () => void {
  writeListeners.add(fn)
  return () => { writeListeners.delete(fn) }
}

function emitWrite(key: string, value: string | null): void {
  for (const fn of writeListeners) {
    try { fn(key, value) } catch { /* a listener must never break the write */ }
  }
}

/** Confirmed, atomic replacement for synchronization snapshots. Unlike the
 * ordinary persist adapter, this never falls back or silently loses a write.
 * Keep entries and their acknowledged revisions in the same serialized value.
 * Callers must recheck account/local state after awaiting the commit. */
export async function compareAndSetIdbItem(
  key: string, expected: string | null, value: string, isCurrent: () => boolean,
): Promise<boolean> {
  const failure = () => new Error('Could not commit synchronized memory storage')
  if (!hasIDB || !key || readFailed.has(key)) throw failure()
  // A legacy copy must first pass through normal migration. Do not overwrite
  // or remove it on the strength of an absent IndexedDB row.
  if (lsGet(key) !== null) throw failure()
  try {
    const db = await getDB()
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      let written = false
      const store = tx.objectStore(STORE)
      const request = store.get(key)
      request.onsuccess = () => {
        try {
          const actual: unknown = request.result
          if (actual !== undefined && typeof actual !== 'string') {
            tx.abort()
            return
          }
          if ((actual ?? null) !== expected || readFailed.has(key) || lsGet(key) !== null || !isCurrent()) return
          // No await between the predicate and put: account revocation and
          // local edits cannot interleave this critical section.
          store.put(value, key)
          written = true
        } catch {
          tx.abort()
        }
      }
      tx.oncomplete = () => {
        if (written) emitWrite(key, value)
        resolve(written)
      }
      tx.onerror = () => reject(failure())
      tx.onabort = () => reject(failure())
    })
  } catch {
    throw failure()
  }
}

/**
 * Whether `key` holds a value, without reading it. For callers that only need
 * to know if a store is there, such as the restore check at launch: reading a
 * large chat history just to test it for null put a second full copy of it in
 * memory while hydration was reading the first. Answers null when IndexedDB
 * could not be asked, so the caller can fall back to its old path.
 */
export async function hasStoredItem(key: string): Promise<boolean | null> {
  if (!hasIDB) return lsGet(key) != null
  try {
    return (await idbHas(key)) || lsGet(key) != null
  } catch {
    return null
  }
}

/**
 * Whether `key` holds a value the stores can actually hydrate from: a
 * non-empty string, read the way hydration reads it. Answers null when the
 * read failed, so the caller can tell "nothing there" from "could not look".
 *
 * perrt, 05.11.2026 (3.0.10): `hasStoredItem` answers yes for a row that is
 * not a string (count() sees it, getItem hands hydration null for it) and for
 * a leftover localStorage copy (the FIX-3 "[object Object]" one getItem
 * refuses). The chat store then hydrated empty while the restore at launch
 * believed the chats were there and restored nothing. This costs one full read
 * of the value; the launch check is the one place where being right about
 * "empty" matters more than that.
 */
export async function hasReadableItem(key: string): Promise<boolean | null> {
  try {
    const value = await Promise.resolve(idbStorage.getItem(key))
    if (hasFailedRead(key)) return null
    return typeof value === 'string' && value.trim() !== ''
  } catch {
    return null
  }
}

let _persistAsked = false
function askPersist(): void {
  if (_persistAsked) return
  _persistAsked = true
  // Asked through lib/storage-health.ts, which keeps the answer. It used to be
  // thrown away here, so nothing could tell whether the system may evict the
  // chats under pressure.
  void requestPersistentStorage().catch(() => {})
}

export const idbStorage: StateStorage = {
  getItem(name: string): string | null | Promise<string | null> {
    if (!hasIDB) return lsGet(name) // sync path: node tests / degraded webview
    askPersist()
    return (async () => {
      let v: string | null
      try {
        v = await idbGet(name)
      } catch (err) {
        // Latch BEFORE returning anything: from here on `null` is "we could not
        // look", not "there is nothing", and setItem has to know the difference.
        readFailed.add(name)
        noteFirstRead(name, false)
        // Said to whoever listens (lib/storage-health.ts): a shell can then
        // show "cannot be read right now" where it would have shown "empty".
        reportStorageReadFailure({ key: name, error: err })
        log.error('[idbStorage] IndexedDB read failed — hydrating from fallback, writes are held back', {
          key: name,
          err: String(err),
        })
        return lsGet(name) // idb failed at runtime → localStorage
      }
      // A read that came back is authoritative in both directions, so a key that
      // recovered stops holding its writes back.
      readFailed.delete(name)
      noteFirstRead(name, true)
      reportStorageReadOk(name)
      if (v != null) return v
      // One-time migration from the legacy localStorage backend.
      const legacy = lsGet(name)
      if (legacy != null && legacy !== LEGACY_CORRUPT) {
        // Migrate into idb, then drop the localStorage copy so the ~5 MB cap is
        // freed immediately (only on confirmed idb write — keep it if idb fails).
        try { await idbSet(name, legacy); lsDel(name) } catch { /* keep localStorage */ }
        return legacy
      }
      return null
    })()
  },
  setItem(name: string, value: string): void | Promise<void> {
    if (!hasIDB) { lsSet(name, value); emitWrite(name, value); return }
    if (readFailed.has(name)) return holdBackWrite(name, value)
    emitWrite(name, value)
    // A newer value takes the place of one that waits for its second try.
    retryValues.delete(name)
    heldValues.delete(name)
    committed.delete(name)
    return (async () => {
      try {
        await idbSet(name, value)
        lsDel(name) // drop the migrated localStorage copy → frees the 5 MB cap
        reportStorageWriteOk(name)
      } catch (err) {
        if (isMobile()) {
          phoneWriteFailed(name, value, err)
          return
        }
        // Say it out loud. localStorage swallows its own quota errors, so if
        // this fallback also fails nothing anywhere would ever mention that the
        // user's chats are no longer being saved — they would simply be gone
        // after the next launch.
        log.warn('[idbStorage] IndexedDB write failed, falling back to localStorage', {
          key: name,
          err: String(err),
        })
        // localStorage holds about 5 MB per origin. Offering it a larger value
        // only copies the string once more on the way to the quota error,
        // which is the worst moment for a copy: the value that failed here is
        // typically one Chromium refused as too large (127 MiB cap).
        if (value.length <= LS_FALLBACK_MAX_CHARS) lsSet(name, value) // idb write failed → localStorage best-effort
        const lost = value.length > LS_FALLBACK_MAX_CHARS || lsGet(name) !== value
        if (lost) {
          log.error('[idbStorage] BOTH backends failed — this state is NOT being persisted', {
            key: name,
            bytes: value.length,
          })
        }
        // And say it where a person can see it, not only in the log: the shell
        // listens (lib/storage-health.ts) and shows a notice.
        reportStorageWriteFailure({
          key: name,
          bytes: value.length,
          savedTo: lost ? 'nowhere' : 'localStorage',
          error: String(err),
        })
      }
    })()
  },
  removeItem(name: string): void | Promise<void> {
    emitWrite(name, null)
    // A value that waited to be written again is not wanted any more, so nothing of it is unsaved (phone only: the list is empty on a desktop).
    committed.delete(name)
    if (retryValues.delete(name)) reportStorageWriteOk(name)
    if (heldValues.delete(name)) reportStorageWriteOk(name)
    if (!hasIDB) { lsDel(name); return }
    return (async () => { try { await idbDel(name) } catch { /* ignore */ } ; lsDel(name) })()
  },
}

/**
 * The phone: values whose write failed and that are tried again
 * (retryFailedStorageWrites). Empty on a desktop, always.
 */
const retryValues = new Map<string, string>()

/**
 * The phone: a waiting value whose second try has been committed, and when.
 * The notice stays until the value is safe from a kill (finding N6b). After a
 * full disk a commit is not that (Android, check package 15: a kill 2 to 3 s
 * after a committed strict write lost the chat 4 of 6 times). The proof is
 * the phone journal (`setPhoneWriteJournal`). Without one, the old way is
 * kept: a short settle, a flush and a read back. That read back answers from
 * the engine's memory and is a weaker sign, measured, not derived.
 */
const committed = new Map<string, { value: string; at: number }>()

/**
 * How long a committed second try waits before it is confirmed. Chosen from
 * the Android review (every run that kept the notice for 2 s or more after
 * the commit survived a kill 5 s later); not derived from the engine.
 */
export const PHONE_SETTLE_MS = 2500
let settleMs = PHONE_SETTLE_MS
/** Test-only. */
export function __setPhoneSettleForTests(ms: number | null): void {
  settleMs = ms ?? PHONE_SETTLE_MS
}

/** The key of the small write that forces the engine to flush what came before it. */
const FLUSH_KEY = 'lu-flush-marker'

/**
 * The value is on the disk as far as this process can tell: a small strict
 * write behind it (the engine syncs its log up to there), then the value read
 * back and compared. False when it reads back as something else.
 */
function writeFlushMarker(db: IDBDatabase): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = writeTransaction(db)
    tx.objectStore(STORE).put(String(Date.now()), FLUSH_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function confirmOnDisk(name: string, value: string): Promise<boolean> {
  return withDB(async (db) => {
    await writeFlushMarker(db)
    const back = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(name)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    return back === value
  })
}

/**
 * The phone: values the read-failure latch refused to write (holdBackWrite).
 * Kept so they can be let through when the row can be read again, instead of
 * waiting for a restart that only the notice mentions (finding N6).
 */
const heldValues = new Map<string, string>()

/**
 * Whether the FIRST read of a key in this session worked. If it did, the state
 * in memory is the user's own state, so a later failed read does not make a
 * write dangerous: only a key that was never hydrated holds a default state.
 */
const firstRead = new Map<string, boolean>()
function noteFirstRead(name: string, ok: boolean): void {
  if (!firstRead.has(name)) firstRead.set(name, ok)
}

/**
 * The phone: forget a value that waits to be written again, because its
 * owner no longer wants it saved (the record of a first question, once the
 * chat itself carries the question). Without this the value was written
 * later, when there was room again, and nothing ever removed it. `only`
 * decides by the waiting value whether it is the one meant. True when a value
 * was dropped. Nothing waits on a desktop, so this does nothing there.
 */
export function dropPendingStorageWrite(name: string, only?: (value: string) => boolean): boolean {
  const waiting = retryValues.get(name) ?? heldValues.get(name)
  if (waiting === undefined || (only && !only(waiting))) return false
  retryValues.delete(name)
  heldValues.delete(name)
  committed.delete(name)
  reportStorageWriteOk(name)
  return true
}

/**
 * A failed write on a phone. Two things differ from the desktop path above.
 *
 * The localStorage copy is still written, but it is not called safe: getItem
 * reads localStorage only while IndexedDB holds NOTHING under the key, so
 * next to an older row the copy is never read again, and with a full disk
 * the WebView does not get it to the disk either (check 4 on Android,
 * finding F11: the chat was gone after the next start, and the only thing
 * the user had seen was nothing). So the failure is reported as saved
 * nowhere, with the reason, and the value is kept for a second try.
 */
function phoneWriteFailed(name: string, value: string, err: unknown): void {
  log.warn('[idbStorage] IndexedDB write failed on the phone, the value waits for a second try', {
    key: name,
    err: String(err),
  })
  if (value.length <= LS_FALLBACK_MAX_CHARS) lsSet(name, value)
  retryValues.set(name, value)
  reportStorageWriteFailure({
    key: name,
    bytes: value.length,
    savedTo: 'nowhere',
    error: String(err),
    reason: storageErrorMeansNoSpace(err) ? 'no-space' : 'other',
  })
}

/**
 * Try the writes that failed once more. The shell of the phone calls this
 * while it shows the notice (mobile/lib/storage-alerts.ts), so a chat that
 * could not be saved is saved by itself once there is room again. Resolves
 * with the number of keys that are still not written. Never rejects. Does
 * nothing on a desktop, where no value is kept.
 */
export function retryFailedStorageWrites(): Promise<number> {
  // One run at a time: the quick recheck (storage-alerts) must not start a second write of the same chat.
  if (!retrying) retrying = runRetry().finally(() => { retrying = null })
  return retrying
}
let retrying: Promise<number> | null = null

async function runRetry(): Promise<number> {
  // First the writes the latch refused (a read had failed): once the row can be
  // looked at again they are let through, so "cannot read" does not outlive the
  // full disk that caused it.
  for (const name of [...heldValues.keys()]) {
    const value = heldValues.get(name)
    if (value === undefined) continue
    try { await settleHeldBack(name, value, true) } catch { /* the next call tries again */ }
  }
  for (const name of [...retryValues.keys()]) {
    // Read at the moment of the write: a newer setItem has taken the value out and writes it itself.
    const value = retryValues.get(name)
    if (value === undefined || readFailed.has(name)) continue
    try {
      if (committed.get(name)?.value !== value) {
        await withDB(async (db) => {
          const current = retryValues.get(name)
          if (current === undefined) return
          await new Promise<void>((resolve, reject) => {
            const tx = writeTransaction(db)
            tx.objectStore(STORE).put(current, name)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error)
          })
          if (retryValues.get(name) !== current) return
          committed.set(name, { value: current, at: Date.now() })
          // Check Android package 11, N6b rest: a kill 1 to 2 s after the room came back lost the chat, although
          // its second try had been committed; the bytes were on the disk only with the flush of the confirmation
          // 2.5 s later. So the flush follows the commit at once. The notice still waits for the confirmation
          // below (settle, flush again, read back): only that says the value is on the disk.
          if (settleMs > 0) {
            try { await writeFlushMarker(db) } catch { /* the confirmation flushes again */ }
          }
        })
      }
      // The phone journal (finding N6b, round 35): the value also goes into a native file that is synced, and
      // the next start merges it back. Only that is proof against a kill: a read back from IndexedDB answers
      // from the engine's memory, not from the disk, so it cannot tell whether the value survives one.
      const journaled = committed.get(name)
      if (writeJournal && journaled && journaled.value === value && retryValues.get(name) === value) {
        let kept = false
        try { kept = await writeJournal(name, value) } catch { kept = false }
        if (kept && retryValues.get(name) === value) {
          retryValues.delete(name)
          committed.delete(name)
          lsDel(name)
          reportStorageWriteOk(name)
          continue
        }
      }
      const done = committed.get(name)
      // Committed, not yet confirmed: the notice stays, the next call confirms.
      if (!done || done.value !== value || Date.now() - done.at < settleMs) continue
      const onDisk = await confirmOnDisk(name, value)
      if (!onDisk) { committed.delete(name); continue }
      if (retryValues.get(name) === value) {
        retryValues.delete(name)
        committed.delete(name)
        lsDel(name)
        reportStorageWriteOk(name)
      }
    } catch {
      // Still no room. The notice stays, the next call tries again (from the write).
      committed.delete(name)
    }
  }
  return retryValues.size + heldValues.size
}

/**
 * The phone journal: writes a value that waited for room into a native file
 * that is synced to the disk, and leaves a note that the next start merges
 * it back. Resolves true only when both are written. Set by the phone shell
 * (mobile/lib/store-journal.ts); never on a desktop, where nothing waits.
 */
export type PhoneWriteJournal = (key: string, value: string) => Promise<boolean>
let writeJournal: PhoneWriteJournal | null = null
export function setPhoneWriteJournal(journal: PhoneWriteJournal | null): void {
  writeJournal = journal
}

/** Test-only. */
export function __resetIdbRetryForTests(): void {
  writeJournal = null
  retryValues.clear()
  heldValues.clear()
  committed.clear()
  settleMs = PHONE_SETTLE_MS
  firstRead.clear()
}

/** The phone only: a write that was refused is said out loud, so the shell can show that nothing is being saved. */
function reportHeldBack(name: string, value: string, why: string): void {
  if (!isMobile()) return
  reportStorageWriteFailure({ key: name, bytes: value.length, savedTo: 'nowhere', error: why, reason: 'unreadable' })
}

/**
 * A write onto a key whose last read failed. The state being offered was
 * hydrated from that failed read, so it is the DEFAULT state, not the user's —
 * writing it is the data loss this whole latch exists to prevent.
 *
 * One read decides. It is the only thing that can tell the two survivable cases
 * apart, and it is cheap next to what it protects:
 *   - the row exists      → it is intact and this state is not derived from
 *                           it. Refuse, keep the latch, say so loudly.
 *   - the row is absent   → the key really is empty (a first run behind a
 *                           transient failure). Release the latch and write.
 *   - fails again         → still blind. Refuse, keep the latch.
 *
 * The question is existence, so it is asked with `count`, not `get` — see
 * idbHas. Reading a multi-megabyte value to compare it against null was the
 * most expensive way available to answer a yes/no.
 */
function holdBackWrite(name: string, value: string): Promise<void> {
  return settleHeldBack(name, value, false).then(() => undefined)
}

/**
 * The decision of holdBackWrite, also asked again by the second try
 * (`again`). True when the value was written. A refusal on a phone keeps the
 * value in `heldValues`, so the second try can let it through later.
 */
function settleHeldBack(name: string, value: string, again: boolean): Promise<boolean> {
  return (async () => {
    const keep = () => { if (isMobile()) heldValues.set(name, value) }
    let occupied: boolean
    try {
      occupied = await idbHas(name)
    } catch (err) {
      log.error('[idbStorage] write held back: the key is still unreadable, refusing to overwrite it', {
        key: name,
        err: String(err),
      })
      keep()
      if (!again) reportHeldBack(name, value, String(err))
      return false
    }
    // A row that is there, under a key whose first read failed: the state offered
    // was hydrated from nothing and must not replace it. Under a key whose first
    // read worked, the state in memory is the user's own, and the write is safe.
    if (occupied && (!isMobile() || firstRead.get(name) !== true)) {
      log.error('[idbStorage] write held back: this key HAS data that a failed read hid from hydration', {
        key: name,
        offeredBytes: value.length,
      })
      keep()
      if (!again) reportHeldBack(name, value, 'the stored value could not be read')
      return false
    }
    // Another value arrived while we looked: it is written by its own call.
    if (again && heldValues.get(name) !== value) return false
    readFailed.delete(name)
    reportStorageReadOk(name)
    emitWrite(name, value)
    retryValues.delete(name)
    heldValues.delete(name)
    try {
      await idbSet(name, value)
      lsDel(name)
      reportStorageWriteOk(name)
      return true
    } catch (err) {
      if (isMobile()) {
        phoneWriteFailed(name, value, err)
        return false
      }
      log.warn('[idbStorage] IndexedDB write failed, falling back to localStorage', {
        key: name,
        err: String(err),
      })
      lsSet(name, value)
      reportStorageWriteFailure({
        key: name,
        bytes: value.length,
        savedTo: lsGet(name) === value ? 'localStorage' : 'nowhere',
        error: String(err),
      })
      return false
    }
  })()
}
