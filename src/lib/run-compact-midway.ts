/**
 * Auto-compact in the middle of a tool run (3.0.7).
 *
 * The per-turn trigger (maybeAutoCompact in run-compact-command.ts) asks once,
 * before a turn starts. A long tool chain inside ONE turn never reaches that
 * question again: forty file reads and builds later the working payload is
 * past the window, and until now the only thing that happened then was the
 * mechanical trim (trimWorkingHistory), which drops the oldest steps whole and
 * leaves a ledger of tool names behind. What those steps found, decided and
 * changed was gone, and the run read the same files again.
 *
 * This module is the step between: when the payload of a running loop nears
 * the window, the older part of the run is summarised by the run's own model
 * and the summary rides in its place. The newest steps stay verbatim, always
 * as complete call/result pairs. The mechanical trim stays underneath and
 * still runs right after, as the safety net it always was.
 *
 * ── WHAT IT CHANGES, AND WHAT NOT ──────────────────────────────────────────
 *
 * Only the loop's working copy. The store, the visible transcript and the
 * hidden tool chain saved at the end of the run keep every result complete;
 * the loops already keep the run's own messages apart from the copies a trim
 * makes (useCodex `notRunOwn`, useAgentChat `werkzeugKette`), and the copies
 * this module makes are of the same kind. A visible notice says it happened.
 *
 * ── WHY ONE STATE PER RUN ──────────────────────────────────────────────────
 *
 * A run whose newest steps alone fill the window would otherwise summarise on
 * every step, each time a summary of a summary. The state carries a cooldown
 * in messages (the same currency as MIN_MESSAGES_SINCE_COMPACT) and gives up
 * for the rest of the run after MAX_RUN_FAILURES failed calls, so a model that
 * cannot write a usable summary costs two round trips, not forty.
 */

import { v4 as uuid } from 'uuid'
import {
  applyToolResultDecay,
  isToolResult,
  runLedger,
  type DecayMessage,
  type DecayOptions,
} from './context-decay'
import {
  attachNoteToUserMaterial,
  estimateMessageTokens,
  KEEP_RECENT,
} from './context-compaction'
import { runCompactSummary, transcriptCharsFor, type CompactRunResult } from './compact-run'
import {
  compactSummaryBody,
  hasCompactSummary,
  isEmptySummary,
  parseCompactSummary,
  renderCompactSummary,
  renderTranscript,
  stripCompactSummary,
  summaryCouldEverFit,
  type CompactSummary,
  type TranscriptTurn,
} from './compact-summary'
import { resolveCompactThreshold } from './compact-trigger'
import { formatCount } from './formatters'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { COMPACTING_ACTIVITY, useRunActivityStore } from '../stores/runActivityStore'
import type { AgentBlock } from '../types/agent-mode'

/**
 * Share of the budget the newest steps may keep verbatim. The rest is for the
 * summary, the system prompt and the next steps; at 0.3 a compaction frees
 * more than half of a full window, so the next one is many steps away.
 */
export const RUN_KEEP_SHARE = 0.3

/** Messages that must be added to the run before it may compact again. */
export const RUN_MESSAGES_SINCE_COMPACT = 6

/** Failed summary calls after which this run stops trying. */
export const MAX_RUN_FAILURES = 2

/**
 * Characters of one tool result the summariser is shown, at least. The real
 * share is the transcript the summary call can carry on this window, split
 * over the results (resultCharsFor). A fixed 2000 was measured to fail on
 * 17.10.2026: the one line that mattered sat in the middle of each result,
 * head and tail cut it out, and the summary made up the values instead.
 */
export const RUN_RESULT_CHARS = 2000

/** Never more of one result than this, however large the window. */
export const RUN_RESULT_CHARS_MAX = 16000

/** Characters each result may take in a transcript of `results` results. */
export function resultCharsFor(window: number | undefined, results: number): number {
  const share = Math.floor(transcriptCharsFor(window) / Math.max(1, results)) - 40
  return Math.max(RUN_RESULT_CHARS, Math.min(RUN_RESULT_CHARS_MAX, share))
}

/** Characters of one call's arguments the summariser is shown. */
const RUN_ARGS_CHARS = 400

/** Id prefix of the notice, so the transcript and tests can find it. */
export const RUN_COMPACT_NOTICE_PREFIX = 'autocompact-run-'

export interface RunCompactState {
  /** Length of the working array right after the last attempt, or null. */
  lastLength: number | null
  /** Failed attempts in this run. */
  failures: number
  /** Successful compactions in this run. */
  count: number
  /** Whether this run already said that a compaction failed. */
  warned: boolean
}

export function newRunCompactState(): RunCompactState {
  return { lastLength: null, failures: 0, count: 0, warned: false }
}

export type RunCompactReason =
  | 'off'
  | 'no-window'
  | 'gave-up'
  | 'cooldown'
  | 'below'
  | 'nothing'
  | 'over'

export interface RunCompactPlan {
  reason: RunCompactReason
  /** Payload size over the budget. */
  ratio: number
  /** The threshold it was compared to, 0 when off. */
  threshold: number
  /** Estimated payload tokens, decay applied. */
  tokens: number
  /** Index of the first message kept verbatim. Set only for 'over'. */
  keepFrom?: number
  /** Index of the user message to pin in front, when the kept part has none. */
  pinIndex?: number | null
}

/** The text of a message, whatever shape its content has. */
function textOf(m: DecayMessage): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return (m.content as Array<{ type?: string; text?: unknown }>)
      .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** A user message the person wrote, not a tool result riding on the user role. */
function isRealUser(m: DecayMessage): boolean {
  return m.role === 'user' && !isToolResult(m)
}

function headTail(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} characters left out] …\n${text.slice(text.length - half)}`
}

function callsLine(m: DecayMessage): string {
  if (!Array.isArray(m.tool_calls)) return ''
  return (m.tool_calls as Array<{ function?: { name?: unknown; arguments?: unknown } }>)
    .map((tc) => {
      const name = typeof tc?.function?.name === 'string' ? tc.function.name : 'tool'
      const raw = tc?.function?.arguments
      const args = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
      return `[tool call] ${name}(${headTail(args, RUN_ARGS_CHARS)})`
    })
    .join('\n')
}

/**
 * One working message as a transcript turn for the summariser. Tool results
 * are labelled as tool output, also when they ride on the user role (Hermes):
 * the summary copies USER REQUESTS word for word, and a file the agent read is
 * not something the person asked.
 */
export function runTurn(m: DecayMessage, resultChars = RUN_RESULT_CHARS): TranscriptTurn {
  const text = stripCompactSummary(textOf(m))
  if (isToolResult(m)) return { role: 'tool result', content: headTail(text, resultChars) }
  if (m.role === 'assistant') {
    const calls = callsLine(m)
    return { role: 'assistant', content: [text.trim(), calls].filter(Boolean).join('\n') }
  }
  return { role: m.role, content: text }
}

/** Payload tokens as the loop measures them: decay applied, per message. */
function decayedSizes<T extends DecayMessage>(messages: T[], decay?: DecayOptions<T>): number[] {
  const decayed = applyToolResultDecay(messages, decay ?? {}).messages
  return decayed.map((m) =>
    estimateMessageTokens([m] as unknown as Parameters<typeof estimateMessageTokens>[0]),
  )
}

/**
 * Should this run compact now, and where is the cut? Pure.
 *
 * The kept part is the newest messages up to RUN_KEEP_SHARE of the budget,
 * never fewer than KEEP_RECENT. It never opens on a tool result: the start
 * moves back to the call that asked for it, so every kept step is a complete
 * call/result pair.
 */
export function planRunCompaction<T extends DecayMessage>(input: {
  messages: T[]
  budgetTokens: number
  threshold: number | null
  state: RunCompactState
  decay?: DecayOptions<T>
}): RunCompactPlan {
  const { messages, budgetTokens, threshold, state } = input
  const sizes = decayedSizes(messages, input.decay)
  const tokens = sizes.reduce((n, s) => n + s, 0)
  const ratio = budgetTokens > 0 ? tokens / budgetTokens : 0
  const no = (reason: RunCompactReason): RunCompactPlan => ({ reason, ratio, threshold: threshold ?? 0, tokens })

  if (threshold === null) return no('off')
  if (!(budgetTokens > 0)) return no('no-window')
  if (state.failures >= MAX_RUN_FAILURES) return no('gave-up')
  if (state.lastLength !== null && messages.length - state.lastLength < RUN_MESSAGES_SINCE_COMPACT) {
    return no('cooldown')
  }
  if (ratio < threshold) return no('below')

  const first = messages[0]?.role === 'system' ? 1 : 0
  const keepBudget = budgetTokens * RUN_KEEP_SHARE
  let keepFrom = messages.length
  let kept = 0
  while (keepFrom > first) {
    const next = sizes[keepFrom - 1]
    const count = messages.length - keepFrom
    if (count >= KEEP_RECENT && kept + next > keepBudget) break
    kept += next
    keepFrom--
  }
  // Complete pairs only: a kept result keeps the call it answers.
  while (keepFrom > first && isToolResult(messages[keepFrom])) keepFrom--

  const dropped = messages.slice(first, keepFrom)
  if (dropped.length < 2) return no('nothing')
  if (!summaryCouldEverFit(renderTranscript(dropped.map(runTurn)).length)) return no('nothing')

  // The person's newest request stays word for word in front of the kept
  // steps when it would otherwise only live on inside the summary.
  let pinIndex: number | null = null
  if (!messages.slice(keepFrom).some(isRealUser)) {
    for (let i = keepFrom - 1; i >= first; i--) {
      if (isRealUser(messages[i])) { pinIndex = i; break }
    }
  }
  return { reason: 'over', ratio, threshold, tokens, keepFrom, pinIndex }
}

/**
 * The record an earlier compaction left in the working array, if any: the
 * per-turn one rides on the first user material, an earlier one of this run
 * on the message in front of its kept steps. The newest one is the state.
 */
export function previousStateIn(messages: DecayMessage[]): CompactSummary | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOf(messages[i])
    if (!hasCompactSummary(text)) continue
    const parsed = parseCompactSummary(compactSummaryBody(text))
    return isEmptySummary(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Files and commands of the summarised steps, checked against the summary.
 * The run ledger is derived from the calls themselves, so it is exact; what
 * the model left out of FILES goes in from there. A summary that forgot a
 * path makes the next step read the file again, or worse, edit one it never
 * saw.
 */
export function withLedgerFiles(summary: CompactSummary, dropped: DecayMessage[]): CompactSummary {
  const ledger = runLedger(dropped)
  if (!ledger) return summary
  const all = Object.values(summary).join('\n')
  const missing = ledger
    .split('\n')
    .filter((l) => l.startsWith('- ') && !l.startsWith('- ('))
    .filter((l) => {
      const arg = l.slice(2).split(': ').slice(1).join(': ').trim()
      return !all.includes(arg || l.slice(2))
    })
  if (missing.length === 0) return summary
  const files = (summary.files ?? '').trim()
  return { ...summary, files: [files, ...missing].filter(Boolean).join('\n') }
}

/** The transcript line for a compaction in the middle of a run. */
export function runCompactNotice(replaced: number, saved: number): string {
  return `Summarised ${replaced} earlier step message${replaced === 1 ? '' : 's'} of this run to stay inside the context window, about ${formatCount(saved)} tokens less in every following step. The run goes on from the summary; every result is still here in the chat.`
}

/** The block that marks a compaction in the middle of a run. */
export function compactionBlock(replaced: number, before: number, after: number): AgentBlock {
  return {
    id: `${RUN_COMPACT_NOTICE_PREFIX}${uuid()}`,
    phase: 'reflection',
    content: runCompactNotice(replaced, Math.max(0, before - after)),
    timestamp: Date.now(),
    compaction: { before, after, replaced },
  }
}

function addNotice(convId: string, beforeMessageId: string | undefined, notice: 'info' | 'warn', content: string): void {
  const store = useChatStore.getState()
  const message = {
    id: `${RUN_COMPACT_NOTICE_PREFIX}${uuid()}`,
    role: 'system' as const,
    notice,
    content,
    timestamp: Date.now(),
  }
  const conv = store.conversations.find((c) => c.id === convId)
  if (!conv) return
  // In front of the answer that is being written, where it happened.
  if (beforeMessageId && conv.messages.some((m) => m.id === beforeMessageId)) {
    store.insertMessageBefore(convId, beforeMessageId, message)
  } else {
    store.addMessage(convId, message)
  }
}

export interface RunCompactInput<T extends DecayMessage> {
  /** The loop's working array. Not mutated. */
  messages: T[]
  /** The budget the next request is built against (send window minus catalog). */
  budgetTokens: number
  /** The model's context window, for the size of the summary call itself. */
  modelWindow?: number
  activeModel: string | null
  convId?: string | null
  /** The assistant message of this run, so the notice lands in front of it. */
  beforeMessageId?: string
  signal?: AbortSignal
  state: RunCompactState
  decay?: DecayOptions<T>
  /**
   * The run's own block list (3.0.9). Given, a compaction that worked becomes
   * a block of the answer being written, at the step where it happened, and
   * the transcript draws it as one line. Without it the old notice message is
   * written in front of the answer, as before.
   */
  onCompacted?: (block: AgentBlock) => void
}

export interface RunCompactOutcome<T> {
  messages: T[]
  compacted: boolean
  reason: RunCompactReason | 'failed'
  replaced?: number
  tokensBefore?: number
  tokensAfter?: number
}

/**
 * Compact the older part of a running loop, when it nears the window.
 *
 * Never throws and never blocks the run: on any failure the working array
 * comes back unchanged and the mechanical trim does what it always did.
 */
export async function compactRunMidway<T extends DecayMessage>(
  input: RunCompactInput<T>,
): Promise<RunCompactOutcome<T>> {
  const unchanged = (reason: RunCompactOutcome<T>['reason']): RunCompactOutcome<T> => ({
    messages: input.messages, compacted: false, reason,
  })
  const settings = useSettingsStore.getState().settings
  if (settings.autoCompact === false || !input.activeModel) return unchanged('off')

  const threshold = resolveCompactThreshold(settings, input.budgetTokens, input.modelWindow ?? input.budgetTokens)
  const plan = planRunCompaction({
    messages: input.messages,
    budgetTokens: input.budgetTokens,
    threshold,
    state: input.state,
    decay: input.decay,
  })
  if (plan.reason !== 'over' || plan.keepFrom === undefined) return unchanged(plan.reason)

  const { messages } = input
  const first = messages[0]?.role === 'system' ? 1 : 0
  const dropped = messages.slice(first, plan.keepFrom)
  const window = input.modelWindow ?? input.budgetTokens
  const resultChars = resultCharsFor(window, dropped.filter(isToolResult).length)
  const turns = dropped.map((m) => runTurn(m, resultChars))
  const previous = previousStateIn(messages)

  const activity = useRunActivityStore.getState()
  const convId = input.convId ?? null
  const before = convId ? activity.activity[convId] ?? null : null
  if (convId) activity.setActivity(convId, COMPACTING_ACTIVITY)
  let result: CompactRunResult
  try {
    result = await runCompactSummary({
      turns,
      activeModel: input.activeModel,
      signal: input.signal,
      previous,
      window,
    })
    // Same fallback as the per-turn path: when the merge fails, a summary of
    // the new steps alone still beats a drop.
    if (!result.ok && previous && result.reason !== 'aborted' && result.reason !== 'no-model') {
      result = await runCompactSummary({
        turns,
        activeModel: input.activeModel,
        signal: input.signal,
        window,
      })
    }
  } finally {
    if (convId) useRunActivityStore.getState().setActivity(convId, before)
  }

  input.state.lastLength = messages.length
  if (!result.ok) {
    input.state.failures++
    if (convId && !input.state.warned && result.reason !== 'aborted') {
      input.state.warned = true
      addNotice(convId, input.beforeMessageId, 'warn',
        'Auto-compaction in the middle of this run did not go through, so older steps are shortened mechanically instead. The run goes on.')
    }
    return unchanged('failed')
  }

  const summary = withLedgerFiles(result.summary, dropped)
  const rendered = renderCompactSummary(summary)
  const strip = (m: T): T => {
    if (typeof m.content !== 'string' || !hasCompactSummary(m.content)) return m
    return { ...m, content: stripCompactSummary(m.content) }
  }
  const pinned = plan.pinIndex !== null && plan.pinIndex !== undefined ? strip(messages[plan.pinIndex]) : null
  const out = attachNoteToUserMaterial<T>({
    system: first ? messages[0] : null,
    pinned,
    kept: messages.slice(plan.keepFrom).map(strip),
    note: rendered,
    strip: stripCompactSummary,
  })

  const tokensAfter = decayedSizes(out, input.decay).reduce((n, s) => n + s, 0)
  input.state.lastLength = out.length
  input.state.count++
  input.state.failures = 0
  if (input.onCompacted) {
    input.onCompacted(compactionBlock(dropped.length, plan.tokens, tokensAfter))
  } else if (convId) {
    addNotice(convId, input.beforeMessageId, 'info',
      runCompactNotice(dropped.length, Math.max(0, plan.tokens - tokensAfter)))
  }
  return {
    messages: out,
    compacted: true,
    reason: 'over',
    replaced: dropped.length,
    tokensBefore: plan.tokens,
    tokensAfter,
  }
}
