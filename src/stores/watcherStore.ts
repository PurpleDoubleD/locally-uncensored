// Watchers: the list as Rust keeps it (src-tauri/src/watchers.rs), mirrored
// for the line above the composer. Rust is the only owner; this store only
// reads it back after every change (`watchers-changed`).
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { Watcher, WatcherHint, WatcherListing } from '../lib/watchers/types'

interface WatcherState {
  watchers: Watcher[]
  hints: WatcherHint[]
  set: (l: WatcherListing) => void
}

export const useWatcherStore = create<WatcherState>((set) => ({
  watchers: [],
  hints: [],
  set: (l) => set({ watchers: l.watchers ?? [], hints: l.hints ?? [] }),
}))

/** Is this chat the one a watcher writes into. */
export function isWatcherConversation(convId: string | null | undefined): boolean {
  return !!convId && useWatcherStore.getState().watchers.some((w) => w.conversation_id === convId)
}

export type WatcherNotifyOn = 'all' | 'errors'

interface WatcherSettingsState {
  /** A notification of the system when a watcher ran. */
  notify: boolean
  sound: boolean
  /** 'all': results and errors; 'errors': only when a run failed. */
  notifyOn: WatcherNotifyOn
  /** The first watcher of this install has sent its "set" notification. On a
   *  Mac the first notification of an app brings the system's permission
   *  question, and the banner itself is then only filed away (live test
   *  14.11.2026). So the question comes when the user makes a watcher and is
   *  at the computer, not with the first result at 3 a.m. */
  greeted: boolean
  update: (patch: Partial<Pick<WatcherSettingsState, 'notify' | 'sound' | 'notifyOn' | 'greeted'>>) => void
}

/** Settings → Agent → Watchers. Kept apart from the big settings blob: three
 *  switches of one feature, nothing the chat changes. */
export const useWatcherSettingsStore = create<WatcherSettingsState>()(
  persist(
    (set) => ({
      notify: true,
      sound: true,
      notifyOn: 'all',
      greeted: false,
      update: (patch) => set(patch),
    }),
    { name: 'lu-watcher-settings', version: 1, storage: safeJSONStorage() },
  ),
)
