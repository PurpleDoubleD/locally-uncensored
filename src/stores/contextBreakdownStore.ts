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
  /** W48 (GitHub #257): the system prompt the last request of a
   *  conversation carried, exactly as it went on the wire, and when. */
  systemByConv: Record<string, SentSystemPrompt>
  publish: (convId: string, breakdown: ContextBreakdown) => void
  noteSystem: (convId: string, sent: SentSystemPrompt) => void
  clear: (convId: string) => void
}

export interface SentSystemPrompt {
  text: string
  at: number
}

export const useContextBreakdownStore = create<ContextBreakdownState>((set) => ({
  byConv: {},
  systemByConv: {},
  publish: (convId, breakdown) =>
    set((state) => ({ byConv: { ...state.byConv, [convId]: breakdown } })),
  noteSystem: (convId, sent) =>
    set((state) => ({ systemByConv: { ...state.systemByConv, [convId]: sent } })),
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
  noteSentSystemPrompt(convId, messages)
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

/**
 * W48 (GitHub #257, mirh: "you don't seem to be able to see the final system
 * prompt anywhere"): remember the system prompt a request carried, the
 * system messages as they went on the wire, joined. Plain chat calls this
 * right before it sends; the agent loops reach it through
 * publishStepBreakdown. The context list shows it under "System prompt".
 * Never throws, like the meter.
 */
export function noteSentSystemPrompt(
  convId: string | null | undefined,
  messages: readonly BreakdownMessage[],
): void {
  if (!convId) return
  try {
    const text = sentSystemText(messages)
    useContextBreakdownStore.getState().noteSystem(convId, { text, at: Date.now() })
  } catch {
    // A missing preview must not break a send.
  }
}

/** The system messages of a request, in order, as one text. */
export function sentSystemText(messages: readonly BreakdownMessage[]): string {
  return messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n\n')
}
