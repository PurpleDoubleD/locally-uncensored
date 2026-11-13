import { create } from 'zustand'
import { breakdownOf, type BreakdownMessage, type ContextBreakdown } from '../lib/context-breakdown'
import { useChatStore } from './chatStore'

/**
 * What the last agent step of a conversation sent, split by kind (U5).
 *
 * The context dropdown reads it to show what fills the window. Same life as
 * sendSizeStore: it describes the run in front of the user, so it is not
 * persisted.
 */
interface ContextBreakdownState {
  byConv: Record<string, ContextBreakdown>
  publish: (convId: string, breakdown: ContextBreakdown) => void
  clear: (convId: string) => void
}

export const useContextBreakdownStore = create<ContextBreakdownState>((set) => ({
  byConv: {},
  publish: (convId, breakdown) =>
    set((state) => ({ byConv: { ...state.byConv, [convId]: breakdown } })),
  clear: (convId) =>
    set((state) => {
      if (!(convId in state.byConv)) return state
      const next = { ...state.byConv }
      delete next[convId]
      return { byConv: next }
    }),
}))

/**
 * The one call the agent loops make per step, once the request and its tool
 * catalogue are final:
 *
 *   publishStepBreakdown(convId, sendMessages, tools)
 *
 * `tools` may be the catalogue itself or its token estimate, when the loop
 * already has it. Never throws: a meter must not break a run.
 */
export function publishStepBreakdown(
  convId: string | null | undefined,
  messages: readonly BreakdownMessage[],
  tools: readonly unknown[] | number,
): void {
  if (!convId) return
  try {
    const atMessageCount =
      useChatStore.getState().conversations.find((c) => c.id === convId)?.messages.length ?? 0
    useContextBreakdownStore.getState().publish(
      convId,
      breakdownOf(messages, tools, { kind: 'step', atMessageCount }),
    )
  } catch {
    // The dropdown falls back to the estimate.
  }
}
