/**
 * When the pinned plan leaves the chat, and where it stays.
 *
 * David, 14.11.2026: the plan stays pinned under the newest message while the
 * run works and after it ends, ticks and all. Once the user sends the next
 * message it leaves, and the space is free again. The transcript keeps it as a
 * folded "Plan" row under the answer it belonged to, so nothing is lost.
 *
 * Nothing is cleared to get there: the model's plan stays in the todo store,
 * because the loops read it back (resume anchor, open-plan check). "Retired"
 * is worked out from the transcript: a plan is retired once a visible user
 * message came AFTER its last update. A run that writes the plan again brings
 * it back, as a new pinned plan, and the old one goes to the archive first.
 */
import type { Message } from '../types/chat'
import { useChatStore } from '../stores/chatStore'
import { useTodoStore, type ArchivedPlan, type TodoItem } from '../stores/todoStore'

type Msg = Pick<Message, 'id' | 'role' | 'timestamp' | 'hidden'>

/**
 * The answer a plan that was last updated at `updatedAt` hangs under, once a
 * visible user message came after that update; null while it is still the
 * current plan. The answer is the last assistant message before that user
 * message (the one the plan was written in), or null when there is none.
 */
export function retiredAt(messages: readonly Msg[], updatedAt: number | undefined): { anchorId: string | null } | null {
  const since = updatedAt ?? 0
  const i = messages.findIndex((m) => m.role === 'user' && !m.hidden && m.timestamp > since)
  if (i < 0) return null
  for (let j = i - 1; j >= 0; j--) {
    if (messages[j].role === 'assistant' && !messages[j].hidden) return { anchorId: messages[j].id }
  }
  return { anchorId: null }
}

function messagesOf(conversationId: string): readonly Msg[] {
  return useChatStore.getState().conversations.find((c) => c.id === conversationId)?.messages ?? []
}

/** Is the plan of this chat still the pinned one. */
export function isPlanRetired(conversationId: string): boolean {
  const s = useTodoStore.getState()
  if (!s.byConversation[conversationId]?.length) return false
  return retiredAt(messagesOf(conversationId), s.updatedAt[conversationId]) !== null
}

/**
 * Called by todo_write before it writes: a retired plan goes to the archive
 * under its answer, so the new one does not overwrite it in the transcript.
 */
export function archiveRetiredPlan(conversationId: string): void {
  const s = useTodoStore.getState()
  const todos = s.byConversation[conversationId]
  if (!todos?.length) return
  const at = retiredAt(messagesOf(conversationId), s.updatedAt[conversationId])
  if (at?.anchorId) s.archivePlan(conversationId, at.anchorId, todos)
}

/**
 * The plans the transcript shows as folded rows: answer id -> plans under it.
 * The archive, plus the current plan once it is retired.
 */
export function planHistory(
  messages: readonly Msg[],
  todos: TodoItem[] | undefined,
  updatedAt: number | undefined,
  archived: ArchivedPlan[] | undefined,
): Map<string, TodoItem[][]> {
  const out = new Map<string, TodoItem[][]>()
  const add = (id: string, t: TodoItem[]) => out.set(id, [...(out.get(id) ?? []), t])
  for (const a of archived ?? []) add(a.anchorId, a.todos)
  if (todos?.length) {
    const at = retiredAt(messages, updatedAt)
    if (at?.anchorId) add(at.anchorId, todos)
  }
  return out
}
