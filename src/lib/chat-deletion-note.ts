/**
 * Watches the chat store and notes every chat that leaves the list as deleted
 * on purpose (lib/chat-deletions.ts). Installed once per app: by the chat list
 * on the phone, by the restore hint in the shell on the desktop.
 */
import { useChatStore } from '../stores/chatStore'
import { chatIdsChanged, noteChatsLeft } from './chat-deletions'

let installed = false
let stop: () => void = () => {}

/**
 * From the moment the chat store has hydrated. Before that the list is the
 * empty start value, and what hydration does not bring is exactly the loss
 * the restore is for.
 */
export function installDeletionNote(): void {
  if (installed) return
  installed = true
  const start = () => {
    let prev = useChatStore.getState().conversations
    stop = useChatStore.subscribe((state) => {
      if (state.conversations === prev) return
      const { gone, back } = chatIdsChanged(prev, state.conversations)
      prev = state.conversations
      noteChatsLeft(gone, back)
    })
  }
  if (useChatStore.persist.hasHydrated()) start()
  else useChatStore.persist.onFinishHydration(() => start())
}

/** Only for tests. */
export function __resetDeletionNoteForTests(): void {
  stop()
  stop = () => {}
  installed = false
}
