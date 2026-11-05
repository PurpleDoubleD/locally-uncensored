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

/** Every chat the backup files hold, as one list. Empty outside the desktop app. */
export async function readBackupChats(): Promise<unknown[]> {
  if (!isTauri()) return []
  const raw = await backendCall<string>('chat_backup_conversations')
  const list: unknown = raw ? JSON.parse(raw) : []
  return Array.isArray(list) ? list : []
}

/** How many chats the backups hold that the store does not. */
export async function countRestorableChats(live: () => readonly Conversation[]): Promise<number> {
  return chatsMissingFrom(live(), await readBackupChats()).length
}

/**
 * Put every chat back that the backups have and the store does not.
 * Returns how many came back.
 */
export async function restoreChatsFromBackup(
  live: () => readonly Conversation[],
  importConversations: (chats: Conversation[], mode: 'merge') => { added: number; skipped: number },
): Promise<number> {
  const missing = chatsMissingFrom(live(), await readBackupChats())
  if (missing.length === 0) return 0
  const { added } = importConversations(missing, 'merge')
  log.warn('[chat-rescue] chats restored from the backup files', { count: added })
  return added
}

// ── The hint at launch ───────────────────────────────────────────────────

/** The count the user last dismissed the hint at. The hint comes back only for more. */
export const RESCUE_HINT_DISMISSED_KEY = 'lu-chat-rescue-hint-dismissed'

/**
 * Whether the launch hint should show. The task asks for "the chat list is
 * empty", and perrt's case shows that is too narrow: by the time he looked he
 * had started a new chat. So: the backups hold more chats than the store, and
 * the user has not dismissed the hint at this count or a higher one. Someone
 * who deleted most of their chats on purpose sees it once and dismisses it.
 */
export function shouldShowRescueHint(liveCount: number, restorable: number, dismissedAt: number | null): boolean {
  if (restorable <= 0) return false
  if (dismissedAt !== null && restorable <= dismissedAt) return false
  return liveCount === 0 || restorable > liveCount
}

export function readDismissedAt(storage: Pick<Storage, 'getItem'> | null): number | null {
  try {
    const raw = storage?.getItem(RESCUE_HINT_DISMISSED_KEY)
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function rememberDismissed(storage: Pick<Storage, 'setItem'> | null, count: number): void {
  try { storage?.setItem(RESCUE_HINT_DISMISSED_KEY, String(count)) } catch { /* a hint that comes back is harmless */ }
}
