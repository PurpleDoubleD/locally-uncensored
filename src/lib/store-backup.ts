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
import { idbStorage } from './idbStorage'

/** Every store that is worth carrying across an update or a wiped WebView2
 *  profile. Order is irrelevant, presence is not: a key missing from this list
 *  is a store that silently does not survive, which is how `lu_cloud_notice`
 *  came back on every update while its own comment claimed it did not. */
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
]

/** These two persist through idbStorage (IndexedDB) since 2.5.0, because the
 *  5 MB localStorage cap could not hold a real history. The snapshot has to
 *  read them from there: the one-time migration deleted their localStorage
 *  copy, so localStorage.getItem answers nothing. */
export const IDB_STORE_KEYS = new Set(['chat-conversations', 'locally-uncensored-memory'])

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

/**
 * Build a snapshot and write it, and resolve only once the file is on disk.
 *
 * The triad's own backup is fire and forget on purpose, it must never hold up
 * a render. This one is awaited, because its whole reason to exist is the
 * caller that is about to end the process.
 *
 * Returns whether the file was written. Never throws: a backup that fails is
 * not a reason to refuse an update the user already agreed to.
 */
export async function backupStoresNow(): Promise<boolean> {
  try {
    const snapshot = await collectStoreSnapshot()
    localStorage.setItem('lu-restore-complete', '1')
    await backendCall('backup_stores', { data: JSON.stringify(snapshot) })
    return true
  } catch {
    return false
  }
}
