/**
 * The hint in the chat list (C46, 3.1.0): the automatic backup holds chats
 * the list does not. Same rule as the desktop (lib/chat-rescue.ts,
 * shouldShowRescueHint): more chats in the backup than in the list, or an
 * empty list, and one among them the hint was not dismissed for (A26). It only says so; the chats
 * come back when the user taps Restore.
 *
 * Asked once per start, after the restore at the start has decided (it may
 * reload the page), because it reads every backup file natively.
 */
import { create } from 'zustand'
import { isTauri } from '../../../../../api/backend'
import { decideRescueHint, rememberDismissed } from '../../../../../lib/chat-rescue'
import { useChatStore } from '../../../../../stores/chatStore'
import { restoreDecided } from '../../../../boot/restore'
import { restorableChats, restoreChatsFromPhoneBackup } from '../../../../lib/chat-rescue'
import { chatsAreWritten } from '../../../settings/parts/durable'

/** After the first page is up and the backup loop had its first turn. */
export const LOOK_AFTER_MS = 1500

export type RescueOutcome = 'restored' | 'not-saved' | 'failed'

interface RescueHintState {
  /** Chats the hint offers. 0: no hint. */
  count: number
  /** Their ids, for a dismissal that lasts (A26). */
  ids: string[]
  busy: boolean
}

export const useRescueHint = create<RescueHintState>(() => ({ count: 0, ids: [], busy: false }))

function local(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

let looked: Promise<void> | null = null

/** Looks once per start. Later calls return the same look. */
export function lookForRescue(wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  looked ??= (async () => {
    await restoreDecided
    await new Promise<void>((resolve) => {
      if (useChatStore.persist.hasHydrated()) resolve()
      else useChatStore.persist.onFinishHydration(() => resolve())
    })
    await wait(LOOK_AFTER_MS)
    const ids = (await restorableChats()).map((c) => c.id)
    if (decideRescueHint(useChatStore.getState().conversations.length, ids, local())) useRescueHint.setState({ count: ids.length, ids })
  })().catch(() => {
    /* no hint is the behaviour before C46 */
  })
  return looked
}

/** Restore from the hint. "Restored" only once the chats are in the storage of the phone. */
export async function restoreFromHint(): Promise<{ outcome: RescueOutcome; added: number }> {
  useRescueHint.setState({ busy: true })
  try {
    const ids = await restoreChatsFromPhoneBackup()
    const written = ids.length === 0 || (await chatsAreWritten({ present: ids }))
    useRescueHint.setState({ count: 0, ids: [] })
    return { outcome: written ? 'restored' : 'not-saved', added: ids.length }
  } catch {
    return { outcome: 'failed', added: 0 }
  } finally {
    useRescueHint.setState({ busy: false })
  }
}

/** "Not now": the hint comes back only for a chat that goes missing after this (A26). */
export function dismissRescueHint(): void {
  rememberDismissed(local(), useRescueHint.getState().ids)
  useRescueHint.setState({ count: 0, ids: [] })
}

/** Only for tests. */
export function __resetRescueHintForTests(): void {
  looked = null
  useRescueHint.setState({ count: 0, ids: [], busy: false })
}
