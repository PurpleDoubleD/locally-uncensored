// The card in front of a web address the model made up (P-L, 3.1.0).
//
// Same promise bridge as settingsConfirmStore: the web tool awaits a boolean,
// the store parks the resolver, the card in the tool call resolves it on
// click. Stop or abort answers "no" and takes the card down.

import { create } from 'zustand'

export interface WebUrlRequest {
  id: string
  /** The tool call that waits; its card shows the question. */
  toolCallId?: string
  conversationId: string | null
  tool: string
  url: string
  /** Why it is asked, one sentence for the card. */
  reason: string
}

interface Waiting {
  req: WebUrlRequest
  resolve: (allow: boolean) => void
}

interface WebUrlConfirmState {
  queue: Waiting[]
  ask: (req: WebUrlRequest, signal?: AbortSignal) => Promise<boolean>
  answer: (id: string, allow: boolean) => void
}

export const useWebUrlConfirmStore = create<WebUrlConfirmState>((set, get) => ({
  queue: [],

  ask: (req, signal) =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        resolve(false)
        return
      }
      const entry: Waiting = { req, resolve }
      set({ queue: [...get().queue, entry] })
      signal?.addEventListener(
        'abort',
        () => {
          if (!get().queue.includes(entry)) return
          set({ queue: get().queue.filter((w) => w !== entry) })
          resolve(false)
        },
        { once: true },
      )
    }),

  answer: (id, allow) => {
    const entry = get().queue.find((w) => w.req.id === id)
    if (!entry) return
    set({ queue: get().queue.filter((w) => w !== entry) })
    entry.resolve(allow)
  },
}))

/** The request a tool call's card shows: its own by id, else the oldest one
 *  that names no call. */
export function pendingUrlForCall(queue: readonly { req: WebUrlRequest }[], toolCallId: string): WebUrlRequest | null {
  return (queue.find((w) => w.req.toolCallId === toolCallId) ?? queue.find((w) => !w.req.toolCallId))?.req ?? null
}
