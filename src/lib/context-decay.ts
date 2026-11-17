/**
 * Age decay for tool results (2.6.6, plan A1).
 *
 * The largest single cost leak in a long coding run: every tool result the
 * agent ever saw rode along VERBATIM in every following request. A run that
 * reads three 50k files pays for those 150k characters again on step 4, 5, 6
 * and on to step 40. The upstream bills the whole prompt every time.
 *
 * The fix is age, not size. A result the model looked at two iterations ago has
 * already done its job: the model either used it or moved on. So results older
 * than the newest iteration are sent head+tail-capped, while the newest
 * iteration stays byte-for-byte intact. That last part is the binding
 * behavioural rule (plan meta-rule 4, learned from the Morgan incident and the
 * 80-character-stub loop): the model must never edit against content it can no
 * longer see, and the content it is working on right now is always the content
 * it just fetched.
 *
 * Three properties this module has to keep:
 *
 *  1. BUILDER ONLY. Decay happens on a copy made while the request is built.
 *     The store, the persisted history and the visible transcript keep the full
 *     result, so the whole feature is reversible and the schema is unchanged.
 *  2. DETERMINISTIC AND FINAL. The cap is a fixed character budget, never a
 *     budget derived from the model window, so the same result always yields
 *     the same bytes. Per step at most ONE iteration crosses the age line;
 *     everything before it is byte-identical to the previous step, which is
 *     what makes the upstream prefix cache work at all (plan A3).
 *  3. STABLE ACROSS A RESTORE. A result the run already sent capped at 4k is
 *     restored at exactly those 4k bytes. The tighter 1.5k restore budget is
 *     for results the run never capped, i.e. results that were shorter than
 *     the in-run cap to begin with.
 */

import { truncateToolResult } from './truncate-tool-result'
import { ageOutImages } from './context-images'
import {
  compactMessages,
  estimateMessageTokens,
  COMPACT_DROP_BLOCK,
  COMPACT_TRIGGER_RATIO,
  KEEP_RECENT,
  stableCutIndex,
  stableDropBlock,
} from './context-compaction'

/** Head+tail budget for a result that has aged out, in characters. */
export const DECAY_RESULT_CHARS = 4000

/**
 * Head+tail budget for hidden tool messages of PREVIOUS turns when a session
 * is restored. Tighter than the in-run budget because a previous turn's work
 * is already summarised by its visible answer.
 */
export const RESTORE_RESULT_CHARS = 1500

/**
 * How many iterations a result survives at full length. The request under
 * construction counts as the current iteration, so 2 means: the results of the
 * iteration that just ran stay full, everything older is capped.
 */
export const DECAY_AFTER_ITERATIONS = 2

/**
 * Slack for the truncation marker truncateToolResult appends. Its output is a
 * few characters LONGER than the budget, so a naive length test would cut an
 * already-cut result a second time, and a second cut lands on different bytes,
 * which is exactly the prefix churn this whole file exists to avoid.
 */
const MARKER_SLACK = 64

/** The marker truncateToolResult leaves behind. */
const TRUNCATION_MARKER = '…[truncated '

/**
 * True when this text is already the output of a cut at `budget`. Decay has to
 * be idempotent: a restored result that the run capped at 4k is fed straight
 * back into the in-run decay on the next step, and cutting it again would move
 * the prompt prefix on every single step.
 */
export function isAlreadyDecayed(content: string, budget: number): boolean {
  return content.length <= budget + MARKER_SLACK && content.includes(TRUNCATION_MARKER)
}

/** Content a superseded todo_write result is replaced by (plan A5). */
export const SUPERSEDED_PLAN_NOTE = '[superseded plan update]'

/** Minimal shape this module needs. Works for ChatMessage and OllamaChatMessage. */
export interface DecayMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
}

interface RawToolCall {
  id?: string
  function?: { name?: string; arguments?: unknown }
}

/**
 * True for a message that carries a tool RESULT: the native `tool` role, or a
 * Hermes `<tool_response>` riding on a user message.
 */
export function isToolResult(msg: DecayMessage): boolean {
  if (msg.role === 'tool') return true
  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<tool_response>')) {
    return true
  }
  return false
}

/** The tool calls one assistant message asked for, both transports. */
function toolCallsIn(msg: DecayMessage): RawToolCall[] {
  const out: RawToolCall[] = []
  const calls = msg.tool_calls
  if (Array.isArray(calls)) {
    for (const tc of calls as RawToolCall[]) {
      if (tc && typeof tc === 'object') out.push(tc)
    }
  }
  if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.includes('<tool_call>')) {
    for (const block of msg.content.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)) {
      const m = /"name"\s*:\s*"([a-zA-Z0-9_]+)"/.exec(block[1])
      if (m) out.push({ function: { name: m[1] } })
    }
  }
  return out
}

function callName(tc: RawToolCall): string {
  return typeof tc.function?.name === 'string' ? tc.function.name : ''
}

/** One call paired with the message that carried its result. */
export interface PairedCall {
  name: string
  /** Index of the assistant message that asked for it. */
  callIndex: number
  /** Index of the message carrying the result, or -1 when it never landed. */
  resultIndex: number
  /** How many calls the same assistant message asked for. */
  batchSize: number
}

/**
 * Pair every tool call with its result message.
 *
 * Both transports are covered: the OpenAI shape links by `tool_call_id`, and
 * the id-less native / Hermes shapes link by order, which is exactly how the
 * loops emit them (one assistant message, then its results, in order).
 */
export function pairToolCalls(messages: DecayMessage[]): PairedCall[] {
  const pairs: PairedCall[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const calls = toolCallsIn(m)
    if (calls.length === 0) continue
    const resultIdx: number[] = []
    for (let j = i + 1; j < messages.length && isToolResult(messages[j]); j++) resultIdx.push(j)
    for (let c = 0; c < calls.length; c++) {
      const id = calls[c].id
      let resultIndex = -1
      if (typeof id === 'string' && id) {
        resultIndex = resultIdx.find((j) => messages[j].tool_call_id === id) ?? -1
      }
      if (resultIndex < 0) resultIndex = resultIdx[c] ?? -1
      pairs.push({ name: callName(calls[c]), callIndex: i, resultIndex, batchSize: calls.length })
    }
  }
  return pairs
}

/**
 * Iteration number per message index. An iteration starts at every assistant
 * message that asks for tools; results inherit the iteration of the call that
 * produced them. Messages before the first call belong to iteration 0.
 */
function iterationIndexes(messages: DecayMessage[]): number[] {
  const out = new Array<number>(messages.length).fill(0)
  let iter = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'assistant' && toolCallsIn(m).length > 0) iter++
    out[i] = iter
  }
  return out
}

export interface DecayOptions<T> {
  /** The contextDecay notaus. False sends the history exactly as before. */
  enabled?: boolean
  /** Character budget for an aged-out result. */
  maxChars?: number
  /** Iterations a result survives at full length. */
  afterIterations?: number
  /**
   * Loop-guard key of the read that produced this result, when the caller
   * knows it. Every key reported back in `trimmedKeys` is a read whose newest
   * result went out capped, which is precisely the case where a re-read is
   * legitimate and the guard must not count it (plan A1, LOOP-GUARD).
   */
  keyOf?: (msg: T) => string | undefined
  /**
   * Reads the model fetched AGAIN after their result had been capped (CA,
   * cloud loops, 13.11.2026). The newest result of such a read stays whole:
   * the model has shown it needs those bytes, and capping them again only
   * starts the next read, cap, read cycle, each lap a full paid request. Needs
   * `keyOf`. The window trim (trimWorkingHistory) still applies, so a pinned
   * result can never push a request past its budget.
   */
  keepWhole?: ReadonlySet<string>
}

export interface DecayReport<T> {
  /** A fresh array. The input is never touched. */
  messages: T[]
  /** How many results were sent capped this step. */
  trimmedCount: number
  /** Characters the capping saved on this request. */
  savedChars: number
  /** Loop-guard keys whose newest result went out capped. */
  trimmedKeys: string[]
}

/**
 * Cap every tool result that is older than the newest iteration.
 *
 * The newest iteration is untouched, always. With decay off the messages come
 * back unchanged (a copy, so the caller can keep treating the result as the
 * send array).
 */
export function applyToolResultDecay<T extends DecayMessage>(
  messages: T[],
  opts: DecayOptions<T> = {},
): DecayReport<T> {
  const out = messages.slice()
  if (opts.enabled === false) {
    return { messages: out, trimmedCount: 0, savedChars: 0, trimmedKeys: [] }
  }
  const maxChars = opts.maxChars ?? DECAY_RESULT_CHARS
  const afterIterations = opts.afterIterations ?? DECAY_AFTER_ITERATIONS
  const iters = iterationIndexes(messages)

  // The newest iteration that actually carries a result. Without one there is
  // nothing to age against and the whole pass is a no-op.
  let newest = -1
  for (let i = 0; i < messages.length; i++) {
    if (isToolResult(messages[i])) newest = Math.max(newest, iters[i])
  }
  if (newest < 0) return { messages: out, trimmedCount: 0, savedChars: 0, trimmedKeys: [] }

  let trimmedCount = 0
  let savedChars = 0
  const trimmedKeys: string[] = []
  // The newest result of every read that must stay whole.
  const pinned = new Set<number>()
  if (opts.keepWhole?.size && opts.keyOf) {
    const seen = new Set<string>()
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!isToolResult(messages[i])) continue
      const key = opts.keyOf(messages[i])
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (opts.keepWhole.has(key)) pinned.add(i)
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isToolResult(m)) continue
    if (pinned.has(i)) continue
    // The request under construction is iteration newest + 1.
    const age = newest + 1 - iters[i]
    if (age < afterIterations) continue
    const content = m.content
    if (typeof content !== 'string' || content.length <= maxChars) continue
    if (isAlreadyDecayed(content, maxChars)) continue
    const capped = truncateToolResult(content, maxChars)
    out[i] = { ...m, content: capped } as T
    trimmedCount++
    savedChars += content.length - capped.length
    const key = opts.keyOf?.(m)
    if (key) trimmedKeys.push(key)
  }
  return { messages: out, trimmedCount, savedChars, trimmedKeys }
}

/**
 * The budget a restored tool message of a PREVIOUS turn is sent at.
 *
 * Longer than the in-run cap means the run already sent it capped, so it is
 * handed back the very same bytes instead of being re-cut with a second
 * budget. Anything the run never capped gets the tight restore budget.
 */
export function restoreBudgetFor(
  length: number,
  inRunChars = DECAY_RESULT_CHARS,
  restoreChars = RESTORE_RESULT_CHARS,
): number {
  return length > inRunChars ? inRunChars : restoreChars
}

/**
 * Decay one restored tool message. Pure function of the stored content, which
 * is what makes the restore reproduce the in-run bytes without persisting a
 * single extra field.
 */
export function decayRestoredToolResult(
  content: string,
  inRunChars = DECAY_RESULT_CHARS,
  restoreChars = RESTORE_RESULT_CHARS,
): string {
  if (typeof content !== 'string') return content
  const budget = restoreBudgetFor(content.length, inRunChars, restoreChars)
  if (content.length <= budget) return content
  if (isAlreadyDecayed(content, budget)) return content
  return truncateToolResult(content, budget)
}

/**
 * Drop superseded todo_write pairs (plan A5).
 *
 * The model rewrites the COMPLETE plan after every step, so a 20-step run
 * carries 20 copies of a list that differs by one checkbox, and every copy is
 * paid for on every following request. Only the newest plan state says
 * anything; the older ones are noise the model has to read past.
 *
 * A pair is dropped whole when the assistant message asked for nothing but
 * todo_write. In a mixed batch the call has to stay (strict providers reject a
 * tool result without its call, and a call without its result), so only the
 * result text is replaced by a marker.
 */
export function pruneSupersededPlans<T extends DecayMessage>(
  messages: T[],
): { messages: T[]; prunedCount: number } {
  const pairs = pairToolCalls(messages).filter((p) => p.name === 'todo_write')
  if (pairs.length <= 1) return { messages: messages.slice(), prunedCount: 0 }

  const drop = new Set<number>()
  const blank = new Set<number>()
  // Everything but the last plan update is superseded.
  for (const p of pairs.slice(0, -1)) {
    if (p.batchSize === 1) {
      drop.add(p.callIndex)
      if (p.resultIndex >= 0) drop.add(p.resultIndex)
    } else if (p.resultIndex >= 0) {
      blank.add(p.resultIndex)
    }
  }

  const out: T[] = []
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue
    if (blank.has(i)) {
      out.push({ ...messages[i], content: SUPERSEDED_PLAN_NOTE } as T)
      continue
    }
    out.push(messages[i])
  }
  return { messages: out, prunedCount: drop.size + blank.size }
}

/** Looks at the screen that stay complete: the newest ones. */
export const KEEP_SCREEN_LOOKS = 2

/** What stands in for the rest of an older result of computer control. */
export const OLD_SCREEN_LOOK_NOTE = '[older look at the screen left out]'

/**
 * Shorten every result of computer control but the newest ones to its first
 * line.
 *
 * A step on the screen answers with what it did and with a new look: the
 * window in front, the pointer, the list of windows or of every button. Only
 * the newest look says what the screen is like. The older ones are stale by
 * definition, and a model that reads twenty of them works at a full context
 * for nothing (box, 09.10.2026: 267 tokens per step, forever). The first line
 * stays, because it is the record of what was done or why it was not.
 *
 * Final like the age decay: a shortened result is never shortened again, and
 * per step at most one more result crosses the line.
 */
export function pruneOldScreenLooks<T extends DecayMessage>(
  messages: T[],
  keep: number = KEEP_SCREEN_LOOKS,
): { messages: T[]; prunedCount: number; savedChars: number } {
  const out = messages.slice()
  const results = pairToolCalls(messages)
    .filter((p) => p.name === 'computer_use' && p.resultIndex >= 0)
    .map((p) => p.resultIndex)
  let prunedCount = 0
  let savedChars = 0
  for (const index of results.slice(0, Math.max(0, results.length - keep))) {
    const content = messages[index].content
    if (typeof content !== 'string' || content.includes(OLD_SCREEN_LOOK_NOTE)) continue
    // Hermes carries the result inside a tag on a user message: the tag stays.
    const wrapped = /^([\s\S]*?<tool_response>\s*)([\s\S]*?)(\s*<\/tool_response>[\s\S]*)$/.exec(content)
    const body = wrapped ? wrapped[2] : content
    const lines = body.split('\n')
    if (lines.length < 2) continue
    const short = `${lines[0]}\n${OLD_SCREEN_LOOK_NOTE}`
    if (short.length >= body.length) continue
    out[index] = { ...messages[index], content: wrapped ? `${wrapped[1]}${short}${wrapped[3]}` : short } as T
    prunedCount += 1
    savedChars += body.length - short.length
  }
  return { messages: out, prunedCount, savedChars }
}

/**
 * Bound the WORKING history the loop carries from step to step.
 *
 * This is the piece that makes the A3 hysteresis a real property instead of a
 * description. Trimming to the exact budget on every request means dropping
 * about two more messages every step, so the window start creeps forward every
 * step and the prompt prefix is never the same twice, no matter how the request
 * builder is tuned. Waiting until the carried array is 15 percent over budget
 * and then dropping it to 70 percent instead leaves the window start on the
 * same message for several steps running, and everything from there on is
 * byte-identical. Measured over a 30-step plateau: 3 prefix moves instead of
 * 18.
 *
 * Two rules keep it honest:
 *
 *  - it drops whole MESSAGES, it never shortens one. Decay stays the only
 *    thing that touches content, and it stays on the send copy alone, so the
 *    store and the next session keep every result whole.
 *  - the budget check runs on the DECAYED sizes, because that is what the
 *    request will actually cost. Measuring the raw sizes here would throw away
 *    messages that fit comfortably once decay has done its work.
 *
 * Stateless: the decision comes from the array being carried, never from a
 * watermark, so a step aborted halfway strands nothing.
 *
 * With `hysteresis` off the band collapses to the plain budget, which is what
 * the contextDecay notaus wants: a support case that flips the switch should
 * land on the 2.6.5 window, not on a third behaviour nobody has ever seen.
 */
/** How many ledger lines the pinned task carries at most. */
export const LEDGER_MAX_LINES = 40

/** The argument that names what a call worked on, in the order tools use them. */
const LEDGER_ARG_KEYS = ['path', 'file_path', 'filePath', 'command', 'query', 'pattern', 'url', 'name'] as const

function ledgerArg(args: unknown): string {
  let obj: unknown = args
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) } catch { return '' }
  }
  if (!obj || typeof obj !== 'object') return ''
  const rec = obj as Record<string, unknown>
  for (const key of LEDGER_ARG_KEYS) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) {
      const one = v.replace(/\s+/g, ' ').trim()
      return one.length > 80 ? one.slice(0, 77) + '...' : one
    }
  }
  return ''
}

/**
 * The run ledger (customer case 30.09.2026, "always starting with the
 * beginning"). trimWorkingHistory drops the oldest steps whole once a run
 * outgrows its send window. The task stayed pinned, but nothing said what had
 * already been done, so the model read the same files and redid the same
 * edits, and every repeat paid the full context again.
 *
 * One line per call in the dropped part, oldest first, duplicates folded. It
 * is derived from the dropped messages alone, so it only changes when the
 * drop point moves: between trims every request keeps the same prefix and the
 * upstream cache keeps hitting.
 */
const LEDGER_HEAD = '[Run ledger] Earlier steps of this run were removed from the context to save cost. They were already done, do not repeat them unless something changed:'
const LEDGER_TAIL = 'Continue from where the run stands now.'

/**
 * Splits a ledger the task already carries off its text. A second trim in
 * the same run drops the pinned task with the old ledger on it; its lines
 * have to go into the new ledger, or the steps of the first trim are gone
 * (box run d307-l: a run trimmed twice lost files 0 to 14 from its ledger).
 */
export function splitLedger(content: string): { task: string; lines: string[]; skipped: number } {
  const at = content.indexOf(LEDGER_HEAD)
  if (at === -1) return { task: content, lines: [], skipped: 0 }
  const task = content.slice(0, at).replace(/\n+$/, '')
  const lines: string[] = []
  let skipped = 0
  for (const raw of content.slice(at + LEDGER_HEAD.length).split('\n')) {
    if (!raw.startsWith('- ')) continue
    const older = /^- \((\d+) older steps\)$/.exec(raw)
    if (older) { skipped += Number(older[1]); continue }
    lines.push(raw.slice(2))
  }
  return { task, lines, skipped }
}

export function runLedger(dropped: DecayMessage[], earlier: { lines: string[]; skipped: number } = { lines: [], skipped: 0 }): string | null {
  const lines: string[] = [...earlier.lines]
  const seen = new Set<string>(lines)
  let skippedBefore = earlier.skipped
  for (const m of dropped) {
    // A dropped message can carry a ledger of its own: the persisted chain
    // puts the ledger of its cut on its first kept message
    // (codex/hidden-history.ts). Its lines come first, in their order.
    if (typeof m.content === 'string' && m.content.includes(LEDGER_HEAD)) {
      const inner = splitLedger(m.content)
      skippedBefore += inner.skipped
      for (const line of inner.lines) {
        if (seen.has(line)) continue
        seen.add(line)
        lines.push(line)
      }
    }
    if (m.role !== 'assistant') continue
    for (const tc of toolCallsIn(m)) {
      const name = callName(tc)
      if (!name || name === 'todo_write') continue
      const arg = ledgerArg(tc.function?.arguments)
      const line = arg ? `${name}: ${arg}` : name
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  if (lines.length === 0) return null
  const kept = lines.length > LEDGER_MAX_LINES ? lines.slice(-LEDGER_MAX_LINES) : lines
  const skipped = lines.length - kept.length + skippedBefore
  return [
    LEDGER_HEAD,
    ...(skipped > 0 ? [`- (${skipped} older steps)`] : []),
    ...kept.map((l) => `- ${l}`),
    LEDGER_TAIL,
  ].join('\n')
}

export function trimWorkingHistory<T extends DecayMessage>(
  messages: T[],
  budgetTokens: number,
  opts: DecayOptions<T> & { hysteresis?: boolean } = {},
): { messages: T[]; dropped: number } {
  const sizeOf = (list: T[]) =>
    estimateMessageTokens(
      applyToolResultDecay(list, opts).messages as unknown as Parameters<typeof estimateMessageTokens>[0],
    )
  const banded = opts.hysteresis !== false
  const trigger = banded ? Math.floor(budgetTokens * COMPACT_TRIGGER_RATIO) : budgetTokens
  if (budgetTokens <= 0 || sizeOf(messages) <= trigger) return { messages, dropped: 0 }

  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
  const rest = systemMsg ? messages.slice(1) : messages.slice()
  const firstUser = rest.find((m) => m.role === 'user') ?? null

  // The task itself is pinned, exactly as compactMessages pins it: the suffix
  // window is precisely the mechanism that drops the instruction first, after
  // which a long run works on whatever the recent results imply.
  const assemble = (drop: number): T[] => {
    let tail = rest.slice(drop)
    // Never open the window on a result whose call fell outside it; strict
    // providers reject that outright.
    while (tail.length > 0 && isToolResult(tail[0])) tail = tail.slice(1)
    const out: T[] = []
    if (systemMsg) out.push(systemMsg)
    if (firstUser && !tail.includes(firstUser)) {
      // The ledger rides on the pinned task instead of being a message of its
      // own: two user messages in a row break strict chat templates.
      if (typeof firstUser.content === 'string') {
        const { task, ...earlier } = splitLedger(firstUser.content)
        const ledger = runLedger(rest.slice(0, drop), earlier)
        out.push(ledger ? { ...firstUser, content: `${task}\n\n${ledger}` } : firstUser)
      } else {
        out.push(firstUser)
      }
    }
    out.push(...tail)
    return out
  }

  const maxDrop = Math.max(0, rest.length - KEEP_RECENT)
  if (banded) {
    // 3.1.1 (support case E8b): the cut sits on a fixed mark counted from the
    // start of the history, see stableCutIndex. The loops hand this function
    // the whole run on every step and keep nothing of its answer, so the same
    // history always gets the same cut, in this step, in the next one and in
    // the next turn, which starts from the stored conversation again. The
    // marks are placed by the sizes the messages are sent at, after decay,
    // the same sizes the budget is measured in. Decay only ever touches the
    // newest two steps' results later on, far behind any mark that matters.
    const sizes = applyToolResultDecay(rest, opts).messages.map((m) =>
      estimateMessageTokens([m] as unknown as Parameters<typeof estimateMessageTokens>[0]),
    )
    const drop = stableCutIndex(sizes, stableDropBlock(budgetTokens), maxDrop, (at) => sizeOf(assemble(at)) <= budgetTokens)
    return drop > 0 ? { messages: assemble(drop), dropped: drop } : { messages, dropped: 0 }
  }
  let drop = 0
  let candidate = messages
  while (drop < maxDrop) {
    drop = Math.min(drop + COMPACT_DROP_BLOCK, maxDrop)
    candidate = assemble(drop)
    if (sizeOf(candidate) <= budgetTokens) break
  }
  return { messages: candidate, dropped: drop }
}

export interface BuildRequestOptions<T> extends DecayOptions<T> {
  /** Token budget for the compaction pass (plan A2 picks the number). */
  budgetTokens: number
  /** Compact with the A3 hysteresis instead of trimming to the budget exactly. */
  hysteresis?: boolean
  /** Prune superseded todo_write pairs (plan A5). Off with decay off. */
  prunePlans?: boolean
  /** Age out attachments of older user turns (plan A4). Off with decay off. */
  ageImages?: boolean
  /** How many of the newest user turns keep their attachments (plan A4). */
  keepImages?: number
  /** Shorten older results of computer control to one line. Off with decay off. */
  pruneScreenLooks?: boolean
}

export interface BuiltRequest<T> extends DecayReport<T> {
  /** Superseded plan messages dropped or blanked. */
  prunedPlans: number
  /** Older looks at the screen shortened to one line. */
  prunedScreenLooks: number
  /** Attachments left behind by the image rule (plan A4). */
  droppedImages: number
  /** Base64 characters the image rule kept off the wire. */
  savedImageChars: number
  /** Estimated size of the request as it goes out. */
  promptTokens: number
}

/**
 * Build the message array one step actually sends.
 *
 * The order is binding (plan A1): decay first, then the budget, then
 * compaction. The other way round the budget counts full results, decides to
 * drop whole messages, and the decay it would have needed never happens.
 *
 * Attachments age out ahead of all of it (plan A4). They are the one thing the
 * token estimator cannot see, so leaving them for later would mean every budget
 * decision on the way is taken on a size that is not the size being billed. It
 * is the same builder both agent loops already call, which is why the picture a
 * user attached three turns ago stops riding on every step without either loop
 * having to know about the rule.
 */
export function buildRequestMessages<T extends DecayMessage>(
  messages: T[],
  opts: BuildRequestOptions<T>,
): BuiltRequest<T> {
  const aged =
    opts.enabled !== false && opts.ageImages !== false
      ? ageOutImages(messages as unknown as Array<{ role: string; content?: unknown }>, {
          keepRecent: opts.keepImages,
        })
      : { messages: messages.slice(), strippedImages: 0, savedChars: 0 }
  const decayed = applyToolResultDecay(aged.messages as unknown as T[], opts)
  let working = decayed.messages
  let prunedPlans = 0
  if (opts.enabled !== false && opts.prunePlans !== false) {
    const pruned = pruneSupersededPlans(working)
    working = pruned.messages
    prunedPlans = pruned.prunedCount
  }
  let prunedScreenLooks = 0
  if (opts.enabled !== false && opts.pruneScreenLooks !== false) {
    const pruned = pruneOldScreenLooks(working)
    working = pruned.messages
    prunedScreenLooks = pruned.prunedCount
  }
  const compacted = compactMessages(
    working as unknown as Parameters<typeof compactMessages>[0],
    opts.budgetTokens,
    { hysteresis: opts.hysteresis },
  ) as unknown as T[]
  return {
    messages: compacted,
    trimmedCount: decayed.trimmedCount,
    savedChars: decayed.savedChars,
    trimmedKeys: decayed.trimmedKeys,
    prunedPlans,
    prunedScreenLooks,
    droppedImages: aged.strippedImages,
    savedImageChars: aged.savedChars,
    promptTokens: estimateMessageTokens(
      compacted as unknown as Parameters<typeof estimateMessageTokens>[0],
    ),
  }
}
