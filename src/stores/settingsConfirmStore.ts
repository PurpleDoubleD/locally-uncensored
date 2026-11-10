// The card in front of every change LU makes to itself from the chat (A11,
// grown in C60 / 3.1.0).
//
// Same promise bridge as codexConfirmStore: the tool awaits an answer, the
// store parks the resolver, the card in the tool call resolves it on click.
// Several requests wait in line, each with its own card. Stop or abort answers
// "no" and takes the card down, and so does a card nobody answers within
// CARD_TIMEOUT_MS (C60: silence is a no, as in Hermes' approvals.timeout).
// There is no "don't ask again": the card comes in Bypass too, Bypass is about
// files and the shell, not the app itself.
//
// Three kinds of card, all drawn by the app from this structured request,
// never from text the model wrote:
//  - one setting   (set_setting):  label, from → to, note
//  - several       (set_settings): one line per change, each one can be unticked
//  - an action     (lu_models, lu_service, lu_download): what happens, what it costs
// `risk: 'strong'` draws the red card (local API, phone remote, downloads by link).

import { create } from 'zustand'

/** Unanswered for this long counts as "no". */
export const CARD_TIMEOUT_MS = 10 * 60 * 1000

export interface SettingChangeItem {
  key: string
  label: string
  from: string
  to: string
  /** A side note, e.g. "applies on the next engine start". */
  note?: string
}

export interface SettingChangeRequest {
  id: string
  /** The tool call that waits; its card shows the question. */
  toolCallId?: string
  conversationId: string | null
  /** One setting: key, label, from, to (and note). */
  key: string
  label: string
  from: string
  to: string
  /** A side note for the card, e.g. "applies on the next engine start". */
  note?: string
  /** Several settings on one card (set_settings). When set, key/label/from/to
   *  only name the first one. */
  items?: SettingChangeItem[]
  /** An action instead of a value: the title says what happens, details what
   *  it costs or touches. */
  action?: { title: string; details: string[] }
  /** Red card: no default button, one sentence about the risk. */
  risk?: 'card' | 'strong'
  riskNote?: string
  /** The run read foreign content (a web page, a file, a tool's output)
   *  before this request: the card says so and names it. */
  taintedBy?: string
}

export interface SettingChangeAnswer {
  allow: boolean
  /** For several items: the keys still ticked. */
  selected?: string[]
  /** 'timeout' when nobody answered, 'abort' on Stop. */
  reason?: 'clicked' | 'timeout' | 'abort'
}

interface Waiting {
  req: SettingChangeRequest
  resolve: (a: SettingChangeAnswer) => void
}

interface SettingsConfirmState {
  queue: Waiting[]
  /** One yes or no. */
  ask: (req: SettingChangeRequest, signal?: AbortSignal) => Promise<boolean>
  /** The full answer, with the ticked items and why it ended. */
  askFull: (req: SettingChangeRequest, signal?: AbortSignal) => Promise<SettingChangeAnswer>
  answer: (id: string, allow: boolean, selected?: string[]) => void
}

export const useSettingsConfirmStore = create<SettingsConfirmState>((set, get) => {
  const askFull = (req: SettingChangeRequest, signal?: AbortSignal) =>
    new Promise<SettingChangeAnswer>((resolve) => {
      if (signal?.aborted) {
        resolve({ allow: false, reason: 'abort' })
        return
      }
      // Read only after the timer below exists: finish runs on a click, a
      // timeout or an abort, never while this function is still running.
      const finish = (a: SettingChangeAnswer) => {
        clearTimeout(timer)
        resolve(a)
      }
      const entry: Waiting = { req, resolve: finish }
      set({ queue: [...get().queue, entry] })
      const drop = (reason: 'timeout' | 'abort') => {
        if (!get().queue.includes(entry)) return
        set({ queue: get().queue.filter((w) => w !== entry) })
        finish({ allow: false, reason })
      }
      const timer = setTimeout(() => drop('timeout'), CARD_TIMEOUT_MS)
      signal?.addEventListener('abort', () => drop('abort'), { once: true })
    })

  return {
    queue: [],
    askFull,
    ask: async (req, signal) => (await askFull(req, signal)).allow,
    answer: (id, allow, selected) => {
      const entry = get().queue.find((w) => w.req.id === id)
      if (!entry) return
      set({ queue: get().queue.filter((w) => w !== entry) })
      entry.resolve({ allow, selected, reason: 'clicked' })
    },
  }
})

/** The request a tool call's card shows: its own by id, else the oldest one
 *  that names no call (a surface that does not thread the call id). */
export function pendingForCall(
  queue: readonly { req: SettingChangeRequest }[],
  toolCallId: string,
): SettingChangeRequest | null {
  return (queue.find((w) => w.req.toolCallId === toolCallId) ?? queue.find((w) => !w.req.toolCallId))?.req ?? null
}
