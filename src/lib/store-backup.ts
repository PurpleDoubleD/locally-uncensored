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
 * A user, 2.6.5, Discord #general 18.08.: "has anyone lost their
 * chats after a restart??", then "My code chats are vaporised", a coding chat
 * around 230k tokens. A user on the same build lost nothing.
 */
import { backendCall } from '../api/backend'
import { idbStorage, hasFailedRead, onIdbWrite } from './idbStorage'
import { log } from './logger'
import { isBackupHeld } from './backup-hold'
import { isMobile } from './device-kind'

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
  'rag-store', 'workflow-store', 'lu-cloud-catalog', 'lu-cloud-gate',
  'lu_cloud_notice', 'lu_comfy_notice', 'locally-uncensored-model-health',
  // 3.0.8: which LU Cloud outage sentence was closed (stores/cloudOutageStore).
  'lu-cloud-outage',
  // Neuron tweaker slider values per model and persona (3.0.9, P11).
  'lu-neuron-tweaker',
  'locally-uncensored-agent-goal',
  // Computer control: the switch and the always allowed apps.
  'locally-uncensored-computer',
  // Create in chat: the orders of every conversation, so a card and its
  // result survive a lost WebView profile like the chat they stand in.
  'LU-create-orders',
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
  // The phone shell (3.1). Settings that only a phone has and that live in
  // plain localStorage keys of their own, outside src/stores, so the test
  // that walks src/stores cannot see them: after a restore the theme, the
  // small preferences, the list of paired desktops and the two model
  // switches were back on their defaults. None of them carries a secret (the
  // Remote token sits in the Keystore or Keychain under its own name and is
  // not listed, on purpose). A desktop never has these keys, and a key that
  // holds nothing is left out of the snapshot, so nothing changes there.
  //   lu-mobile-theme                 System, Dark or Light
  //   lu-mobile-settings-prefs        counter opt out, system voice, self test
  //   lu-mobile-remote-desktops       addresses of desktops paired before
  //   lu-mobile-resume-seen           which cut off answers were already announced
  //   lu-mobile-download-wifi-only    model settings: ask before mobile data
  //   lu-mobile-unload-in-background  model settings: free the model in the background
  'lu-mobile-theme', 'lu-mobile-settings-prefs', 'lu-mobile-remote-desktops',
  'lu-mobile-resume-seen', 'lu-mobile-download-wifi-only', 'lu-mobile-unload-in-background',
  // Round 3 (M8). Found missing by the review: the text of the backup says
  // "chats and settings", and these did not come back.
  //   lu-mobile-remote            the chats held with a paired desktop, on
  //                               IndexedDB (see IDB_STORE_KEYS). The session
  //                               token is NOT in this state, it sits under
  //                               `lu-mobile-remote-token` or in the Keystore
  //                               or Keychain (mobile/remote/tokenVault.ts)
  //   lu-mobile-create-presets    Create settings the user saved under a name
  //   lu-mobile-character-names   the names given to trained characters
  //   lu-pending-cloud-jobs       paid cloud jobs that are still running, so
  //                               their result is fetched after a restore
  //   lu-cloud-submit-intents     a submit that was sent and not answered yet
  // Guard: src/lib/__tests__/store-backup-covers-mobile.test.ts
  'lu-mobile-remote', 'lu-mobile-create-presets', 'lu-mobile-character-names',
  'lu-pending-cloud-jobs', 'lu-cloud-submit-intents',
  // Round 39 (gap L7, mobile-docs/r39/restore.md). Phone keys that had only
  // the IndexedDB copy of boot/settings-durable.ts, which does not help when
  // localStorage is dropped as a whole:
  //   lu-mobile-thinking-default-v1    the mark that thinking was switched off
  //                                    once; without it the start switches it
  //                                    off again over the user's choice
  //   lu-mobile-report-queue           reports the user was told are saved and
  //                                    sent later (at most REPORT_QUEUE_MAX,
  //                                    each field cut, a few dozen KB at most)
  //   lu-mobile-switched-under-answer  which answers stopped for a model switch
  //                                    (at most SWITCHED_MAX ids)
  // Guard: src/mobile/boot/__tests__/local-keys-backup.test.ts
  'lu-mobile-thinking-default-v1', 'lu-mobile-report-queue', 'lu-mobile-switched-under-answer',
  // L5, check of package 17 (mobile-docs/r41/funde.md). When the settings were
  // last written (boot/settings-durable.ts). The start compares it with the
  // stamp in localStorage when the copy in IndexedDB is gone, and takes the
  // settings of this backup when they are newer. Listed last, so a snapshot
  // reads it after the settings it stamps.
  'lu-mobile-settings-stamp',
]

/** The phone keys of STORE_KEYS, for the tests that hold the two lists together. */
export const MOBILE_STORE_KEYS: readonly string[] = [
  'lu-mobile-theme', 'lu-mobile-settings-prefs', 'lu-mobile-remote-desktops',
  'lu-mobile-resume-seen', 'lu-mobile-download-wifi-only', 'lu-mobile-unload-in-background',
]

// ── No secrets in a phone backup ────────────────────────────────────────
//
// On the desktop store_backup.json is a file in the app's own data folder
// that nothing but the app reads, and it exists to carry the stores across a
// WebView2 wipe, API token of the local API included (see 'lu-local-api'
// above). On a phone the same folder is what the system copies off the
// device: the cloud backup of Android, a transfer to a new phone, an iTunes
// or Finder backup. That makes the file one that travels, and a key must not
// travel with it.
//
// What would: `lu-providers` keeps a provider key in localStorage, reversed
// and base64 encoded, whenever the secure storage is missing or a write to it
// failed (stores/providerStore.ts, partialize). That is obfuscation, not
// encryption. `chat-settings` holds the Brave and Tavily keys of the web
// search as plain text. `lu-local-api` holds a token, and an MCP server entry
// can carry tokens in its environment. So on a phone these four are written
// into the snapshot WITHOUT those values. A provider whose key was left out
// keeps its entry and its address; after a restore the key is read from the
// secure storage again, or the user types it once more.
//
// The desktop snapshot is byte for byte what it was.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Names of fields that hold a credential. Matched on the whole name, so `maxTokens` or `tokenCount` are not touched. */
const SECRET_FIELD = /^(api[-_]?key|[a-z0-9]+api[-_]?key|token|[a-z0-9]+token|secret|[a-z0-9]+secret|password|passcode|authorization)$/i

/** Blank every string in a field that is named like a credential, at any depth. Returns whether something changed. */
function blankSecretFields(node: Json): boolean {
  if (!node || typeof node !== 'object') return false
  let changed = false
  if (Array.isArray(node)) {
    for (const item of node) if (blankSecretFields(item)) changed = true
    return changed
  }
  for (const [name, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (value !== '' && SECRET_FIELD.test(name)) {
        node[name] = ''
        changed = true
      }
    } else if (blankSecretFields(value)) {
      changed = true
    }
  }
  return changed
}

/** The environment of an MCP server is free text chosen by the user: every value goes. */
function blankMcpEnvironments(node: Json): boolean {
  if (!node || typeof node !== 'object') return false
  let changed = false
  if (Array.isArray(node)) {
    for (const item of node) if (blankMcpEnvironments(item)) changed = true
    return changed
  }
  for (const [name, value] of Object.entries(node)) {
    if (name === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (value[key] !== '') {
          value[key] = ''
          changed = true
        }
      }
    } else if (blankMcpEnvironments(value)) {
      changed = true
    }
  }
  return changed
}

/** The stores that can hold a credential, and how each one is cleaned. */
const SECRET_CLEANERS: Record<string, (parsed: Json) => boolean> = {
  'lu-providers': blankSecretFields,
  'chat-settings': blankSecretFields,
  'lu-local-api': blankSecretFields,
  'locally-uncensored-mcp-servers': (parsed) => {
    const a = blankSecretFields(parsed)
    const b = blankMcpEnvironments(parsed)
    return a || b
  },
}

/** Keys of STORE_KEYS whose value is cleaned of credentials before it goes into a phone backup. */
export const SECRET_BEARING_STORE_KEYS: readonly string[] = Object.keys(SECRET_CLEANERS)

/**
 * Pure: the value of one store as it may leave the device, credentials
 * blanked. A store that holds none comes back as the same string, so the
 * "did anything change" comparison of the snapshot still works on identity.
 * A value that cannot be parsed is left OUT (null): what cannot be checked
 * cannot be vouched for, and the Rust side keeps the previous backup of a
 * key the snapshot does not carry.
 */
export function withoutSecrets(key: string, value: string): string | null {
  const clean = SECRET_CLEANERS[key]
  if (!clean) return value
  let parsed: Json
  try {
    parsed = JSON.parse(value) as Json
  } catch {
    return null
  }
  return clean(parsed) ? JSON.stringify(parsed) : value
}

// The cleaned form is asked for every five seconds; the stores behind it
// change a few times a day. One remembered answer per key keeps the tick at a
// string comparison, and keeps the cleaned string the SAME object from tick
// to tick, which is what differsFromDisk compares.
const cleanedCache = new Map<string, { raw: string; clean: string | null }>()

/** What goes into the snapshot for this key on this device. Null: leave the key out. */
function valueForSnapshot(key: string, raw: string | null): string | null {
  if (!raw) return null
  if (!isMobile() || !(key in SECRET_CLEANERS)) return raw
  const known = cleanedCache.get(key)
  if (known && known.raw === raw) return known.clean
  const clean = withoutSecrets(key, raw)
  cleanedCache.set(key, { raw, clean })
  return clean
}

/** These persist through idbStorage (IndexedDB) since 2.5.0, because the
 *  5 MB localStorage cap could not hold a real history. The snapshot has to
 *  read them from there: the one-time migration deleted their localStorage
 *  copy, so localStorage.getItem answers nothing. */
export const IDB_STORE_KEYS = new Set([
  'chat-conversations', 'locally-uncensored-memory', 'staged-changes',
  // The Remote chats of the phone shell (mobile/remote/remoteClientStore.ts).
  'lu-mobile-remote',
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
  // A write (including attachment migration) may finish during the initial read.
  // Never replace its current metadata with the stale pre-migration blob.
  if (idbMirror[key] !== undefined) return idbMirror[key]
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
  const prev = pendingWrite?.body ?? activeWrite?.body ?? lastWritten
  if (!prev) return true
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
    const val = valueForSnapshot(key, IDB_STORE_KEYS.has(key)
      ? await idbValueForBackup(key)
      : localStorage.getItem(key))
    if (val) snapshot[key] = val
  }
  return snapshot
}

/** The snapshot body without the timestamp — `__ts` changes on every tick and
 *  would make every snapshot look dirty. */
async function collectComparableSnapshot(): Promise<Record<string, string>> {
  const body: Record<string, string> = {}
  for (const key of STORE_KEYS) {
    const val = valueForSnapshot(key, IDB_STORE_KEYS.has(key)
      ? await idbValueForBackup(key)
      : localStorage.getItem(key))
    if (val) body[key] = val
  }
  return body
}

// ── When the file was last written ──────────────────────────────────────
//
// "Automatic backup: today, 14:02" on the phone used to show the moment the
// user pressed "Back up now", because nothing else was known. What the line
// claims is the moment the file was WRITTEN, and that is known exactly here:
// `backup_stores` resolved. Kept for the running session only. Saving it in a
// store would change a store, which the next tick would back up, which would
// change the time again.

let lastWrittenAt: number | null = null
const writtenListeners = new Set<() => void>()

function noteWritten(): void {
  lastWrittenAt = Date.now()
  for (const listener of [...writtenListeners]) {
    try { listener() } catch { /* a listener must not cost the next backup */ }
  }
}

/** When `backup_stores` last confirmed a write in this session, ms since the epoch. Null: not yet. */
export function lastStoreBackupAt(): number | null {
  return lastWrittenAt
}

/** Called after every confirmed write. Returns the unsubscribe. */
export function onStoreBackupWritten(listener: () => void): () => void {
  writtenListeners.add(listener)
  return () => { writtenListeners.delete(listener) }
}

interface SnapshotWrite {
  body: Record<string, string>
  done: Promise<boolean>
  resolve: (ok: boolean) => void
}

// One native write and one latest snapshot. Never queue serialized histories:
// the IPC payload itself stays live until the native command returns.
let activeWrite: SnapshotWrite | null = null
let pendingWrite: SnapshotWrite | null = null

function dispatchWrite(job: SnapshotWrite): void {
  activeWrite = job
  const complete = (ok: boolean) => {
    if (ok) lastWritten = job.body
    if (ok) noteWritten()
    activeWrite = null
    job.resolve(ok)
    const next = pendingWrite
    pendingWrite = null
    if (next) dispatchWrite(next)
  }
  try {
    try { localStorage.setItem('lu-restore-complete', '1') } catch { /* quota must not block the file backup */ }
    const data = JSON.stringify({ __ts: new Date().toISOString(), ...job.body })
    void backendCall('backup_stores', { data }).then(() => complete(true), () => complete(false))
  } catch {
    complete(false)
  }
}

function writeSnapshot(body: Record<string, string>): Promise<boolean> {
  if (pendingWrite) {
    // All callers waiting for a queued snapshot wait for its newest version.
    pendingWrite.body = body
    return pendingWrite.done
  }
  let resolve!: (ok: boolean) => void
  const done = new Promise<boolean>(r => { resolve = r })
  const job = { body, done, resolve }
  if (activeWrite) pendingWrite = job
  else dispatchWrite(job)
  return done
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
  // A store is about to shrink (lib/backup-hold.ts). The file on disk keeps
  // the previous snapshot meanwhile, so waiting costs nothing.
  if (isBackupHeld()) return 'held-back'
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
  void writeSnapshot(body)
  return 'written'
}

/**
 * beforeunload's flush. Synchronous on purpose: an await during page teardown
 * means the trailing `backup_stores` invoke may never fire, so this reads the
 * localStorage stores directly and the IndexedDB ones from the mirror. If a
 * native write is still running, its successor is queued without another IPC
 * allocation. Delivery during teardown remains best effort; update-time backup
 * explicitly awaits that queue before restart.
 */
export function flushSyncStoreBackup(): 'written' | 'unchanged' | 'held-back' {
  if (isBackupHeld()) return 'held-back'
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
      const val = valueForSnapshot(key, IDB_STORE_KEYS.has(key) ? (idbMirror[key] ?? null) : localStorage.getItem(key))
      if (val) body[key] = val
    }
    if (!differsFromDisk(body)) return 'unchanged'
    void writeSnapshot(body)
    return 'written'
  } catch {
    return 'held-back' // best-effort: the window is going away either way
  }
}

/**
 * Write the backup now and resolve true only when the file on disk holds
 * `value` under `key` (the phone journal, mobile/lib/store-journal.ts).
 * False when the backup is held (a store is about to shrink), when the
 * snapshot carries something else under the key (a newer value took over,
 * and it is written by its own path), or when the write failed.
 */
export async function backupStoresHolding(key: string, value: string): Promise<boolean> {
  if (isBackupHeld()) return false
  try {
    const body = await collectComparableSnapshot()
    const wanted = valueForSnapshot(key, value)
    if (wanted === null || body[key] !== wanted) return false
    return await writeSnapshot(body)
  } catch {
    return false
  }
}

/**
 * Build a snapshot and write it, and resolve only once the file is on disk.
 *
 * All callers share the same bounded write queue. This one awaits the native
 * completion because its caller is about to end the process. It ignores the
 * dirty check for the same reason: an update is the one moment worth paying for a redundant write.
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
    const body: Record<string, string> = { ...snapshot }
    delete body.__ts
    return await writeSnapshot(body)
  } catch {
    return false
  }
}

