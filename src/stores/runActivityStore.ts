import { create } from 'zustand'
import type { ToolCallProgress } from '../api/providers/types'
import { preparingWord } from '../components/status/run-status'

/**
 * What a running turn is doing right now, when the run knows more than
 * "Working". Read by WorkingAnchor; an explicit label there (an approval wait,
 * a model load) still wins.
 *
 * Realtime pass 01.10.2026 (R1): while a model writes a tool call, the
 * arguments stream in for seconds (a 4 kB file_write took ~11 s on Mistral
 * Small, measured live) and the run said only "Working". The provider knows
 * the call's name from the first delta, so the anchor says it.
 *
 * Not persisted: a label from a crashed run must not survive a restart.
 */
export interface RunActivity {
  /** Announced to screen readers when it changes. */
  label: string
  /** A count that grows while the label stands (the call's size); shown, not announced. */
  detail?: string
  /** A named state of the run. Without it the label is a call being written. */
  kind?: 'compacting' | 'retrying' | 'reading' | 'thinking'
  /** A sentence under the line when the wait needs explaining (B26: a local
   *  model that does not fit on the graphics card). Shown, not announced. */
  hint?: string
}

interface RunActivityState {
  activity: Record<string, RunActivity>
  setActivity: (conversationId: string | null | undefined, activity: RunActivity | null) => void
}

export const useRunActivityStore = create<RunActivityState>((set) => ({
  activity: {},
  setActivity: (conversationId, activity) => {
    if (!conversationId) return
    set((state) => {
      const now = state.activity[conversationId]
      if (now?.label === activity?.label && now?.detail === activity?.detail && now?.kind === activity?.kind && now?.hint === activity?.hint) return state
      const next = { ...state.activity }
      if (activity) next[conversationId] = activity
      else delete next[conversationId]
      return { activity: next }
    })
  },
}))

/**
 * "Preparing to write", plus the size once a kilobyte has arrived. Whole kB,
 * so the store changes at most once per kB. The words come from the same
 * table as the status of a running tool (components/status/run-status.ts).
 */
export function toolProgressActivity(progress: ToolCallProgress): RunActivity {
  const kb = Math.floor(progress.argsChars / 1024)
  const label = preparingWord(progress.name)
  return kb > 0 ? { label, detail: `${kb} kB` } : { label }
}

/**
 * The first wait of a turn, said in words (A7, 3.0.8). Until the first token
 * the model is reading the request, and on a local model whose prompt cache
 * missed that took 11 to 72 seconds of a bare "Starting" (David's box,
 * 20.10.2026). The size says why a long chat waits longer. Rounded to a tenth
 * of a thousand, so the line does not twitch.
 */
export function readingActivity(promptTokens: number): RunActivity {
  const k = Math.round(promptTokens / 100) / 10
  return promptTokens >= 1000
    ? { label: 'Reading the conversation', kind: 'reading', detail: `${k}k tokens` }
    : { label: 'Reading the conversation', kind: 'reading' }
}

/** The model thinks, but its thoughts are not shown (Think is off for this model). */
export const HIDDEN_THINKING_ACTIVITY: RunActivity = { label: 'Thinking', kind: 'thinking' }

/**
 * Hand the line back once the model answers: its text, a thought it shows, or
 * a call it writes says the rest. Only the two first-wait states are taken
 * back; a compaction or a retry line belongs to someone else.
 */
export function endFirstWait(conversationId: string | null | undefined): void {
  if (!conversationId) return
  const { activity, setActivity } = useRunActivityStore.getState()
  const kind = activity[conversationId]?.kind
  if (kind === 'reading' || kind === 'thinking') setActivity(conversationId, null)
}

/** A thought the run does not show arrived: say "Thinking" instead of "Reading". */
export function hiddenThoughtArrived(conversationId: string | null | undefined): void {
  if (!conversationId) return
  const { activity, setActivity } = useRunActivityStore.getState()
  if (activity[conversationId]?.kind === 'reading') setActivity(conversationId, HIDDEN_THINKING_ACTIVITY)
}

/** The older part of the conversation is being summarized before the request goes out. */
export const COMPACTING_ACTIVITY: RunActivity = { label: 'Compacting', kind: 'compacting' }

/**
 * Wait before a model call is tried again, and say so for as long as the wait
 * lasts. The line is taken back before the next attempt, so the attempt shows
 * as what it is. A wait can last a minute when a server names it, so Stop
 * (`signal`) ends it at once.
 */
export async function waitBeforeRetry(conversationId: string | null | undefined, ms: number, signal?: AbortSignal): Promise<void> {
  const { setActivity } = useRunActivityStore.getState()
  setActivity(conversationId, { label: 'Retrying', kind: 'retrying' })
  let stop: (() => void) | null = null
  try {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return }
      const timer = setTimeout(resolve, ms)
      stop = () => { clearTimeout(timer); resolve() }
      signal?.addEventListener('abort', stop, { once: true })
    })
  } finally {
    if (stop) signal?.removeEventListener('abort', stop)
    if (conversationId && useRunActivityStore.getState().activity[conversationId]?.kind === 'retrying') setActivity(conversationId, null)
  }
}

/**
 * A render from this chat took the local chat model off the graphics card
 * and is still going in the background (3.0.8, A2, one card only). The local
 * request would wait for it inside the provider without a word, so the run
 * waits here, says what for, and Stop ends the wait. Not local, or nothing
 * held: returns at once.
 */
export async function waitForChatCard(
  conversationId: string | null | undefined,
  local: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!local) return
  const { chatBackendsHeldBy, chatBackendsBack } = await import('../lib/chat-backends-gate')
  const held = chatBackendsHeldBy()
  if (!held) return
  const { setActivity } = useRunActivityStore.getState()
  const label = 'Waiting for the graphics card'
  setActivity(conversationId, { label, detail: held === 'video' ? 'a video is rendering' : 'a picture is rendering' })
  let stop: (() => void) | null = null
  try {
    await Promise.race([
      chatBackendsBack(),
      new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return }
        stop = () => resolve()
        signal?.addEventListener('abort', stop, { once: true })
      }),
    ])
  } finally {
    if (stop) signal?.removeEventListener('abort', stop)
    if (conversationId && useRunActivityStore.getState().activity[conversationId]?.label === label) setActivity(conversationId, null)
  }
}
