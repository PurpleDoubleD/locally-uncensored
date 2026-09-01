/**
 * "Is something running right now?" — asked and answered in ONE place.
 *
 * G25 (R17c witness 2026-08-07): backend detection resolves asynchronously a
 * few seconds after startup, so the "Multiple backends running" selector could
 * open MID RUN and stand over the chat for the rest of a 20 minute agent run.
 * Detection is a startup convenience; an active run is the one thing on screen
 * the user is actually watching. Any modal it wants to open waits here until
 * every surface is idle.
 *
 * ── AS-08 ────────────────────────────────────────────────────────────────
 * The app keeps the fact "a run is in flight" in two stores, and they are not
 * redundant copies of one another:
 *
 *  1. `generationStore.generating[convId]` — Chat, Agent AND the Coding Agent
 *     all set it (`useChat.ts:639`, `useAgentChat.ts:599`, `useCodex.ts:756`).
 *     It is the flag the Stop button and the typing indicator hang off.
 *  2. `codexStore.threads[convId].status` — only the Coding Agent has one, and
 *     it is the only signal that can carry WHAT the run is doing rather than
 *     just THAT it is running.
 *
 * Neither one alone is the truth, and they disagree in windows that are easy
 * to hit. `stopCodex` (`useCodex.ts:2605`) calls `abortConversation` at `:2614`,
 * which deletes `generating[convId]` synchronously, while the thread's status only
 * returns to 'idle' when the aborted run finishes unwinding in its `finally`
 * (`useCodex.ts:2517`) — a shell command that does not honour the signal
 * promptly stretches that window to seconds. During it, source 1 says idle and
 * source 2 says running. That window has a name now: `cancelling`.
 *
 * So the fix is not to pick a winner, it is to stop asking the question in
 * more than one place. This module reconciles both sources once and hands out
 * the verdict; `types/codex.ts` owns the classification of the states
 * themselves, as a total map, so a new state cannot slip through as a silent
 * `else`.
 *
 * STILL OPEN (locked files, reported rather than papered over):
 *   - `components/chat/CodexModeDropdown.tsx:53` and
 *     `components/chat/PlanApprovalBar.tsx:45` each compute their own
 *     `generating[convId] === true` and never look at the thread. Both should
 *     call `isRunActive(convId)`.
 *   - `stores/chatStore.ts:59` (`dropConversationSideState`) sweeps four
 *     stores when a chat is deleted and does not include `codexStore.threads`,
 *     so a deleted coding chat leaves its thread behind — and its status keeps
 *     voting in `anyRunActive` below.
 */
import { useGenerationStore } from '../stores/generationStore'
import { useCodexStore } from '../stores/codexStore'
import { isRunStopped } from './run-stop'
import { isActiveCodexStatus, type CodexThreadStatus } from '../types/codex'

/**
 * Pure verdict over the two run signals, for the whole app: any generating
 * conversation, or any coding thread in a state that means work is in flight.
 *
 * The second half used to read `t.status === 'running'`, which answered "idle"
 * for a thread that was awaiting approval, applying its staged changes or
 * cancelling. The classification now lives with the union in `types/codex.ts`.
 * Exported for the unit tests and for callers that already hold both maps.
 */
export function anyRunActive(
  generating: Record<string, boolean>,
  threads: Record<string, { status: CodexThreadStatus }>,
): boolean {
  if (Object.values(generating).some(Boolean)) return true
  return Object.values(threads).some((t) => isActiveCodexStatus(t.status))
}

/** Is ANY surface of the app busy right now? Reads both stores live. */
export function runsActive(): boolean {
  return anyRunActive(
    useGenerationStore.getState().generating,
    useCodexStore.getState().threads,
  )
}

/**
 * What is this one conversation's run doing right now — the single verdict,
 * reconciled from both sources.
 *
 * Order matters and each step is a fact, not a guess:
 *   - Not active by either source → `error` if the thread recorded one,
 *     otherwise `idle`.
 *   - Active and the user pressed Stop → `cancelling`. `run-stop.ts` is keyed
 *     by conversation and is the one thing that knows this; the flag is sticky
 *     after the run ends, which is why it is only read once the run is already
 *     known to be active.
 *   - Active with a thread that names its own state → that state
 *     (`awaiting_approval` / `applying`), for whoever sets it.
 *   - Active otherwise → `running`.
 */
export function runStatusOf(conversationId: string | null | undefined): CodexThreadStatus {
  if (!conversationId) return 'idle'
  const generating = useGenerationStore.getState().generating[conversationId] === true
  const thread = useCodexStore.getState().threads[conversationId]?.status
  const active = generating || (thread !== undefined && isActiveCodexStatus(thread))
  if (!active) return thread === 'error' ? 'error' : 'idle'
  if (isRunStopped(conversationId)) return 'cancelling'
  if (thread && thread !== 'running' && isActiveCodexStatus(thread)) return thread
  return 'running'
}

/**
 * Is a run in flight on this conversation? The question every per-conversation
 * caller should ask — never `generating[convId]` on its own, which is the half
 * of the truth that the Coding Agent's own Stop clears first.
 */
export function isRunActive(conversationId: string | null | undefined): boolean {
  return isActiveCodexStatus(runStatusOf(conversationId))
}

/**
 * Call `show` now when no run is active, otherwise the moment the last run
 * ends. Returns a cancel function that withdraws a still-deferred `show`
 * without firing it; after `show` ran, cancelling is a no-op. Neither store
 * persists a running flag across a restart (generationStore is ephemeral by
 * design, codexStore persists only the working directory), so a crash can
 * never leave this waiting on a ghost run.
 */
export function whenRunsIdle(show: () => void): () => void {
  if (!runsActive()) {
    show()
    return () => {}
  }
  let done = false
  const unsubs: (() => void)[] = []
  const check = () => {
    if (done || runsActive()) return
    done = true
    for (const u of unsubs) u()
    show()
  }
  unsubs.push(useGenerationStore.subscribe(check))
  unsubs.push(useCodexStore.subscribe(check))
  return () => {
    done = true
    for (const u of unsubs) u()
  }
}
