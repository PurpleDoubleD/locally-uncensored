// The gallery list on IndexedDB in the app (lib/gallery-persist.ts has the
// why and the steps). Started once the restore at launch has decided
// (components/layout/AppShell.tsx, mobile/boot/backup.ts): a restore writes
// `lu-gallery` back from the appData backup first, and the move must read that
// value, not write the short list of the create-store blob in front of it.

import { idbStorage, hasFailedRead } from './idbStorage'
import { log } from './logger'
import { useCreateStore, setGalleryUncapped, type GalleryItem } from '../stores/createStore'
import { startGalleryPersistence, type GalleryPersistState, type GalleryPersistence } from './gallery-persist'

// The list as the create-store blob gave it. The create store hydrates from
// localStorage synchronously, so this is read after hydration.
const atLaunch: GalleryItem[] = useCreateStore.getState().gallery

let running: Promise<GalleryPersistence> | null = null
let current: GalleryPersistence | null = null

/** Start the move and the writes. Runs once; later calls get the same handle. */
export function startGalleryStore(): Promise<GalleryPersistence> {
  running ??= startGalleryPersistence<GalleryItem>({
    storage: idbStorage,
    readFailed: hasFailedRead,
    durable: typeof indexedDB !== 'undefined' && indexedDB !== null,
    getItems: () => useCreateStore.getState().gallery,
    hydratedItems: () => atLaunch,
    setItems: (gallery) => useCreateStore.setState({ gallery }),
    subscribe: (listener) => useCreateStore.subscribe((s, prev) => {
      if (s.gallery !== prev.gallery) listener(s.gallery, prev.gallery)
    }),
    setUncapped: setGalleryUncapped,
  }).then((handle) => {
    current = handle
    log.info('[gallery] gallery storage', { state: handle.state })
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      // Best effort on the way out, like the chats: the window does not wait
      // for an IndexedDB write. The small copy in localStorage covers the rest.
      window.addEventListener('pagehide', () => { void handle.flush() })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void handle.flush()
      })
    }
    return handle
  }, (err: unknown) => {
    log.error('[gallery] starting the gallery storage failed, keeping the old way', { err: String(err) })
    running = null
    throw err
  })
  return running
}

/** Write a pending change of the gallery now. */
export function flushGalleryStore(): Promise<void> {
  return current ? current.flush() : Promise.resolve()
}

/** How the gallery is stored right now. */
export function galleryStoreState(): GalleryPersistState {
  return current?.state ?? 'waiting'
}
