/**
 * Restore chats from backup (3.0.10).
 *
 * perrt, Discord 05.11.2026, on 3.0.8: every chat gone, the memories still
 * there. The IndexedDB row of the chat store came back empty, the native
 * backup kept the chats while the key was missing, and then the store wrote a
 * fresh list that replaced them in store_backup.json. The older copies were
 * still on disk (the ring store_backup.1-3.json, store_backup.prev.json, and
 * since 3.0.10 the chat archives store_backup.chats-*.json), but nothing in
 * the app ever read them again.
 *
 * `chat_backup_conversations` reads every one of those files natively and
 * hands back one list, one entry per chat id. This module only decides which
 * of them the live store does not have, and adds exactly those through
 * importConversations('merge'). A chat that is still here is never touched, so
 * running it twice adds nothing the second time.
 *
 * Nothing here runs by itself. The launch hint only counts; the chats come
 * back when the user presses the button (Settings, or the hint).
 */
import { backendCall, isTauri } from '../api/backend'
import { readDeletedChats } from './chat-deletions'
import { log } from './logger'
import type { Conversation } from '../types/chat'

/** The chats of the backup list that the live store has no chat with that id for. */
export function chatsMissingFrom(live: readonly Conversation[], backup: readonly unknown[]): Conversation[] {
  const have = new Set(live.map((c) => c.id))
  const seen = new Set<string>()
  const out: Conversation[] = []
  for (const entry of backup) {
    if (!entry || typeof entry !== 'object') continue
    const c = entry as Partial<Conversation>
    if (typeof c.id !== 'string' || !c.id || !Array.isArray(c.messages)) continue
    if (have.has(c.id) || seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c as Conversation)
  }
  return out
}

/**
 * What the restore offers: the chats the store does not have, without the ones
 * deleted on purpose (lib/chat-deletions.ts). A chat lost at the start was never
 * noted, so it stays on offer; a backup file picked by hand does not go through here.
 */
export function offeredChats(live: readonly Conversation[], backup: readonly unknown[], deleted: ReadonlySet<string> = readDeletedChats()): Conversation[] {
  return chatsMissingFrom(live, backup).filter((c) => !deleted.has(c.id))
}

/** Every chat the backup files hold, as one list. Empty outside the desktop app. */
export async function readBackupChats(): Promise<unknown[]> {
  if (!isTauri()) return []
  const raw = await backendCall<string>('chat_backup_conversations')
  const list: unknown = raw ? JSON.parse(raw) : []
  return Array.isArray(list) ? list : []
}

/** How many chats the backups hold that the store does not and that were not deleted on purpose. */
export async function countRestorableChats(live: () => readonly Conversation[]): Promise<number> {
  return (await restorableChatIds(live)).length
}

/** The ids of those chats, for the launch hint (A26). */
export async function restorableChatIds(live: () => readonly Conversation[]): Promise<string[]> {
  return offeredChats(live(), await readBackupChats()).map((c) => c.id)
}

/**
 * Put every chat back that the backups have and the store does not.
 * Returns how many came back.
 */
export async function restoreChatsFromBackup(
  live: () => readonly Conversation[],
  importConversations: (chats: Conversation[], mode: 'merge') => { added: number; skipped: number },
): Promise<number> {
  const missing = offeredChats(live(), await readBackupChats())
  if (missing.length === 0) return 0
  const { added } = importConversations(missing, 'merge')
  log.warn('[chat-rescue] chats restored from the backup files', { count: added })
  return added
}

// ── The hint at launch ───────────────────────────────────────────────────

/**
 * What the user dismissed the hint for. Since A26 (3.1.0) a JSON list of the
 * chat ids it offered then; up to 3.0.10 a bare count.
 */
export const RESCUE_HINT_DISMISSED_KEY = 'lu-chat-rescue-hint-dismissed'
/** Like DELETED_CHATS_MAX: a chat older than that is out of every backup file. */
export const RESCUE_HINT_DISMISSED_MAX = 500

/**
 * A dismissal as stored. `ids` since A26; `legacyCount` is the 3.0.10 value,
 * which only said how many chats were on offer when the user said no.
 */
export interface RescueDismissal {
  ids: ReadonlySet<string>
  legacyCount: number | null
}

/**
 * Whether the launch hint should show. The task asks for "the chat list is
 * empty", and perrt's case shows that is too narrow: by the time he looked he
 * had started a new chat. So: the backups hold more chats than the store, and
 * among them is one the user has not dismissed the hint for yet.
 *
 * A26 (3.1.0, LU-Admin): up to 3.0.10 the dismissal kept only the count, and
 * every chat deleted afterwards made the count larger and brought the hint
 * back at the next start. Deleted chats are left out of `offered` since C46;
 * the dismissal now holds the ids, so it lasts until a chat goes missing that
 * the user has not seen in the hint.
 *
 * A 3.0.10 dismissal (a count, no ids) still counts as one here; the launch
 * turns it into ids once (decideRescueHint).
 */
export function shouldShowRescueHint(liveCount: number, offered: readonly string[], dismissed: RescueDismissal): boolean {
  if (offered.length === 0) return false
  if (dismissed.legacyCount !== null && offered.length <= dismissed.legacyCount) return false
  if (offered.every((id) => dismissed.ids.has(id))) return false
  return liveCount === 0 || offered.length > liveCount
}

export function readDismissal(storage: Pick<Storage, 'getItem'> | null): RescueDismissal {
  try {
    const raw = storage?.getItem(RESCUE_HINT_DISMISSED_KEY)
    if (raw == null) return { ids: new Set(), legacyCount: null }
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) return { ids: new Set(value.filter((v): v is string => typeof v === 'string')), legacyCount: null }
    if (typeof value === 'number' && Number.isFinite(value)) return { ids: new Set(), legacyCount: value }
  } catch { /* unreadable: as if never dismissed */ }
  return { ids: new Set(), legacyCount: null }
}

/** Remember that the hint was dismissed for these chats, on top of the ones before. */
export function rememberDismissed(storage: Pick<Storage, 'getItem' | 'setItem'> | null, offered: readonly string[]): void {
  try {
    const before = readDismissal(storage).ids
    const add = new Set(offered)
    const list = [...before].filter((id) => !add.has(id)).concat(offered)
    storage?.setItem(RESCUE_HINT_DISMISSED_KEY, JSON.stringify(list.slice(-RESCUE_HINT_DISMISSED_MAX)))
  } catch { /* a hint that comes back is harmless */ }
}

/**
 * The launch decision in one place: whether the hint shows for these chats.
 * A 3.0.10 dismissal is turned into ids right here, once: the chats on offer
 * at the first start after the update count as dismissed, unless the chat
 * list is empty. A chat that goes missing from then on is new against it.
 */
export function decideRescueHint(
  liveCount: number,
  offered: readonly string[],
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
): boolean {
  const dismissed = readDismissal(storage)
  if (dismissed.legacyCount === null) return shouldShowRescueHint(liveCount, offered, dismissed)
  try { storage?.setItem(RESCUE_HINT_DISMISSED_KEY, '[]') } catch { /* see rememberDismissed */ }
  // An empty chat list is the loss the hint is for (perrt): it shows, whatever was dismissed under 3.0.10.
  if (liveCount === 0) return shouldShowRescueHint(liveCount, offered, readDismissal(storage))
  // Everything on offer now was there when the user said no under 3.0.10, or
  // was deleted under 3.0.10 since, which nothing noted then (the nag A26 is about).
  rememberDismissed(storage, offered)
  return false
}

// ── Clear backup, open folder (A26) ──────────────────────────────────────

/**
 * Take every chat out of the backup files that is not in the chat list now.
 * Returns how many left. They cannot be restored afterwards; the chat list
 * itself and every other store in the files stay as they are.
 */
export async function clearChatBackup(live: () => readonly Conversation[]): Promise<number> {
  if (!isTauri()) return 0
  const keep = live().map((c) => c.id)
  const removed = await backendCall<number>('chat_backup_clear', { keep })
  log.warn('[chat-rescue] chats cleared from the backup files', { count: removed })
  return removed
}

/** Show the backup folder in Finder, Explorer or the file manager. */
export async function revealChatBackup(): Promise<void> {
  if (!isTauri()) return
  await backendCall<string>('chat_backup_reveal')
}
