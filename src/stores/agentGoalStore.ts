/**
 * The standing objective for a conversation (2.5.9, `/goal`).
 *
 * A slash command is normally one prompt expansion and then it is gone, which
 * is fine for `/commit` and useless for "here is what we are actually trying to
 * achieve". Long agent runs drift: the model fixes the thing in front of it and
 * forgets what the work was for. A goal is stored per conversation, injected
 * into the system prompt on EVERY later turn in both Code and Agent, and shown
 * above the composer so it is never a hidden instruction the user forgot about.
 *
 * Persisted, because the drift it exists to stop happens across sessions too.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

export interface AgentGoal {
  text: string
  setAt: number
}

interface AgentGoalState {
  goals: Record<string, AgentGoal>
  getGoal: (conversationId: string | null | undefined) => AgentGoal | null
  setGoal: (conversationId: string, text: string) => void
  clearGoal: (conversationId: string) => void
}

/** Keep a goal short enough to sit in every prompt without eating the budget. */
export const MAX_GOAL_LENGTH = 500

export const useAgentGoalStore = create<AgentGoalState>()(
  persist(
    (set, get) => ({
      goals: {},

      getGoal: (conversationId) => {
        if (!conversationId) return null
        return get().goals[conversationId] ?? null
      },

      setGoal: (conversationId, text) => {
        const trimmed = text.trim().slice(0, MAX_GOAL_LENGTH)
        if (!trimmed) return
        set((state) => ({
          goals: { ...state.goals, [conversationId]: { text: trimmed, setAt: Date.now() } },
        }))
      },

      clearGoal: (conversationId) =>
        set((state) => {
          if (!(conversationId in state.goals)) return state
          const next = { ...state.goals }
          delete next[conversationId]
          return { goals: next }
        }),
    }),
    {
      name: 'locally-uncensored-agent-goal',
      storage: safeJSONStorage(),
    },
  ),
)

/**
 * The section appended to the system prompt. Empty string when no goal is set,
 * so callers can concatenate unconditionally.
 *
 * Worded so the goal STEERS without overriding the current instruction: a user
 * who asks something off-goal still gets an answer, they just get told it is
 * off-goal rather than silently redirected.
 */
export function renderGoalSection(goal: AgentGoal | null): string {
  if (!goal?.text) return ''
  return (
    `\n\n## Standing goal\n` +
    `The user set this objective for this session:\n\n${goal.text}\n\n` +
    `Keep it in view. When a step moves toward it, say which part it moved. ` +
    `If the current request pulls away from it, do the request anyway and note the tension in one line. ` +
    `Do not announce the goal back to the user every turn.`
  )
}
