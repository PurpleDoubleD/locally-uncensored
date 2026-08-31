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
]

const STORE_KEY_SET = new Set(STORE_KEYS)

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
const idbMirror: Record<string, string> = {}

onIdbWrite((key, value) => {
  if (!IDB_STORE_KEYS.has(key)) return
  if (value == null) delete idbMirror[key]
  else idbMirror[key] = value
})

/**
 * Read an IndexedDB-backed value for the snapshot. Costs one read per key per
 * session: after that the write listener above keeps the mirror current.
 */
async function idbValueForBackup(key: string): Promise<string | null> {
  const mirrored = idbMirror[key]
  if (mirrored !== undefined) return mirrored
  const read = await Promise.resolve(idbStorage.getItem(key)).catch(() => null)
  if (read != null) idbMirror[key] = read
  return read
}

/**
 * Whether the IndexedDB side can be trusted right now.
 *
 * `backup_stores` REPLACES the file. A key whose read failed looks exactly like
 * a key holding nothing, so a snapshot built during a read failure omits the
 * chats and then overwrites the one copy of them that was left. Refusing to
 * write keeps yesterday's backup, which is worth incomparably more than a
 * current one with the history missing.
 */
function idbReadsAreTrustworthy(): boolean {
  for (const key of IDB_STORE_KEYS) {
    if (hasFailedRead(key)) return false
  }
  return true
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
 * @param idbCache when given, every IndexedDB value read is mirrored into it,
 *        so a caller that later has to build a snapshot without awaiting
 *        anything (beforeunload) has something to read from.
 */
export async function collectStoreSnapshot(
  idbCache?: Record<string, string>,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = { __ts: new Date().toISOString() }
  for (const key of STORE_KEYS) {
    const val = IDB_STORE_KEYS.has(key)
      ? await Promise.resolve(idbStorage.getItem(key))
      : localStorage.getItem(key)
    if (val) {
      snapshot[key] = val
      if (idbCache && IDB_STORE_KEYS.has(key)) idbCache[key] = val
    }
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
  if (!idbReadsAreTrustworthy()) {
    log.warn('[store-backup] skipping the snapshot: an IndexedDB store is unreadable right now')
    return 'held-back'
  }
  const body = await collectComparableSnapshot()
  // Asked again: the reads happen between the two checks, and a key that failed
  // during them is missing from `body` while looking exactly like an empty one.
  if (!idbReadsAreTrustworthy()) {
    log.warn('[store-backup] a store became unreadable while the snapshot was being built')
    return 'held-back'
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
    if (!idbReadsAreTrustworthy()) return 'held-back'
    // The mirror is the only IndexedDB value reachable without awaiting, and a
    // snapshot built without a key REPLACES a file that had it. Before the
    // first async backup has filled the mirror there is no way to tell "this
    // store is empty" from "nobody has looked yet" — and closing the window in
    // those first seconds would have written the chats out of the backup.
    for (const key of IDB_STORE_KEYS) {
      if (idbMirror[key] !== undefined) continue
      if (lastWritten === null || lastWritten[key] !== undefined) return 'held-back'
    }
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
    if (!idbReadsAreTrustworthy()) {
      log.error('[store-backup] refusing to replace the backup: an IndexedDB store is unreadable')
      return false
    }
    const snapshot = await collectStoreSnapshot()
    if (!idbReadsAreTrustworthy()) {
      log.error('[store-backup] a store became unreadable mid-snapshot, keeping the previous backup')
      return false
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

/** Test seam. `lastWritten` and the mirror are module state, and a test that
 *  wants to observe the FIRST write of a session has to be able to get one. */
export function resetStoreBackupState(): void {
  lastWritten = null
  for (const key of Object.keys(idbMirror)) delete idbMirror[key]
}

/** Exported for the coverage test, which has to know which keys the snapshot
 *  is allowed to contain. */
export function isBackedUpKey(key: string): boolean {
  return STORE_KEY_SET.has(key)
}
