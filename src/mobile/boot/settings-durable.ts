/**
 * A setting that was just changed survives the app being killed.
 *
 * Settings live in the localStorage of the WebView (the settings store under
 * `chat-settings`, and a few phone keys of their own). The WebView hands a
 * write to localStorage on to the disk with a delay: measured on Android, a
 * setting changed 0.3 s before a hard end of the app was back at its old
 * value after the restart, from 2 s on it was kept (acceptance Android,
 * re-run, N5). The iOS simulator showed the same. IndexedDB does not have
 * that delay: a chat written in the same moment was still there.
 *
 * So every write to one of the settings keys is copied into a small database
 * of its own at once, together with the moment it happened. At the next
 * start the copy is held against localStorage: when the copy is newer,
 * localStorage lost its last writes, the values of the copy are put back and
 * the page loads once more with them.
 *
 * What makes this safe:
 *  - Only a NEWER copy counts, by the stamp both sides carry. A copy that is
 *    as old or older changes nothing.
 *  - localStorage must still know an older stamp. Without one this is a
 *    fresh or emptied storage, and bringing settings back there would undo
 *    a reset.
 *  - `localStorage.clear()` drops the copy.
 *  - Without IndexedDB, or when it fails, nothing changes: the settings are
 *    in localStorage as before.
 *
 * What this cannot promise. The copy is handed to IndexedDB in the same tick
 * as the write, but IndexedDB is asynchronous: the transaction is done a few
 * milliseconds later, not within the tap. A kill inside those milliseconds
 * loses the change, and nothing a page can do closes that gap. A copy that
 * failed is tried again when the app goes to the background.
 *
 * At a full phone (round 30, B3). The copy is one row with every key, the
 * large stores included, so with no space left its write fails with a quota
 * error: that is reported (the shell says a setting is not saved) and tried
 * again after SETTINGS_COPY_RETRY_MS and when the app leaves the screen; the
 * older row stays. Seen on Android after hard ends at a full phone: the copy
 * was gone altogether (IndexedDB of a WebView is storage the system may
 * clear when space runs out), and once localStorage had lost the consent and
 * the note of the notification question, keys written once and never again,
 * while its stamp was a new one. A localStorage that knows no stamp is
 * treated as fresh here on purpose, so this copy cannot bring such keys back.
 * The two decisions that must not get lost therefore have a second home in
 * the native layer (policy/decision-vault.ts), like the age answer.
 */
import { backendCall, isTauri } from '../../api/backend'
import { reportStorageWriteFailure, reportStorageWriteOk, storageErrorMeansNoSpace } from '../../lib/storage-health'
import { MOBILE_STORE_KEYS, SECRET_BEARING_STORE_KEYS, STORE_KEYS, withoutSecrets } from '../../lib/store-backup'

/** Under this name a copy that failed is reported (lib/storage-health.ts), so the shell says that a setting is not saved. */
export const SETTINGS_COPY_KEY = 'lu-mobile-settings-copy'
/** How long after a copy that failed the next try starts. */
export const SETTINGS_COPY_RETRY_MS = 5000

/** When the settings keys were last written, in ms. Lives in localStorage and in the copy. */
export const SETTINGS_STAMP_KEY = 'lu-mobile-settings-stamp'
/**
 * Stores of the logic layer that hold what the user set or decided on a
 * phone, each under a localStorage key of its own.
 *
 * Round 9 (A-14 on Android): "Read every answer aloud" was back at its old
 * value in three kills of three, 0.36 to 0.39 s after the tap. The copy below
 * existed since round 5, but it knew `chat-settings` and the phone keys only.
 * That switch lives in the voice store. So does every other store here: a
 * permission of the agent, a provider that was added, the agent switch of a
 * chat, the list of documents of a chat, a paid job that is still running.
 * The guard in __tests__/settings-durable.test.ts walks the list of persisted
 * stores (lib/store-backup.ts) and fails for a key that is neither copied
 * nor named there with the reason why not.
 */
export const LOGIC_SETTINGS_KEYS: readonly string[] = [
  'chat-settings',
  'locally-uncensored-voice',
  'locally-uncensored-permissions',
  'lu-providers',
  'locally-uncensored-agent-mode',
  'locally-uncensored-agent-goal',
  // C59 A7: saved skills and the proposals waiting for the user.
  'lu-skills',
  'locally-uncensored-agent-workflows',
  'rag-store',
  'lu-pending-cloud-jobs',
  'lu-cloud-submit-intents',
]

/**
 * Phone keys that hold a decision: the age answer, the consent to send data
 * to the cloud (a withdrawal must not come back as a consent), a report that
 * waits to be sent, the saved Create settings. This copy only fills a
 * localStorage that lost its last writes. For a localStorage dropped as a
 * whole, the age answer, the consent and the note of the notification
 * question have the native vault (policy/decision-vault.ts, age-vault.ts),
 * the others are in the native backup (STORE_KEYS, round 39, gap L7).
 */
export const PHONE_DECISION_KEYS: readonly string[] = [
  'lu-mobile-age',
  'lu-mobile-ai-consent',
  'lu-mobile-report-queue',
  'lu-mobile-thinking-default-v1',
  'lu-mobile-create-presets',
  'lu-mobile-character-names',
  // The question for notifications was put (screens/models/parts/notify.ts). Round 30, B3: it came again.
  'lu-mobile-notify-offered',
]

/** Every key that is copied: the stores above and the phone keys that hold settings. */
export const DURABLE_SETTINGS_KEYS: readonly string[] = [...LOGIC_SETTINGS_KEYS, ...MOBILE_STORE_KEYS, ...PHONE_DECISION_KEYS]

const MIRROR_DB = 'lu-mobile-settings-mirror'
const MIRROR_STORE = 'kv'
const MIRROR_ROW = 'settings'
/** How long the start waits for the copy. IndexedDB that hangs must not hold the app. */
export const MIRROR_READ_BUDGET_MS = 800

export interface SettingsMirror {
  stamp: number
  /** Every settings key at that moment. null: the key was not set. */
  values: Record<string, string | null>
}

/** Where the copy is kept. Replaced in tests. */
export interface MirrorDoor {
  read: () => Promise<SettingsMirror | null>
  write: (mirror: SettingsMirror) => Promise<void>
  drop: () => Promise<void>
}

/* ---------- pure ---------- */

/** Pure: read a copy. Anything that is not one counts as none. */
export function parseMirror(raw: unknown): SettingsMirror | null {
  if (!raw || typeof raw !== 'object') return null
  const { stamp, values } = raw as { stamp?: unknown; values?: unknown }
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return null
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null
  const out: Record<string, string | null> = {}
  for (const key of DURABLE_SETTINGS_KEYS) {
    const value = (values as Record<string, unknown>)[key]
    if (typeof value === 'string' || value === null) out[key] = value
  }
  return { stamp, values: out }
}

/**
 * Pure: what has to be put back into localStorage. Empty when the copy is
 * not newer, when localStorage knows no stamp at all, or when nothing differs.
 */
export function settingsToRecover(liveStamp: number, live: Readonly<Record<string, string | null>>, mirror: SettingsMirror | null): Record<string, string | null> {
  if (!mirror || !(liveStamp > 0) || !(mirror.stamp > liveStamp)) return {}
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(mirror.values)) {
    if ((live[key] ?? null) !== value) out[key] = value
  }
  return out
}

/* ---------- the copy in IndexedDB ---------- */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || indexedDB === null) return resolve(null)
      const request = indexedDB.open(MIRROR_DB, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MIRROR_STORE)) request.result.createObjectStore(MIRROR_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

let db: Promise<IDBDatabase | null> | null = null

function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  db = db ?? openDb()
  return db.then(
    (database) =>
      new Promise<T | null>((resolve, reject) => {
        if (!database) return mode === 'readonly' ? resolve(null) : reject(new Error('no database for the settings copy'))
        try {
          // Strict: done means on the disk. Since Chrome 121 the default is
          // relaxed, which is the delay this copy exists to get around.
          // An engine that does not know the option ignores it.
          const tx = database.transaction(MIRROR_STORE, mode, { durability: 'strict' })
          const request = work(tx.objectStore(MIRROR_STORE))
          tx.oncomplete = () => resolve(request.result ?? null)
          tx.onerror = () => (mode === 'readonly' ? resolve(null) : reject(tx.error ?? new Error('settings copy failed')))
          tx.onabort = () => (mode === 'readonly' ? resolve(null) : reject(tx.error ?? new Error('settings copy aborted')))
        } catch (err) {
          if (mode === 'readonly') resolve(null)
          else reject(err)
        }
      }),
  )
}

export const idbMirror: MirrorDoor = {
  read: async () => parseMirror(await inStore<unknown>('readonly', (store) => store.get(MIRROR_ROW))),
  write: async (mirror) => {
    await inStore('readwrite', (store) => store.put(mirror, MIRROR_ROW))
  },
  drop: async () => {
    await inStore('readwrite', (store) => store.delete(MIRROR_ROW))
  },
}

/* ---------- the native backup as a second copy (L5) ---------- */

/**
 * Pure: the settings of the native backup (`restore_stores`) as a copy, or
 * null. Check of package 17 on Android, L5: a setting changed shortly before
 * a full phone was back at its old value after the start in 6 of 9 runs. Its
 * write to localStorage was due in the full phase and failed, and the copy
 * above lives in IndexedDB, which the start after a full phone drops. The
 * native backup carries the stamp of the settings (STORE_KEYS) and is now
 * written right after a change (boot/backup.ts).
 *
 * Only keys the backup holds count; a key it does not hold is left as it is,
 * never removed. A store the backup carries without its credentials
 * (SECRET_BEARING_STORE_KEYS) counts only when localStorage holds none
 * either, so nothing a user typed is blanked.
 */
export function mirrorFromBackup(raw: string | null | undefined, live: (key: string) => string | null): SettingsMirror | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const backup = parsed as Record<string, unknown>
  const stamp = Number(backup[SETTINGS_STAMP_KEY])
  if (!Number.isFinite(stamp) || stamp <= 0) return null
  const inBackup = new Set<string>(STORE_KEYS)
  const values: Record<string, string> = {}
  for (const key of DURABLE_SETTINGS_KEYS) {
    const value = backup[key]
    if (!inBackup.has(key) || typeof value !== 'string' || !value) continue
    if (SECRET_BEARING_STORE_KEYS.includes(key)) {
      const now = live(key)
      if (now !== null && withoutSecrets(key, now) !== now) continue
    }
    values[key] = value
  }
  return { stamp, values }
}

/** The native backup, read like the copy. Never written from here. */
export const nativeBackupDoor: MirrorDoor = {
  read: async () => {
    if (!isTauri()) return null
    const raw = await backendCall<string | null>('restore_stores')
    return mirrorFromBackup(raw, (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    })
  },
  write: async () => {},
  drop: async () => {},
}

/* ---------- localStorage, read and written past the watch ---------- */

interface RawStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function liveValues(storage: RawStorage): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const key of DURABLE_SETTINGS_KEYS) {
    try {
      out[key] = storage.getItem(key)
    } catch {
      out[key] = null
    }
  }
  return out
}

function liveStampOf(storage: RawStorage): number {
  try {
    const stamp = Number(storage.getItem(SETTINGS_STAMP_KEY) ?? 0)
    return Number.isFinite(stamp) && stamp > 0 ? stamp : 0
  } catch {
    return 0
  }
}

/* ---------- at the start: put back what localStorage lost ---------- */

export type SettingsRecovery = 'nothing' | 'recovered'

/**
 * Hold the copy against localStorage and put back what is newer there.
 * 'recovered' means localStorage was changed and the stores that already read
 * it are stale: the caller loads the page once more. Never throws.
 */
export async function recoverSettings(door: MirrorDoor = idbMirror, storage: RawStorage | null = typeof localStorage !== 'undefined' ? localStorage : null): Promise<SettingsRecovery> {
  if (!storage) return 'nothing'
  try {
    const mirror = await Promise.race([door.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), MIRROR_READ_BUDGET_MS))])
    const back = settingsToRecover(liveStampOf(storage), liveValues(storage), mirror)
    const keys = Object.keys(back)
    if (!mirror || keys.length === 0) return 'nothing'
    for (const key of keys) {
      const value = back[key]
      if (value === null) storage.removeItem(key)
      else storage.setItem(key, value)
    }
    storage.setItem(SETTINGS_STAMP_KEY, String(mirror.stamp))
    return 'recovered'
  } catch {
    return 'nothing'
  }
}

/**
 * The start: the copy in IndexedDB first. When there is none at all (the
 * start after a full phone dropped IndexedDB), the native backup is asked
 * the same question (L5). A copy that is there and holds nothing newer ends
 * it: the native backup is not read on an ordinary start.
 */
export async function recoverSettingsAtStart(
  door: MirrorDoor = idbMirror,
  backup: MirrorDoor = nativeBackupDoor,
  storage: RawStorage | null = typeof localStorage !== 'undefined' ? localStorage : null,
): Promise<SettingsRecovery> {
  if ((await recoverSettings(door, storage)) === 'recovered') return 'recovered'
  let copy: SettingsMirror | null = null
  try {
    copy = await Promise.race([door.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), MIRROR_READ_BUDGET_MS))])
  } catch {
    copy = null
  }
  if (copy) return 'nothing'
  return recoverSettings(backup, storage)
}

/* ---------- while the app runs: copy every write ---------- */

const changeListeners = new Set<() => void>()
/** Hear every change of a settings key, in the tick of the write. The backup loop writes the native backup soon after (L5). */
export function onSettingsChanged(fn: () => void): () => void {
  changeListeners.add(fn)
  return () => {
    changeListeners.delete(fn)
  }
}

let uninstall: (() => void) | null = null

/**
 * Watch the settings keys of localStorage and copy each write at once. A
 * second call does nothing. Returns a function that ends the watch (tests).
 *
 * The watch sits on the storage itself and not on the stores, because the
 * settings have several writers (the settings store, the phone preferences,
 * the theme, an import of data) and each of them has to be covered.
 */
export function installSettingsDurability(door: MirrorDoor = idbMirror, now: () => number = Date.now): () => void {
  if (uninstall) return uninstall
  if (typeof Storage === 'undefined' || typeof localStorage === 'undefined') return () => {}
  const proto = Storage.prototype
  const original = { setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear }
  const raw: RawStorage = {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => original.setItem.call(localStorage, key, value),
    removeItem: (key) => original.removeItem.call(localStorage, key),
  }
  const watched = new Set(DURABLE_SETTINGS_KEYS)
  let writing = false
  let again = false
  let lastStamp = 0
  /** The stamp of the last copy that arrived. Behind `lastStamp`: something is still owed. */
  let copiedStamp = 0
  let retry: ReturnType<typeof setTimeout> | null = null

  // Called in the same tick as the write to localStorage. No timer, no
  // debounce: the only wait is for a copy that is already on its way.
  const copy = () => {
    if (writing) {
      again = true
      return
    }
    writing = true
    const mirror: SettingsMirror = { stamp: lastStamp, values: liveValues(raw) }
    void door
      .write(mirror)
      .then(() => {
        copiedStamp = Math.max(copiedStamp, mirror.stamp)
        reportStorageWriteOk(SETTINGS_COPY_KEY)
      })
      .catch((err: unknown) => {
        // Said out loud, and tried again by itself: with a full phone the change of a setting was lost
        // without a word, like a chat (finding F11 of check 4 on Android).
        reportStorageWriteFailure({
          key: SETTINGS_COPY_KEY,
          bytes: 0,
          savedTo: 'nowhere',
          error: String(err),
          reason: storageErrorMeansNoSpace(err) ? 'no-space' : 'other',
        })
        if (!retry) {
          retry = setTimeout(() => {
            retry = null
            if (lastStamp > copiedStamp) copy()
          }, SETTINGS_COPY_RETRY_MS)
        }
      })
      .finally(() => {
        writing = false
        if (again) {
          again = false
          copy()
        }
      })
  }

  // The app goes to the background, the usual last moment before the system
  // ends it: a copy that failed is tried once more.
  const onLeave = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
    if (lastStamp > copiedStamp) copy()
  }
  const onPageHide = () => {
    if (lastStamp > copiedStamp) copy()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onLeave)
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)

  // A stamp from the first start on. The start only puts a copy back into a
  // localStorage that knows an older stamp, so without this the very first
  // setting a user changes was the one change a kill could still take: the
  // stamp was written together with it and lost together with it. A copy
  // that is older than this stamp stays where it is, so a reset stays a reset.
  if (liveStampOf(raw) === 0) {
    lastStamp = Math.max(now(), 1)
    copiedStamp = lastStamp
    try {
      raw.setItem(SETTINGS_STAMP_KEY, String(lastStamp))
    } catch {
      /* full or forbidden: the first change then writes the stamp */
    }
  }

  const changed = () => {
    // Never the same stamp twice, also for two writes in one millisecond.
    lastStamp = Math.max(now(), lastStamp + 1, liveStampOf(raw) + 1)
    try {
      raw.setItem(SETTINGS_STAMP_KEY, String(lastStamp))
    } catch {
      /* full or forbidden: the copy still carries the stamp */
    }
    copy()
    for (const fn of [...changeListeners]) {
      try {
        fn()
      } catch {
        /* a listener must not break a write */
      }
    }
  }

  proto.setItem = function (this: Storage, key: string, value: string) {
    const watchedHere = this === localStorage && watched.has(key)
    // A write of the same value is none: stores write on every start.
    const same = watchedHere && raw.getItem(key) === String(value)
    original.setItem.call(this, key, value)
    if (watchedHere && !same) changed()
  }
  proto.removeItem = function (this: Storage, key: string) {
    const had = this === localStorage && watched.has(key) && raw.getItem(key) !== null
    original.removeItem.call(this, key)
    if (had) changed()
  }
  proto.clear = function (this: Storage) {
    original.clear.call(this)
    // Emptied on purpose: nothing may come back from the copy.
    if (this === localStorage) void door.drop().catch(() => {})
  }

  uninstall = () => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onLeave)
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
    proto.setItem = original.setItem
    proto.removeItem = original.removeItem
    proto.clear = original.clear
    if (retry) clearTimeout(retry)
    retry = null
    uninstall = null
  }
  return uninstall
}

const RELOADED_KEY = 'lu-mobile-settings-recovered'

/**
 * Load the page once more so every store reads the values that were put
 * back. At most once per run of the app: should the second start find
 * something to put back again, the app starts with what it has instead of
 * loading in a circle. Returns true when the page is about to reload.
 */
export function reloadOnceForSettings(): boolean {
  try {
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return false
    if (sessionStorage.getItem(RELOADED_KEY)) return false
    sessionStorage.setItem(RELOADED_KEY, '1')
    window.location.reload()
    return true
  } catch {
    return false
  }
}
