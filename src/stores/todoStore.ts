import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

/**
 * The plan a long run is working through, written by the model itself.
 *
 * On a task that takes twenty tool calls the transcript scrolls away and the
 * user is left guessing whether the agent is on step 2 or step 9, and whether
 * it still remembers what it set out to do. The audit filed this as C4: the
 * model had no way to state a plan and no way to show progress against it.
 *
 * The model owns the list through the `todo_write` tool and replaces it whole
 * on every call. Whole-list replacement rather than per-item patching is
 * deliberate: a small local model cannot be trusted to hold stable item ids
 * across twenty turns, and a half-applied patch would show a plan that never
 * existed.
 *
 * Keyed by conversation so the Code tab and every chat keep their own plan, and
 * persisted so closing the app mid-task does not lose it.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

interface TodoState {
  /** conversation id -> that run's plan */
  byConversation: Record<string, TodoItem[]>
  /** Wall-clock of the last write per conversation, for the "just updated" cue. */
  updatedAt: Record<string, number>

  setTodos: (conversationId: string, todos: TodoItem[]) => void
  getTodos: (conversationId: string | null | undefined) => TodoItem[]
  clearTodos: (conversationId: string) => void
}

/** Guards against a model that returns 40 steps or a novel per step. */
const MAX_ITEMS = 40
const MAX_CONTENT = 200

export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const entry of raw.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const content = typeof e.content === 'string' ? e.content.trim() : ''
    if (!content) continue
    // Anything unrecognised counts as not started: a typo must never mark work
    // done that was never done.
    const status: TodoStatus =
      e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending'
    out.push({ content: content.slice(0, MAX_CONTENT), status })
  }
  return out
}

export const useTodoStore = create<TodoState>()(
  persist(
    (set, get) => ({
      byConversation: {},
      updatedAt: {},

      setTodos: (conversationId, todos) =>
        set((s) => ({
          byConversation: { ...s.byConversation, [conversationId]: todos },
          updatedAt: { ...s.updatedAt, [conversationId]: Date.now() },
        })),

      getTodos: (conversationId) =>
        (conversationId && get().byConversation[conversationId]) || [],

      clearTodos: (conversationId) =>
        set((s) => {
          const byConversation = { ...s.byConversation }
          const updatedAt = { ...s.updatedAt }
          delete byConversation[conversationId]
          delete updatedAt[conversationId]
          return { byConversation, updatedAt }
        }),
    }),
    {
      name: 'locally-uncensored-todos',
      storage: safeJSONStorage(),
    },
  ),
)

/** Non-hook access for the tool executor, which runs outside React. */
export function writeTodos(conversationId: string, raw: unknown): TodoItem[] {
  const todos = normalizeTodos(raw)
  useTodoStore.getState().setTodos(conversationId, todos)
  return todos
}

/** One-line summary the tool hands back to the model, so it can see its own
 *  progress in the transcript without us replaying the whole list. */
export function summarizeTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Plan cleared.'
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  const lines = todos.map((t) => {
    const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'
    return `${mark} ${t.content}`
  })
  const head = `Plan updated (${done}/${todos.length} done${current ? `, now: ${current.content}` : ''}).`
  return `${head}\n${lines.join('\n')}`
}
