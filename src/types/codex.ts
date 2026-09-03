// NOTE: the 'codex' value is kept as a stable internal id for storage
// back-compat (zustand persist key 'locally-uncensored-codex' + per-chat
// mode tag). It is an invisible identifier — the user-facing label is
// "Coding Agent" (see CodexView / Sidebar). Renaming it would wipe existing
// users' coding chats + working-dir on upgrade.
export type ChatMode = 'lu' | 'codex' | 'openclaw' | 'remote'

export type CodexEventType = 'instruction' | 'file_change' | 'terminal_output' | 'reasoning' | 'error' | 'done'

export interface CodexEvent {
  id: string
  type: CodexEventType
  content: string
  timestamp: number
  filePath?: string
  diff?: string
}

/**
 * The lifecycle of one Coding-Agent run, as the app actually runs it.
 *
 * AS-08. The union used to be `'idle' | 'running' | 'error'` — three states for
 * a lifecycle that has six. The missing three are not hypothetical; each one is
 * a place the app really parks in, it just parked there under a different
 * name, in a different module, out of reach of anything that asks "is a run in
 * flight?":
 *
 *  - `awaiting_approval` — the run is blocked on the shell/code approval card.
 *    `stores/codexConfirmStore.ts` parks the resolver, `hooks/useCodex.ts:2088`
 *    (`awaitApproval: knobs.confirmExec`) awaits it. The run is not doing
 *    anything and is not finished either.
 *  - `applying` — staged changes are being written to disk.
 *    `hooks/useCodex.ts:2371` (`await applyAllStagedChanges(convId)`) on the
 *    run's own exit path, and `components/chat/StagedChangesPanel.tsx:36`
 *    (a local `applying` Set) when the user presses Apply by hand.
 *  - `cancelling` — Stop was pressed and the tail of the run has not unwound
 *    yet. `lib/run-stop.ts` holds that fact per conversation, deliberately
 *    sticky, because "a stopped run's tail work … must all see the stop".
 *  - `queued`: the run has been asked for and is waiting for the local lane,
 *    because another local run holds the single GPU (`lib/run-lanes.ts`, and
 *    the VRAM reason is written out there). Same shape of bug as the three
 *    above: the state exists, and without a name for it a waiting chat reads
 *    as idle. The composer offers Send for a conversation that already has a
 *    run booked, and pressing it books a second one.
 *
 * The reason this matters is the one the audit names: a state the app has but
 * its type does not becomes a silent `else` at every branch. `run-idle.ts`
 * asked `status === 'running'` and answered "idle" for all three.
 *
 * `error` is kept and is honest about itself: it is declared, it is exercised
 * by `stores/__tests__/sessionStores.test.ts`, and **no production code sets
 * it** — `setThreadStatus` has exactly two callers, `useCodex.ts:752`
 * ('running') and `useCodex.ts:2517` ('idle'). That is the mirror image of the
 * bug above and it is written down here rather than quietly dropped.
 */
export type CodexThreadStatus =
  | 'idle'
  | 'running'
  | 'queued'
  | 'awaiting_approval'
  | 'applying'
  | 'cancelling'
  | 'error'

/**
 * Does this state mean a run is in flight?
 *
 * The verdict lives next to the union on purpose, and as a total
 * `Record<CodexThreadStatus, …>` rather than a list or a comparison: adding a
 * seventh state without deciding what it means to "is something running?" is a
 * compile error, not a silent `false`. That is the whole defence against the
 * pattern that produced AS-08 in the first place.
 *
 * `awaiting_approval`, `applying` and `cancelling` are all ACTIVE. A run
 * waiting on the user's approval still owns the conversation, still holds its
 * abort controller, and a modal that opens over it is the G25 regression all
 * over again. A run writing files to disk is the last moment you want to be
 * told the app is idle. And a cancelling run is not a finished run — that is
 * exactly the distinction T-28 / T-51 had to be taught.
 *
 * `queued` is ACTIVE too, and that is the one entry here worth arguing about,
 * because a queued run is the only active state that is provably burning
 * nothing: no request in flight, no tokens, no GPU. It counts anyway, because
 * every caller of this map asks the same practical question, "may I act as
 * if this conversation were free?", and for a queued run the answer is no.
 * The user already pressed Send. The work is booked, the Stop button has
 * something to cancel, and a composer that offers Send again books it twice.
 */
const RUN_ACTIVE_BY_STATUS: Record<CodexThreadStatus, boolean> = {
  idle: false,
  running: true,
  queued: true,
  awaiting_approval: true,
  applying: true,
  cancelling: true,
  // Terminal. The run is over; the thread carries the reason, not the work.
  error: false,
}

/** Every state in the union, derived from the verdict map so the two cannot drift. */
export const CODEX_THREAD_STATUSES = Object.keys(RUN_ACTIVE_BY_STATUS) as CodexThreadStatus[]

/**
 * The single classification of a thread status. Everything that wants to know
 * whether a coding run is in flight goes through here — see `lib/run-idle.ts`,
 * which is the one place that answers the question for the whole app.
 */
export function isActiveCodexStatus(status: CodexThreadStatus): boolean {
  return RUN_ACTIVE_BY_STATUS[status]
}

export interface CodexThread {
  id: string
  conversationId: string
  events: CodexEvent[]
  status: CodexThreadStatus
  workingDirectory: string
}

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  children?: FileTreeNode[]
}
