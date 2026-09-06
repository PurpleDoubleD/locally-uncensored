/**
 * The projection the chat sidebar's list actually paints, split out of
 * Sidebar.tsx so the pure part is testable (and so the component file keeps
 * exporting only its component).
 *
 * Why a projection at all: `chatStore.conversations` is REPLACED on every
 * streaming flush, so any component subscribed to the array re-renders once
 * per animation frame for the whole duration of an answer. A row paints four
 * things, none of which move per token — subscribing to those instead lets the
 * store selector hand back the identical array and React skip the render.
 */
import { formatDate } from '../../lib/formatters'
import type { Conversation } from '../../types/chat'

export interface SidebarRow {
  id: string
  title: string
  mode: string
  /** The FORMATTED date, not `updatedAt`. The raw timestamp is rewritten on
   *  every token; "Just now" is not. */
  date: string
}

export function toSidebarRow(c: Conversation): SidebarRow {
  return { id: c.id, title: c.title, mode: c.mode || 'lu', date: formatDate(c.updatedAt) }
}

/** Field-wise equality over two projections. The store selector returns the
 *  previous array whenever this holds, which is what stops the re-render. */
export function sameSidebarRows(a: readonly SidebarRow[], b: readonly SidebarRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x.id !== y.id || x.title !== y.title || x.mode !== y.mode || x.date !== y.date) return false
  }
  return true
}

/** Case-folded substring match over a conversation's title and message bodies.
 *  The needle arrives ALREADY lowercased and trimmed: lowercasing it per
 *  conversation (or worse, per message, as the old inline filter did) is the
 *  work this whole path exists to avoid. */
export function conversationMatches(c: Conversation, needle: string): boolean {
  if (c.title.toLowerCase().includes(needle)) return true
  return c.messages.some((m) => m.content.toLowerCase().includes(needle))
}
