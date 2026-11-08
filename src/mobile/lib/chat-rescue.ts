/**
 * Restore chats from the automatic backup, on the phone (C46, 3.1.0).
 *
 * The desktop got this in 3.0.10 (lib/chat-rescue.ts, perrt 05.11.2026): when
 * the chat list loses chats, the native backup keeps the previous copy as an
 * archive (`backup_stores`, store_backup.chats-*.json), and
 * `chat_backup_conversations` hands back every chat the backup files hold.
 * Both run on the phone as they are. What the phone lacked was a way back:
 * the button on the backup page and the hint in the chat list use this module.
 *
 * One thing differs from the desktop. The archive keeps every chat that left
 * the list, also the ones the user deleted. A hint that offers "Delete all
 * chats" back at the next start is wrong, so the phone notes the chats that
 * leave the list while the app runs (`installDeletionNote`). Those are
 * deliberate: a chat that is lost the way perrt's were never leaves a running
 * list, it is missing when the store comes up. The noted ones are not offered
 * again, neither by the hint nor by the button; a backup file picked by hand
 * still brings them back.
 */
import { chatsMissingFrom, readBackupChats } from '../../lib/chat-rescue'
import { useChatStore } from '../../stores/chatStore'
import type { Conversation } from '../../types/chat'

/** The ids of chats that left the list while the app ran, newest last. */
export const DELETED_CHATS_KEY = 'lu-mobile-chats-deleted'
/** More would only grow the value: a chat deleted that long ago is no longer in the ring or the archives. */
export const DELETED_CHATS_MAX = 500

type Store = Pick<Storage, 'getItem' | 'setItem'> | null

function storage(): Store {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function readDeletedChats(store: Store = storage()): Set<string> {
  try {
    const list: unknown = JSON.parse(store?.getItem(DELETED_CHATS_KEY) ?? '[]')
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Notes the ids that left and forgets the ones that came back, keeping the newest DELETED_CHATS_MAX. */
export function noteChatsLeft(gone: readonly string[], back: readonly string[], store: Store = storage()): void {
  if (!store || (gone.length === 0 && back.length === 0)) return
  const returned = new Set(back)
  const list = [...readDeletedChats(store)].filter((id) => !returned.has(id) && !gone.includes(id))
  list.push(...gone.filter((id) => !returned.has(id)))
  try {
    store.setItem(DELETED_CHATS_KEY, JSON.stringify(list.slice(-DELETED_CHATS_MAX)))
  } catch {
    /* a full storage: the hint may offer a deleted chat once, the user dismisses it */
  }
}

/** Pure: the ids of `next` that `prev` did not have, and the other way round. */
export function chatIdsChanged(prev: readonly Conversation[], next: readonly Conversation[]): { gone: string[]; back: string[] } {
  // Every token of an answer makes a new list with the same chats in the same order: no sets for that.
  if (prev.length === next.length && prev.every((c, i) => c.id === next[i].id)) return { gone: [], back: [] }
  const before = new Set(prev.map((c) => c.id))
  const after = new Set(next.map((c) => c.id))
  return { gone: [...before].filter((id) => !after.has(id)), back: [...after].filter((id) => !before.has(id)) }
}

let deletionNoteInstalled = false
let stopDeletionNote: () => void = () => {}

/**
 * From the moment the chat store has hydrated, every chat that leaves the
 * list is noted as deleted on purpose. Before that the list is the empty
 * start value, and what hydration does not bring is exactly the loss this
 * module is for.
 */
export function installDeletionNote(): void {
  if (deletionNoteInstalled) return
  deletionNoteInstalled = true
  const start = () => {
    let prev = useChatStore.getState().conversations
    stopDeletionNote = useChatStore.subscribe((state) => {
      if (state.conversations === prev) return
      const { gone, back } = chatIdsChanged(prev, state.conversations)
      prev = state.conversations
      noteChatsLeft(gone, back)
    })
  }
  if (useChatStore.persist.hasHydrated()) start()
  else useChatStore.persist.onFinishHydration(() => start())
}

/** The chats the backup files hold that are not in the list and were not deleted here on purpose. */
export async function restorableChats(): Promise<Conversation[]> {
  const deleted = readDeletedChats()
  return chatsMissingFrom(useChatStore.getState().conversations, await readBackupChats()).filter((c) => !deleted.has(c.id))
}

/** Adds them to the list. Returns their ids, so the caller can wait until they are written. */
export async function restoreChatsFromPhoneBackup(): Promise<string[]> {
  const missing = await restorableChats()
  if (missing.length === 0) return []
  useChatStore.getState().importConversations(missing, 'merge')
  return missing.map((c) => c.id)
}

/** Only for tests. */
export function __resetDeletionNoteForTests(): void {
  stopDeletionNote()
  stopDeletionNote = () => {}
  deletionNoteInstalled = false
}
