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
 * Chats deleted on purpose are not offered back, here and on the desktop alike
 * (lib/chat-deletions.ts): the archive keeps them, and "Delete all chats" must
 * not return as a hint at the next start. A backup file picked by hand still
 * brings them back.
 */
import { offeredChats, readBackupChats } from '../../lib/chat-rescue'
import { useChatStore } from '../../stores/chatStore'
import type { Conversation } from '../../types/chat'

// The note itself is shared with the desktop (lib/chat-deletions.ts, lib/chat-deletion-note.ts).
export { DELETED_CHATS_KEY, DELETED_CHATS_MAX, chatIdsChanged, noteChatsLeft, readDeletedChats } from '../../lib/chat-deletions'
export { __resetDeletionNoteForTests, installDeletionNote } from '../../lib/chat-deletion-note'

/** The chats the backup files hold that are not in the list and were not deleted here on purpose. */
export async function restorableChats(): Promise<Conversation[]> {
  return offeredChats(useChatStore.getState().conversations, await readBackupChats())
}

/** Adds them to the list. Returns their ids, so the caller can wait until they are written. */
export async function restoreChatsFromPhoneBackup(): Promise<string[]> {
  const missing = await restorableChats()
  if (missing.length === 0) return []
  useChatStore.getState().importConversations(missing, 'merge')
  return missing.map((c) => c.id)
}
