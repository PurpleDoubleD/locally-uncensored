/**
 * Keep a backup of all stores in the app's data folder.
 *
 * The desktop does this in AppShell with three prongs: every 5 s if something
 * changed, 1 s after a chat change, and a synchronous flush on `beforeunload`.
 * The third one does not come on a phone. Its place is taken by the moment
 * the app goes to the background: about 3 s later the WebView and Rust are
 * frozen (measured in the iOS simulator), so that flush is synchronous too.
 */
import { backendCall, isTauri } from '../../api/backend'
import { backupRagChunksAfterWrite, backupRagChunksIfChanged } from '../../lib/rag-backup'
import { onChunksSaved } from '../../lib/ragDB'
import { log } from '../../lib/logger'
import { onStorageWriteFailure } from '../../lib/storage-health'
import { backupStoresIfChanged, flushSyncStoreBackup, IDB_STORE_KEYS } from '../../lib/store-backup'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { installSavedCharactersBackup, restoreSavedCharactersAtStart } from '../lib/saved-characters-backup'
import { onLifecycle } from '../platform/lifecycle'
import { restoreDecided } from './restore'
import { startGalleryStore } from '../../lib/gallery-persist-wiring'

const STORE_INTERVAL_MS = 5_000
const CHAT_DEBOUNCE_MS = 1_000
/** How soon a store backup follows a write IndexedDB refused (D-VW) or a changed setting (L5). */
export const BACKUP_SOON_MS = 300
/** At most one such early backup per second; a store that changes all the time (a running cloud job) is not written more often. */
export const BACKUP_SOON_GAP_MS = 1_000
const RAG_INTERVAL_MS = 30_000

let soonHook: (() => void) | null = null

/**
 * A store backup within a second instead of on the 5 s beat. For a changed
 * setting (L5, check of package 17, mobile-docs/r41/funde.md): a change
 * shortly before a full phone was lost, because its write to localStorage
 * fell into the full phase and the copy in IndexedDB was dropped at the start.
 * Does nothing before the loop is armed (the restore has not decided yet).
 */
export function backupStoresSoon(): void {
  soonHook?.()
}

/** Start the backup loop. Returns a function that stops it. Does nothing outside the native app. */
export function startBackup(): () => void {
  if (!isTauri()) return () => {}
  let disposed = false
  let cleanup: (() => void) | null = null

  const arm = async () => {
    // Never write the first backup before the restore looked at the old one.
    await restoreDecided
    if (disposed) return
    // The gallery list to IndexedDB (3.1.0, C27), after the restore wrote its
    // copy back. Its failure keeps the old way and must not cost the backups.
    void startGalleryStore().catch(() => {})

    let storesBusy = false
    const backupStores = async () => {
      if (storesBusy) return
      storesBusy = true
      try {
        await backupStoresIfChanged()
      } catch {
        /* best effort, the next tick tries again */
      }
      storesBusy = false
    }

    // The document vectors: written only when they differ from the last
    // backup (lib/rag-backup.ts). The desktop exports everything every 30 s;
    // on a phone that is a full read of IndexedDB for nothing, most of the time.
    const backupRag = () => {
      void backupRagChunksIfChanged().catch(() => {})
    }

    // Keep the onboarding marker in step, so a lost WebView storage does not replay the onboarding.
    backendCall<boolean>('is_onboarding_done')
      .catch(() => false)
      .then((markerExists) => {
        if (!markerExists && useSettingsStore.getState().settings.onboardingDone) {
          backendCall('set_onboarding_done').catch(() => {})
        }
      })

    void backupStores()
    backupRag()
    const storeTimer = setInterval(() => void backupStores(), STORE_INTERVAL_MS)
    const ragTimer = setInterval(backupRag, RAG_INTERVAL_MS)
    // A document that was just read goes into the backup at once, not on the
    // next 30 s beat: a kill in between and a dropped IndexedDB left it in
    // the list without its passages (gap L2, mobile-docs/r38/luecken.md).
    const offChunks = onChunksSaved(() => {
      void backupRagChunksAfterWrite().catch(() => {})
    })

    // The saved characters of Create have their own copy beside the backup (gap L3).
    if (installSavedCharactersBackup()) {
      void restoreSavedCharactersAtStart().catch((err: unknown) => {
        log.warn('[mobile boot] the saved characters could not be checked against the backup', { err: String(err) })
      })
    }

    // A store backup soon, once, however many asks come meanwhile. The 5 s beat stays for everything else.
    let soon: ReturnType<typeof setTimeout> | null = null
    let lastSoon = 0
    const backupSoon = () => {
      if (soon) return
      const wait = Math.max(BACKUP_SOON_MS, lastSoon + BACKUP_SOON_GAP_MS - Date.now())
      soon = setTimeout(() => {
        soon = null
        lastSoon = Date.now()
        void backupStores()
      }, wait)
    }
    soonHook = backupSoon
    // While IndexedDB refuses every write (after a phase with a full disk it stays so until the app restarts,
    // D-VW in the check of package 17), the native backup is the only copy of a memory, a Remote chat or a
    // staged change; it took up to 5 s before. The chats have their own 1 s debounce below.
    const offRefused = onStorageWriteFailure((failure) => {
      if (failure.savedTo === 'nowhere' && IDB_STORE_KEYS.has(failure.key) && failure.key !== 'chat-conversations') backupSoon()
    })

    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubChat = useChatStore.subscribe(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void backupStores(), CHAT_DEBOUNCE_MS)
    })

    const offLifecycle = onLifecycle({
      // Synchronous on purpose: nothing after an await is sure to run once the app is in the background.
      onBackground: () => {
        flushSyncStoreBackup()
      },
    })

    cleanup = () => {
      clearInterval(storeTimer)
      clearInterval(ragTimer)
      offChunks()
      offRefused()
      soonHook = null
      if (soon) clearTimeout(soon)
      if (debounce) clearTimeout(debounce)
      unsubChat()
      offLifecycle()
    }
  }
  void arm()

  return () => {
    disposed = true
    cleanup?.()
  }
}
