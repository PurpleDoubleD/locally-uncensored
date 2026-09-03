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
 * ── A THIRD SOURCE, AND WHY IT BELONGS HERE ──────────────────────────────
 * `lib/run-lanes.ts` holds runs that have been asked for and are waiting for
 * the single local GPU. Such a run is in NEITHER store: no `generating` flag,
 * no thread, because the run has not started and nothing has set anything.
 * Left out,
 * it reads as `idle`, and the composer shows Send for a conversation whose run
 * is already booked. Pressing Send there books a second one, and both then
 * queue behind each other.
 *
 * It is asked the same way `run-stop.ts` is: module state keyed by
 * conversation, read live, never mirrored into a store. Mirroring it would
 * recreate the exact defect this file exists to fix, a fact kept in two
 * places that disagree in the window between them.
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
import { anyRunQueued, isRunQueued } from './run-lanes'
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

/**
 * Is ANY surface of the app busy right now? Reads both stores live, plus the
 * local lane's waiting room.
 *
 * The queue is a THIRD source and deliberately not a parameter of
 * `anyRunActive` above: that one is the pure verdict over the two store maps
 * and its callers hold those maps already. A queued run is in neither map,
 * having no `generating` flag and no thread, so it has to be asked for
 * separately, the same way `runStatusOf` asks `run-stop.ts`.
 *
 * It has to be asked at all because of `whenRunsIdle` below: a run that is
 * about to start is exactly the G25 case in the header. Opening a modal in the
 * half-second before the queue promotes it puts the modal over a run instead
 * of before it.
 *
 * HONEST GAP: `whenRunsIdle` wakes on store subscriptions, and dropping a
 * waiting run out of the queue (Stop pressed before its turn) changes neither
 * store. A deferred `show` then waits for the next store change instead of
 * firing immediately. That errs toward not opening a modal, which is the
 * harmless direction, and it is written down here rather than papered over
 * with a fourth subscription.
 */
export function runsActive(): boolean {
  if (anyRunQueued()) return true
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
 *   - Not active by either store, but waiting for the local lane → `queued`.
 *     This is asked FIRST of the inactive cases, and before `error`: a
 *     conversation whose last run failed and whose next run is already booked
 *     reads `queued`, not `error`. The older verdict would be about a run that
 *     is over while a newer one is pending.
 *   - Not active by either source → `error` if the thread recorded one,
 *     otherwise `idle`.
 *   - Active and the user pressed Stop → `cancelling`. `run-stop.ts` is keyed
 *     by conversation and is the one thing that knows this; the flag is sticky
 *     after the run ends, which is why it is only read once the run is already
 *     known to be active.
 *   - Active with a thread that names its own state → that state
 *     (`awaiting_approval` / `applying`), for whoever sets it.
 *   - Active otherwise → `running`.
 *
 * A queued run is NOT checked against the sticky stop flag, and that is safe
 * by construction rather than by luck: `beginRun` clears the flag at the top
 * of a user-initiated run, and admission to a lane happens inside such a run.
 * A conversation cannot be freshly queued and still carry a stop from before.
 * Stopping a run that is still WAITING is a queue operation, not a status
 * one: `release` drops it out. The row must leave the waiting room, otherwise
 * the composer keeps showing a cancelled run as pending.
 */
export function runStatusOf(conversationId: string | null | undefined): CodexThreadStatus {
  if (!conversationId) return 'idle'
  const generating = useGenerationStore.getState().generating[conversationId] === true
  const thread = useCodexStore.getState().threads[conversationId]?.status
  const active = generating || (thread !== undefined && isActiveCodexStatus(thread))
  if (!active) {
    if (isRunQueued(conversationId)) return 'queued'
    return thread === 'error' ? 'error' : 'idle'
  }
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
