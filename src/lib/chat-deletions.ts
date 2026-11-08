/**
 * Chats deleted on purpose, so the restore from the backup does not offer them
 * back (C46, 3.1.0; phone and desktop alike).
 *
 * Since 3.0.10 the native backup keeps every chat that leaves the list in a
 * chat archive (backup_stores, store_backup.chats-*.json). That is what saves
 * a lost chat list (perrt, 05.11.2026), and it keeps a deleted chat the same
 * way: without this note the restore hint offered "Delete all chats" back at
 * the next start.
 *
 * Deleted means: it left the list while the app ran, after the chat store had
 * hydrated (lib/chat-deletion-note.ts watches for that). A chat that is lost
 * the way perrt's were never leaves a running list, it is missing when the
 * store comes up, so it is never noted and stays on offer.
 *
 * Pure apart from the storage it is handed; no store imports, so the restore
 * module and its tests stay light.
 */
import type { Conversation } from '../types/chat'

/** The ids of chats deleted on purpose, newest last. In the native backup (lib/store-backup.ts STORE_KEYS). */
export const DELETED_CHATS_KEY = 'lu-chats-deleted'
/** More would only grow the value: a chat deleted that long ago is no longer in the ring or the archives. */
export const DELETED_CHATS_MAX = 500

export type DeletionStorage = Pick<Storage, 'getItem' | 'setItem'> | null

export function defaultDeletionStorage(): DeletionStorage {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function readDeletedChats(store: DeletionStorage = defaultDeletionStorage()): Set<string> {
  try {
    const list: unknown = JSON.parse(store?.getItem(DELETED_CHATS_KEY) ?? '[]')
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Notes the ids that left and forgets the ones that came back, keeping the newest DELETED_CHATS_MAX. */
export function noteChatsLeft(gone: readonly string[], back: readonly string[], store: DeletionStorage = defaultDeletionStorage()): void {
  if (!store || (gone.length === 0 && back.length === 0)) return
  const returned = new Set(back)
  const left = new Set(gone)
  const list = [...readDeletedChats(store)].filter((id) => !returned.has(id) && !left.has(id))
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
