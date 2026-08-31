// The coding agent's "may I run this" gate, as app UI instead of window.confirm.
//
// It used to be a raw `window.confirm`, which in the Tauri webview renders as an
// OS dialog: system chrome, the app origin in the title bar, the whole prompt as
// one wall of text, and no way to say "stop asking". David, 2026-07-24, on
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
}

interface CodexConfirmState {
  pending: CodexConfirmRequest | null
  /** Resolver for the awaited approval. Null when nothing is pending. */
  resolve: ((allow: boolean) => void) | null
  ask: (req: CodexConfirmRequest, signal?: AbortSignal) => Promise<boolean>
  answer: (allow: boolean) => void
}

export const useCodexConfirmStore = create<CodexConfirmState>((set, get) => ({
  pending: null,
  resolve: null,

  ask: (req, signal) =>
    new Promise<boolean>((resolve) => {
      // Audit A4: Stop while the dialog was open never resolved this promise,
      // so the run's finally never ran and the chat stayed wedged. An abort
      // answers "no" and takes the dialog down with it.
      if (signal?.aborted) {
        resolve(false)
        return
      }
      // A second request while one is open would strand the first resolver and
      // hang that tool call forever. Deny the older one and take the new.
      const prev = get().resolve
      if (prev) prev(false)
      set({ pending: req, resolve })
      signal?.addEventListener(
        'abort',
        () => {
          if (get().resolve === resolve) set({ pending: null, resolve: null })
          resolve(false)
        },
        { once: true },
      )
    }),

  answer: (allow) => {
    const { resolve } = get()
    set({ pending: null, resolve: null })
    resolve?.(allow)
  },
}))
