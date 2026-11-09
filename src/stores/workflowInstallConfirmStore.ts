// The card in front of every workflow install and assignment from the chat
// (C60-S5). Same promise bridge as settingsConfirmStore: the tool awaits a
// boolean, the card in the tool call answers it. Stop or abort answers no,
// and so does a card left alone for ten minutes. There is no "always allow",
// also not in Bypass.

import { create } from 'zustand'
import type { InspectReport } from '../lib/workflow-inspect'

export const CARD_TIMEOUT_MS = 10 * 60 * 1000

export interface WorkflowCardRequest {
  id: string
  toolCallId?: string
  conversationId: string | null
  kind: 'install' | 'assign'
  title: string
  /** Yellow: the strong card. No button is the default, Enter does nothing. */
  strong: boolean
  report?: InspectReport
  /** For an assignment: the workflow and model, and what the model had before. */
  assign?: { workflow: string; model: string; before?: string }
  /** Foreign content was read earlier in this run (taint), with its source. */
  foreign?: string
}

interface Waiting {
  req: WorkflowCardRequest
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface State {
  queue: Waiting[]
  ask: (req: WorkflowCardRequest, signal?: AbortSignal, timeoutMs?: number) => Promise<boolean>
  answer: (id: string, allow: boolean) => void
}

export const useWorkflowCardStore = create<State>((set, get) => ({
  queue: [],

  ask: (req, signal, timeoutMs = CARD_TIMEOUT_MS) =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        resolve(false)
        return
      }
      const drop = () => {
        const entry = get().queue.find((w) => w.req.id === req.id)
        if (!entry) return
        clearTimeout(entry.timer)
        set({ queue: get().queue.filter((w) => w !== entry) })
        resolve(false)
      }
      const timer = setTimeout(drop, timeoutMs)
      set({ queue: [...get().queue, { req, resolve, timer }] })
      signal?.addEventListener('abort', drop, { once: true })
    }),

  answer: (id, allow) => {
    const entry = get().queue.find((w) => w.req.id === id)
    if (!entry) return
    clearTimeout(entry.timer)
    set({ queue: get().queue.filter((w) => w !== entry) })
    entry.resolve(allow)
  },
}))

export function workflowCardForCall(queue: readonly { req: WorkflowCardRequest }[], toolCallId: string): WorkflowCardRequest | null {
  return (queue.find((w) => w.req.toolCallId === toolCallId) ?? queue.find((w) => !w.req.toolCallId))?.req ?? null
}
