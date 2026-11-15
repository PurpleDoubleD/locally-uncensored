import { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { isTauri } from '../../api/backend'
import {
  restorableChatIds, restoreChatsFromBackup, decideRescueHint, rememberDismissed,
} from '../../lib/chat-rescue'
import { installDeletionNote } from '../../lib/chat-deletion-note'

/** After the restore at launch has had its turn (it may reload the window). */
const LOOK_AFTER_MS = 4000

/**
 * The hint at launch (3.0.10): the backup files hold chats the chat list does
 * not. It only says so; the chats come back when the user presses Restore.
 * See lib/chat-rescue.ts for when it shows.
 */
export function ChatRescueHint() {
  const importConversations = useChatStore((s) => s.importConversations)
  // A chat that leaves the list from here on was deleted on purpose: the restore does not offer it back (C46).
  // The shell mounts this once for the whole session.
  useEffect(() => { installDeletionNote() }, [])
  const [offered, setOffered] = useState<string[]>([])
  const count = offered.length
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let gone = false
    const look = async () => {
      await new Promise<void>((resolve) => {
        if (useChatStore.persist.hasHydrated()) resolve()
        else useChatStore.persist.onFinishHydration(() => resolve())
      })
      await new Promise((r) => setTimeout(r, LOOK_AFTER_MS))
      if (gone) return
      const live = () => useChatStore.getState().conversations
      const ids = await restorableChatIds(live)
      const storage = typeof localStorage !== 'undefined' ? localStorage : null
      if (!gone && decideRescueHint(live().length, ids, storage)) setOffered(ids)
    }
    look().catch(() => { /* no hint is the old behaviour */ })
    return () => { gone = true }
  }, [])

  if (count === 0 && !done) return null

  const dismiss = () => {
    // A26: for these chats, until one goes missing that was not among them.
    rememberDismissed(typeof localStorage !== 'undefined' ? localStorage : null, offered)
    setOffered([])
    setDone(null)
  }

  const restore = async () => {
    setBusy(true)
    try {
      const added = await restoreChatsFromBackup(() => useChatStore.getState().conversations, importConversations)
      setOffered([])
      setDone(`Restored ${added} chat${added === 1 ? '' : 's'} from the backup.`)
    } catch (err) {
      setDone(err instanceof Error ? err.message : 'Could not read the backup.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="chat-rescue-hint" className="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-gray-300 dark:border-white/10 bg-white dark:bg-white/[0.04] px-3 py-2">
      <p role="status" className="flex-1 t-micro leading-snug text-gray-700 dark:text-gray-200">
        {done ?? `Your backup holds ${count} chat${count === 1 ? '' : 's'} that ${count === 1 ? 'is' : 'are'} not in your chat list. Restore ${count === 1 ? 'it' : 'them'}? Chats that are here stay as they are.`}
      </p>
      {!done && (
        <button
          onClick={() => void restore()}
          disabled={busy}
          className="shrink-0 t-micro font-medium text-gray-900 dark:text-white hover:underline disabled:opacity-50"
        >
          {busy ? 'Restoring...' : 'Restore'}
        </button>
      )}
      <button
        onClick={dismiss}
        className="shrink-0 t-micro text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
      >
        {done ? 'Close' : 'Dismiss'}
      </button>
    </div>
  )
}
