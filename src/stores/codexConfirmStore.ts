// The coding agent's "may I run this" gate, as app UI instead of window.confirm.
//
// It used to be a raw `window.confirm`, which in the Tauri webview renders as an
// OS dialog: system chrome, the app origin in the title bar, the whole prompt as
// one wall of text, and no way to say "stop asking". 2026-07-24, on
// seeing it fire for the first time: "der dialog ist ja hässlich wie sau".
//
// A promise-bridge is what lets the same awaitApproval contract keep working:
// useCodex still awaits a boolean, the store parks the resolver, the dialog
// resolves it on click.

import { create } from 'zustand'

export interface CodexConfirmRequest {
  /** shell_execute / code_execute / shell_execute_background */
  toolName: string
  /**
   * EVERYTHING that shapes the process, rendered for a human — not just
   * `args.command`.
   *
   * It used to be the command alone, while the tool description sends the model
   * to `stdin` for anything multi-line. The card then read `python3 -` and the
   * script that is the actual code execution never appeared, so the one human
   * checkpoint in front of arbitrary local code showed the starter instead of
   * the payload. Built by renderApprovalPreview (hooks/codexShellGate).
   */
  command: string
  /** The raw args behind that preview, so a richer card can render them without
   *  re-parsing text, and so a test can assert what was offered for approval. */
  args?: Record<string, unknown>
  /** True when the CLOUD arm is the only reason we are asking, which changes
   *  both the hint we show and which setting "don't ask again" turns off. */
  cloudReason: boolean
  /** The chat that asks, when known: a shared chat forwards the question to
   *  the paired phone (lib/remote-chats-bridge). */
  conversationId?: string
  /** Where an "always allow here" rule would be kept (stores/commandRulesStore):
   *  the run's folder, or this chat's own sandbox. Absent: no such button. */
  ruleScope?: string
}

interface Waiting {
  req: CodexConfirmRequest
  resolve: (allow: boolean) => void
}

interface CodexConfirmState {
  /** The request on the card: the oldest one still waiting. */
  pending: CodexConfirmRequest | null
  /** Resolver of that request. Null when nothing is pending. */
  resolve: ((allow: boolean) => void) | null
  /** Every request waiting for an answer, oldest first. */
  queue: Waiting[]
  ask: (req: CodexConfirmRequest, signal?: AbortSignal) => Promise<boolean>
  answer: (allow: boolean) => void
  /** Answer one request wherever it waits (the phone). False when it no
   *  longer waits. */
  answerRequest: (req: CodexConfirmRequest, allow: boolean) => boolean
}

/** Who answered, with what (shared chats forward it to the phone,
 *  lib/remote-chats-bridge). */
type CodexAnswerListener = (req: CodexConfirmRequest, allow: boolean, by: 'desktop' | 'phone') => void
const codexAnswerListeners = new Set<CodexAnswerListener>()
export function subscribeCodexAnswers(fn: CodexAnswerListener): () => void {
  codexAnswerListeners.add(fn)
  return () => { codexAnswerListeners.delete(fn) }
}
function heard(req: CodexConfirmRequest | undefined, allow: boolean, by: 'desktop' | 'phone') {
  if (!req) return
  for (const fn of codexAnswerListeners) {
    try { fn(req, allow, by) } catch { /* a listener never stops the run */ }
  }
}

/** The card shows the head of the queue. */
const head = (queue: Waiting[]) => ({ queue, pending: queue[0]?.req ?? null, resolve: queue[0]?.resolve ?? null })

export const useCodexConfirmStore = create<CodexConfirmState>((set, get) => ({
  pending: null,
  resolve: null,
  queue: [],

  ask: (req, signal) =>
    new Promise<boolean>((resolve) => {
      // Audit A4: Stop while the dialog was open never resolved this promise,
      // so the run's finally never ran and the chat stayed wedged. An abort
      // answers "no" and takes the card down with it.
      if (signal?.aborted) {
        resolve(false)
        return
      }
      // A second request while one is open waits behind it (bug hunt
      // 01.10.2026, C4). It used to answer the OLDER one "no" and take its
      // place: a command the user never saw was refused in their name, and
      // the run went on as if they had said no. Two runs in two conversations,
      // or a run and its sub-agent, ask at the same time routinely.
      const entry: Waiting = { req, resolve }
      set(head([...get().queue, entry]))
      signal?.addEventListener(
        'abort',
        () => {
          set(head(get().queue.filter((w) => w !== entry)))
          resolve(false)
        },
        { once: true },
      )
    }),

  answer: (allow) => {
    const [first, ...rest] = get().queue
    set(head(rest))
    first?.resolve(allow)
    heard(first?.req, allow, 'desktop')
  },

  answerRequest: (req, allow) => {
    const entry = get().queue.find((w) => w.req === req)
    if (!entry) return false
    set(head(get().queue.filter((w) => w !== entry)))
    entry.resolve(allow)
    heard(entry.req, allow, 'phone')
    return true
  },
}))
