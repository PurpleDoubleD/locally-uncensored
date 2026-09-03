/**
 * The store snapshot that goes to %APPDATA%/store_backup.json, and the two
 * things a caller ever wants from it: the list of keys, and "write one now".
 *
 * WHY IT MOVED OUT OF AppShell (Bug A1, 2.6.7). The backup was reachable only
 * from the component that owns the triad, so the update path could not ask for
 * one. It handed the process to the installer with whatever the last interval
 * happened to have written, up to five seconds and a whole answer old. The
 * moment a self update is about to take the process down is the single most
 * valuable moment to have a current copy of the chats on disk, and it was the
 * one moment nothing asked for one.
 *
 * aldrich_ironhart, 2.6.5, Discord #general 18.08.: "has anyone lost their
 * chats after a restart??", then "My code chats are vaporised", a coding chat
 * around 230k tokens. sockenmonster on the same build lost nothing.
 */
import { backendCall } from '../api/backend'
import { idbStorage, hasFailedRead, onIdbWrite } from './idbStorage'
import { log } from './logger'

/** Every store that is worth carrying across an update or a wiped WebView2
 *  profile. Order is irrelevant, presence is not: a key missing from this list
 *  is a store that silently does not survive, which is how `lu_cloud_notice`
 *  came back on every update while its own comment claimed it did not.
 *
 *  The list is asserted against the persist keys actually declared in
 *  src/stores by store-backup-covers-every-store.test.ts — a new persisted
 *  store fails that test rather than quietly not surviving an update. */
export const STORE_KEYS = [
  'chat-conversations', 'chat-settings', 'chat-models', 'lu-providers',
  'create-store', 'locally-uncensored-codex',
  'locally-uncensored-permissions', 'locally-uncensored-mcp-servers',
  'locally-uncensored-agent-mode', 'locally-uncensored-memory',
  'locally-uncensored-agent-workflows', 'locally-uncensored-agent',
  'locally-uncensored-voice', 'lu-benchmark-store', 'lu-update-checker-v2',
  'rag-store', 'workflow-store', 'lu-cloud-catalog',
  'lu_cloud_notice', 'lu_comfy_notice', 'locally-uncensored-model-health',
  'locally-uncensored-agent-goal',
  // Added 2.6.8. Every one of these was persisted and none of them was listed,
  // so the NSIS/WebView2 wipe this file exists to survive destroyed them:
  //   staged-changes            approved edits that are not on disk yet — the
  //                             exact loss Morgan reported on 2026-08-11, one
  //                             layer further down than the fix he got
  //   locally-uncensored-todos  the plan a long agent run is working through
  //   locally-uncensored-ui     explorer geometry
  //   lu_release_notes          which version's notes were already read
  //   locally-uncensored-downloads  downloadMeta/bundleMap, i.e. which model
  //                             bundles are installed; re-deriving it means
  //                             re-downloading tens of GB
  'staged-changes', 'locally-uncensored-todos', 'locally-uncensored-ui',
  'lu_release_notes', 'locally-uncensored-downloads',
  // Die lokale Modell-API (2.6.8). Sie MUSS hier stehen, denn sie traegt das
  // einzige Geheimnis in dieser Liste: das API-Token. Geht es bei einem Update
  // verloren, antwortet die API allen bereits eingerichteten Programmen des
  // Nutzers mit 401 — und die Fehlermeldung dort sagt nichts ueber ein Update.
  'lu-local-api',
]

/** These persist through idbStorage (IndexedDB) since 2.5.0, because the
 *  5 MB localStorage cap could not hold a real history. The snapshot has to
 *  read them from there: the one-time migration deleted their localStorage
 *  copy, so localStorage.getItem answers nothing. */
export const IDB_STORE_KEYS = new Set([
  'chat-conversations', 'locally-uncensored-memory', 'staged-changes',
])

/**
 * The last snapshot that was actually handed to `backup_stores`, without the
 * timestamp. Everything below compares against it instead of writing blindly.
 */
let lastWritten: Record<string, string> | null = null

/**
 * The newest value each IndexedDB-backed store has written this session.
 *
 * WHY IT EXISTS. The triad's tick used to pull the whole chat history back out
 * of IndexedDB every five seconds just to hand it straight to JSON.stringify —
 * a multi-megabyte string minted, serialised and written to the SSD on a timer,
 * forever, on battery, in an app nobody has touched. Every one of those bytes
 * already passed through idbStorage.setItem on its way to disk, so listening is
 * strictly better than re-reading: same string, no allocation, and the identity
 * of the reference makes the "did anything change" comparison a pointer test.
 */
const idbMirror: Record<string, string | null> = {}

onIdbWrite((key, value) => {
  if (!IDB_STORE_KEYS.has(key)) return
  // `null` is knowledge, not absence of it: a removeItem says this key holds
  // nothing now. Deleting the entry instead would put the key back on the
  // re-read treadmill below.
  idbMirror[key] = value
})

/**
 * Read an IndexedDB-backed value for the snapshot. Costs one read per key per
 * session: after that the write listener above keeps the mirror current.
 *
 * The answer is cached in BOTH directions. It used to cache only a non-null
 * one, which meant a store that legitimately holds nothing was pulled out of
 * IndexedDB again on every five-second tick, forever — and 'staged-changes'
 * holds nothing for every user who has never approved a code edit. That is a
 * read per tick that can only ever return null, and every one of them is
 * another chance for a transient failure to arm the read-failure latch.
 *
 * A read that FAILED is never cached: the latch has to stay the thing that
 * decides, and the next tick has to try again — that retry is what releases it.
 */
async function idbValueForBackup(key: string): Promise<string | null> {
  const mirrored = idbMirror[key]
  if (mirrored !== undefined) return mirrored
  const read = await Promise.resolve(idbStorage.getItem(key)).catch(() => undefined)
  if (read === undefined || hasFailedRead(key)) return null
  idbMirror[key] = read
  return read
}

/**
 * Which IndexedDB-backed stores could not be read, so the snapshot below has
 * to leave them out.
 *
 * WHAT `backup_stores` ACTUALLY DOES. It does not replace the file. It reads
 * the backup that is already on disk and carries over every key that held a
 * non-empty value and is missing (or empty) in the incoming snapshot —
 * commands/system.rs, `keys_lost` + `merged_backup`, with the untouched
 * previous file set aside once as store_backup.prev.json. A snapshot that lost
 * a key is therefore INCOMPLETE, and the file that lands still has the key.
 *
 * The old rule was built on the opposite belief and refused the whole write
 * while any one of the three IndexedDB stores was unreadable. That cost the
 * other twenty-three stores their backup for as long as it lasted, and it
 * lasted for the rest of the session: the refusal happened before the snapshot
 * was built, so nothing re-read the key, and only a read can clear the latch
 * (see hasFailedRead). One unlucky read of an empty 'staged-changes' and the
 * chats stopped being backed up until the app was restarted.
 *
 * What survives of the rule is the part that is true: a key that could not be
 * read must be OMITTED, never written out as empty. Omitted is precisely the
 * shape the Rust side knows how to repair.
 */
function unreadableIdbKeys(): string[] {
  return [...IDB_STORE_KEYS].filter((key) => hasFailedRead(key))
}

/** True when `next` differs from what is already on disk. Keys whose value is
 *  the identical string reference (everything the mirror serves) settle on the
 *  pointer comparison. */
function differsFromDisk(next: Record<string, string>): boolean {
  if (!lastWritten) return true
  const prev = lastWritten
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return true
  for (const key of nextKeys) {
    if (prev[key] !== next[key]) return true
  }
  return false
}

/**
 * Read every store into one flat object.
 *
 * A key that cannot be read is left out — never recorded as empty — so the
 * Rust side's merge keeps whatever the previous backup had for it.
 */
export async function collectStoreSnapshot(): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = { __ts: new Date().toISOString() }
  for (const key of STORE_KEYS) {
    const val = IDB_STORE_KEYS.has(key)
      ? await idbValueForBackup(key)
      : localStorage.getItem(key)
    if (val) snapshot[key] = val
  }
  return snapshot
}

/** The snapshot body without the timestamp — `__ts` changes on every tick and
 *  would make every snapshot look dirty. */
async function collectComparableSnapshot(): Promise<Record<string, string>> {
  const body: Record<string, string> = {}
  for (const key of STORE_KEYS) {
    const val = IDB_STORE_KEYS.has(key)
      ? await idbValueForBackup(key)
      : localStorage.getItem(key)
    if (val) body[key] = val
  }
  return body
}

function writeSnapshot(body: Record<string, string>): void {
  try { localStorage.setItem('lu-restore-complete', '1') } catch { /* quota */ }
  // Marked clean optimistically so the next tick can skip, and un-marked if the
  // invoke fails — otherwise one failed write would make the triad believe the
  // change is on disk and it would never be retried.
  lastWritten = body
  backendCall('backup_stores', { data: JSON.stringify({ __ts: new Date().toISOString(), ...body }) })
    .catch(() => { if (lastWritten === body) lastWritten = null })
}

/**
 * What the 5 s interval and the 1 s debounce call.
 *
 * Writes only when a store actually changed. Before this the triad serialised
 * and re-wrote the entire history unconditionally every five seconds — the
 * multi-megabyte churn coalescedStorage was written to stop, reintroduced one
 * layer up, running on an idle app for as long as it is open.
 *
 * Returns what it did, so the caller (and a test) can tell a skipped tick from
 * a written one.
 */
export async function backupStoresIfChanged(): Promise<'written' | 'unchanged' | 'held-back'> {
  const body = await collectComparableSnapshot()
  const blind = unreadableIdbKeys()
  if (blind.length > 0) {
    // The keys are already absent from `body` (idbValueForBackup refuses to
    // cache or return a value it could not read), so the write below is an
    // incomplete snapshot and the Rust merge keeps the previous values for
    // them. Writing it anyway is the point: the other stores changed too, and
    // this call is also the retry that clears the latch once IndexedDB
    // recovers.
    log.warn('[store-backup] snapshot is incomplete — these stores are unreadable right now', {
      keys: blind,
    })
  }
  if (!differsFromDisk(body)) return 'unchanged'
  writeSnapshot(body)
  return 'written'
}

/**
 * beforeunload's flush. Synchronous on purpose: an await during page teardown
 * means the trailing `backup_stores` invoke may never fire, so this reads the
 * localStorage stores directly and the IndexedDB ones from the mirror.
 */
export function flushSyncStoreBackup(): 'written' | 'unchanged' | 'held-back' {
  try {
    // The mirror is the only IndexedDB value reachable without awaiting, and
    // before the first async backup has filled it there is no way to tell
    // "this store is empty" from "nobody has looked yet". Both come out of
    // this function the same way: the key is simply not in the body. That is
    // survivable because `backup_stores` merges a missing key back from the
    // file already on disk (see unreadableIdbKeys) — the previous version of
    // this guard believed the file was replaced wholesale and refused the
    // flush entirely, which threw away the localStorage stores' last five
    // seconds for nothing.
    const body: Record<string, string> = {}
    for (const key of STORE_KEYS) {
      const val = IDB_STORE_KEYS.has(key) ? (idbMirror[key] ?? null) : localStorage.getItem(key)
      if (val) body[key] = val
    }
    if (!differsFromDisk(body)) return 'unchanged'
    writeSnapshot(body)
    return 'written'
  } catch {
    return 'held-back' // best-effort: the window is going away either way
  }
}

/**
 * Build a snapshot and write it, and resolve only once the file is on disk.
 *
 * The triad's own backup is fire and forget on purpose, it must never hold up
 * a render. This one is awaited, because its whole reason to exist is the
 * caller that is about to end the process. It ignores the dirty check for the
 * same reason: an update is the one moment worth paying for a redundant write.
 *
 * Returns whether the file was written. Never throws: a backup that fails is
 * not a reason to refuse an update the user already agreed to.
 */
export async function backupStoresNow(): Promise<boolean> {
  try {
    const snapshot = await collectStoreSnapshot()
    const blind = unreadableIdbKeys()
    if (blind.length > 0) {
      // Incomplete, not destructive — the Rust merge keeps the previous value
      // for every key this snapshot lost. Refusing here used to look careful
      // and was the opposite: this is the last write before the installer
      // takes the process down, so refusing it threw away the newest todos,
      // staged edits and settings to protect chats that were never at risk.
      log.error('[store-backup] update-time snapshot is incomplete — unreadable stores keep their previous backup', {
        keys: blind,
      })
    }
    localStorage.setItem('lu-restore-complete', '1')
    await backendCall('backup_stores', { data: JSON.stringify(snapshot) })
    // Same body the dirty check compares against, so the tick right after an
    // update-time backup does not rewrite the identical file.
    const body: Record<string, string> = { ...snapshot }
    delete body.__ts
    lastWritten = body
    return true
  } catch {
    return false
  }
}

