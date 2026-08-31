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

const DB_NAME = 'locally-uncensored-store'
const STORE = 'kv'
const DB_VERSION = 1

// FIX-3-era corrupt localStorage value ("[object Object]"). Must never be
// hydrated or migrated — treat it as absent so the store starts clean.
const LEGACY_CORRUPT = '[object Object]'

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
    req.onsuccess = () => resolve(req.result)
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

// A read that FAILED and a key that holds nothing are the same value — `null` —
// to everything above this module, and the two demand opposite reactions: an
// empty store hydrates clean and may be written over, a failed read must never
// be written over. So the failure has to leave the resolve path entirely.
// `db.transaction()` can also throw synchronously (InvalidStateError once the
// connection has been closed under us by a corrupt profile), which the executor
// turns into a rejection for free.
function idbGet(key: string): Promise<string | null> {
  return getDB().then((db) => new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(key)
    r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => reject(r.error ?? new Error(`indexedDB read failed for ${key}`))
  }))
}
function idbSet(key: string, value: string): Promise<void> {
  return getDB().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
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
 *  trusted. Callers that REPLACE a whole persisted blob (the appData snapshot)
 *  must ask before writing. */
export function hasFailedRead(name: string): boolean {
  return readFailed.has(name)
}

/** Test seam: the latch is module state, and a test that provokes a read
 *  failure must be able to hand the next test a clean module. */
export function resetIdbFailureLatch(): void {
  readFailed.clear()
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

let _persistAsked = false
function askPersist(): void {
  if (_persistAsked) return
  _persistAsked = true
  try {
    const s = (navigator as any)?.storage
    if (s && typeof s.persist === 'function') s.persist().catch(() => {})
  } catch { /* not supported */ }
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
        log.error('[idbStorage] IndexedDB read failed — hydrating from fallback, writes are held back', {
          key: name,
          err: String(err),
        })
        return lsGet(name) // idb failed at runtime → localStorage
      }
      // A read that came back is authoritative in both directions, so a key that
      // recovered stops holding its writes back.
      readFailed.delete(name)
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
    return (async () => {
      try {
        await idbSet(name, value)
        lsDel(name) // drop the migrated localStorage copy → frees the 5 MB cap
      } catch (err) {
        // Say it out loud. localStorage swallows its own quota errors, so if
        // this fallback also fails nothing anywhere would ever mention that the
        // user's chats are no longer being saved — they would simply be gone
        // after the next launch.
        log.warn('[idbStorage] IndexedDB write failed, falling back to localStorage', {
          key: name,
          err: String(err),
        })
        lsSet(name, value) // idb write failed → localStorage best-effort
        if (lsGet(name) !== value) {
          log.error('[idbStorage] BOTH backends failed — this state is NOT being persisted', {
            key: name,
            bytes: value.length,
          })
        }
      }
    })()
  },
  removeItem(name: string): void | Promise<void> {
    emitWrite(name, null)
    if (!hasIDB) { lsDel(name); return }
    return (async () => { try { await idbDel(name) } catch { /* ignore */ } ; lsDel(name) })()
  },
}

/**
 * A write onto a key whose last read failed. The state being offered was
 * hydrated from that failed read, so it is the DEFAULT state, not the user's —
 * writing it is the data loss this whole latch exists to prevent.
 *
 * One read decides. It is the only thing that can tell the two survivable cases
 * apart, and it is cheap next to what it protects:
 *   - reads back a value  → the row is intact and this state is not derived
 *                           from it. Refuse, keep the latch, say so loudly.
 *   - reads back nothing  → the key really is empty (a first run behind a
 *                           transient failure). Release the latch and write.
 *   - fails again         → still blind. Refuse, keep the latch.
 */
function holdBackWrite(name: string, value: string): Promise<void> {
  return (async () => {
    let existing: string | null
    try {
      existing = await idbGet(name)
    } catch (err) {
      log.error('[idbStorage] write held back: the key is still unreadable, refusing to overwrite it', {
        key: name,
        err: String(err),
      })
      return
    }
    if (existing != null) {
      log.error('[idbStorage] write held back: this key HAS data that a failed read hid from hydration', {
        key: name,
        storedBytes: existing.length,
        offeredBytes: value.length,
      })
      return
    }
    readFailed.delete(name)
    emitWrite(name, value)
    try {
      await idbSet(name, value)
      lsDel(name)
    } catch (err) {
      log.warn('[idbStorage] IndexedDB write failed, falling back to localStorage', {
        key: name,
        err: String(err),
      })
      lsSet(name, value)
    }
  })()
}
