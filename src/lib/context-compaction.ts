/**
 * Context Compaction — prevents "Failed to fetch" from context window exhaustion.
 *
 * Strategy:
 * - Keep the last N messages intact (recent context matters most)
 * - Summarize older messages into compact one-liners
 * - Tool call + result pairs become: "Used tool_name('args') → result_snippet"
 * - Token estimation: script aware, see lib/token-estimate.ts (GH #167)
 */

import { getModelContextCached } from '../api/ollama'
import { isCompatProviderId } from '../api/providers/compat-id'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ollamaWindowFor } from './context-window'
import { truncateToolResult } from './truncate-tool-result'
import { estimateTokens as estimateTokensByScript, charsPerToken } from './token-estimate'
import type { OllamaChatMessage } from '../types/agent-mode'

// ── Token Estimation ────────────────────────────────────────────

/**
 * Token estimate of one string. GH #167: no longer chars / 4 for every
 * script. Latin text keeps 4 characters per token to the token, Japanese,
 * Chinese and Korean cost about 0.8 token per character, emoji and symbols
 * more. The rules and their evidence live in lib/token-estimate.ts, a leaf
 * module, so the provider layer can use the same function without an import
 * cycle through this file.
 */
export function estimateTokens(text: string): number {
  return estimateTokensByScript(text)
}

/**
 * Estimate total tokens in a message array.
 */
export function estimateMessageTokens(messages: OllamaChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    // Tool calls add overhead
    if (m.tool_calls) {
      tokens += estimateTokens(JSON.stringify(m.tool_calls))
    }
    // Role tag overhead (~4 tokens)
    tokens += 4
    return sum + tokens
  }, 0)
}

// ── Model Context Lookup ────────────────────────────────────────

/**
 * Get the max context window for a model. Provider-aware.
 * Cloud models have known large context windows.
 */
export async function getModelMaxTokens(modelName: string): Promise<number> {
  try {
    const providerId = getProviderIdFromModel(modelName)

    if (providerId === 'lu-cloud') {
      // LU Cloud ships the real context_length via /models; the model store
      // carries it as contextLength. Without this branch the prefixed name
      // fell into the Ollama path → /api/show 404 → 4096 for EVERY cloud
      // model (TokenCounter pinned red at 4.1k).
      const meta = useModelStore.getState().models.find((m) => m.name === modelName)
      const ctx = meta && 'contextLength' in meta ? meta.contextLength : undefined
      if (ctx && ctx > 0) return ctx
      const { provider, modelId } = getProviderForModel(modelName)
      return await provider.getContextLength(modelId)
    }

    if (providerId === 'openai' || providerId === 'anthropic' || isCompatProviderId(providerId)) {
      // Use provider's getContextLength for cloud models
      const { provider, modelId } = getProviderForModel(modelName)
      return await provider.getContextLength(modelId)
    }

    // Ollama: use existing endpoint, through the cache.
    //
    // Uncached this was one /api/show per call, and 2.6.8 Compact-Schritt 2
    // gives the group path a reason to ask once per model per ROUND. The
    // value cached is the model file's trained context length, which does not
    // change while the app runs; the user's override is a separate lever and
    // is applied by effectiveContextWindow, downstream of this. Two other
    // readers of exactly this number — useChat's own num_ctx resolution and
    // useActiveContextWindow — already go through the same cache, so this
    // removes an inconsistency rather than adding a risk.
    return await getModelContextCached(modelName)
  } catch {
    return 4096
  }
}

/**
 * The window a CHAT turn on this model runs in, for the history budget and
 * the auto compact of plain chat, a group round and compare.
 *
 * On Ollama that is the num_ctx the request carries for `window: 'chat'`
 * (`ollamaNumCtx` in api/ollama.ts asks `ollamaWindowFor` with the same three
 * values), not the model's trained maximum. GH #166: the budget read
 * `getModelMaxTokens`, so it ignored the user's "Context window (Ollama)".
 * With 262144 set, num_ctx 262144 went out while the history was trimmed to a
 * fraction of a stand in 4096, and a long chat lost its older turns without a
 * word. The other direction was as wrong: a 128K model sent with num_ctx
 * 16384 was budgeted at 0.8 of 128K, so Ollama cut the front itself.
 *
 * Every other backend: `getModelMaxTokens`, unchanged.
 */
export async function getChatWindowTokens(modelName: string): Promise<number> {
  try {
    if (getProviderIdFromModel(modelName) === 'ollama') {
      const override = useSettingsStore.getState().settings.contextWindowOverride
      if (override && override > 0) return override
      return ollamaWindowFor('chat', await getModelContextCached(modelName))
    }
  } catch {
    return 4096
  }
  return getModelMaxTokens(modelName)
}

// ── Message Compaction ──────────────────────────────────────────

export const KEEP_RECENT = 4 // Always keep at least the last N messages untouched

/** Hard ceiling on how many messages one request may carry, independent of
 * tokens. The LU Cloud proxy rejects anything above 400 messages, and a chat
 * of many SHORT turns sits under every token budget while the count keeps
 * growing — the token-only compaction never fired and the chat hard-400ed on
 * every send, permanently (2026-08-21: "[network] HTTP 400 too
 * many messages" after ~7 coding tasks in one chat). 380 mirrors the web
 * app's MAX_SEND_MESSAGES and leaves room for the pin and the trim notice. */
export const MAX_SEND_MESSAGES = 380

/** Suffix quota inside compactMessages: system prompt, pinned task and trim
 * notice ride on top of the kept window, so the window itself stays 3 short
 * of the ceiling. */
const COUNT_BUDGET = MAX_SEND_MESSAGES - 3

/** How many messages the count cap drops at a time (capMessageCount). */
export const COUNT_DROP_BLOCK = 64

/** How much of the pinned first user message survives compaction. Enough for
 * any real instruction; a pasted 200 KB file does not ride along forever. */
const PINNED_TASK_MAX_CHARS = 8000

/** The agent notice without its trail of done calls, to size its room. */
const AGENT_NOTICE_SIZE_PROBE = '[999 earlier messages were trimmed to fit the context window. The original task still stands. Results you already saw still hold. If a detail is genuinely missing, re-read that specific file once; never repeat a call that already ran.]'

/** How many already-done tool names the trim notice carries. */
const DONE_TRAIL_MAX = 40

/**
 * The tool names one assistant message asked for, in order.
 *
 * Two shapes, because the transports differ: the native and OpenAI paths carry
 * `tool_calls`, the hermes path carries `<tool_call>{…}</tool_call>` in the
 * content. Reading only the first `"name"` INSIDE each block matters, since a
 * tool's own arguments routinely contain a `name` field of their own.
 */
function toolNamesIn(msg: OllamaChatMessage): string[] {
  const out: string[] = []
  const calls = (msg as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
  if (Array.isArray(calls)) {
    for (const tc of calls) {
      if (typeof tc?.function?.name === 'string') out.push(tc.function.name)
    }
  }
  if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.includes('<tool_call>')) {
    for (const block of msg.content.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)) {
      const m = /"name"\s*:\s*"([a-zA-Z0-9_]+)"/.exec(block[1])
      if (m) out.push(m[1])
    }
  }
  return out
}

/**
 * The trim notice block, wherever it rides. Kept as a factory because a
 * shared /g regex carries lastIndex state between .test and .replace calls.
 */
const trimNoticeRe = () =>
  /\s*\[(?:\d+ earlier messages? (?:was|were) trimmed to fit the context window\.|Note: \d+ earlier messages? of this conversation (?:is|are) not included here)[^\]]*\]\s*/g

/**
 * The trim notice for a CONVERSATION (GH #201): plain chat, a group round,
 * compare. The agent's wording below talks about a task, results and files to
 * re-read, which in a story only confuses the model. This one says what is
 * true in a chat: the start is missing, carry on from what is here.
 */
export function chatTrimNotice(dropped: number): string {
  return `[Note: ${dropped} earlier message${dropped === 1 ? ' of this conversation is' : 's of this conversation are'} not included here because they no longer fit the context window. Continue naturally from the messages you can see.]`
}

/** Remove an earlier trim notice from a message body, so repeated compaction
 *  rounds never stack notices inside the pinned task or the kept window. */
export function stripTrimNotice(text: string): string {
  if (!trimNoticeRe().test(text)) return text
  return text.replace(trimNoticeRe(), '\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * True for a message that is a tool RESULT — either the native `tool` role or
 * a Hermes `<tool_response>` carried on a user message. Used to trim a leading
 * orphan result whose originating tool_call fell outside the kept window.
 */
function isToolResultMessage(msg: OllamaChatMessage): boolean {
  if (msg.role === 'tool') return true
  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<tool_response>')) {
    return true
  }
  return false
}

/**
 * WHERE A CARRIED NOTE IS ALLOWED TO SIT — the one rule, one place.
 *
 * Anything a compaction wants to tell the model afterwards (the mechanical
 * trim notice, and since 2.6.8 the written summary) has the same problem: it
 * is instruction-shaped, so `role: 'system'` is the obvious home, and
 * `role: 'system'` is exactly what it may not be. A system message anywhere
 * but index 0 is refused outright by strict Jinja chat templates — "System
 * message must be at the beginning" (Discord #bug-reports
 * 2026-08-21, and the reason it only showed up in LU was that compaction only
 * fires once a history is long).
 *
 * So the note rides on USER material, in this order of preference:
 *   1. appended to the pinned task, when the pin is being re-added anyway —
 *      the note and the task belong together and cost one message instead of
 *      two;
 *   2. else prefixed to the first kept user turn;
 *   3. else as its own user turn.
 *
 * Extracted in 2.6.8 because the written summary needs the identical rule.
 * Two copies of a placement rule whose whole purpose is "there is exactly one
 * legal position" is how the second copy ends up in the illegal one.
 */
export interface CarriedNoteInput<T> {
  /** The system prompt, if any. Always ends up at index 0 and nowhere else. */
  system: T | null
  /** The pinned first user turn, when it has to be re-added ahead of the window. */
  pinned: T | null
  /** The kept suffix, newest material, in order. */
  kept: T[]
  /** The note to carry, or null when there is nothing to say. */
  note: string | null
  /** Removes an earlier note of the same kind from a body, so notes never stack. */
  strip?: (text: string) => string
}

export function attachNoteToUserMaterial<T extends { role: string; content?: unknown }>(
  input: CarriedNoteInput<T>,
): T[] {
  const strip = input.strip ?? ((t: string) => t)
  const out: T[] = []
  if (input.system) out.push(input.system)
  const kept = [...input.kept]
  let note = input.note

  if (input.pinned) {
    out.push(
      note
        ? ({ ...input.pinned, content: `${String(input.pinned.content ?? '')}\n\n${note}` } as T)
        : input.pinned,
    )
    note = null
  }
  if (note) {
    if (kept[0]?.role === 'user' && typeof kept[0].content === 'string') {
      kept[0] = { ...kept[0], content: `${note}\n\n${strip(kept[0].content)}` } as T
    } else {
      out.push({ role: 'user', content: note } as unknown as T)
    }
  }
  out.push(...kept)
  return out
}

/**
 * Compact a message array to fit within a token budget.
 *
 * Strategy — sliding window, lossless on whatever it keeps:
 *  - If already within budget, return messages unchanged.
 *  - Otherwise keep the system prompt + the longest recent SUFFIX that fits,
 *    VERBATIM, and DROP the oldest messages entirely (replaced by a one-line
 *    notice).
 *
 * Why not summarize? The previous implementation char-truncated every older
 * tool result to 80 chars. Inside a single autonomous coding turn that meant an
 * 80-char slice of a file the agent had read was indistinguishable from the
 * whole file — so the model edited against content it could no longer see.
 * Dropping is honest: the model re-reads with file_read when it needs the bytes
 * again, instead of trusting a lossy stub.
 */
/**
 * Count-only cap for paths that never token-compact (the plain chat path).
 * Keeps the system prompt plus the newest messages and never starts the kept
 * window on an orphan tool result. Token budgets are compactMessages' job;
 * this only guarantees the proxy's message-count gate can't be tripped.
 */
export function capMessageCount<T extends { role: string; content?: unknown }>(
  messages: T[],
  max = MAX_SEND_MESSAGES,
): T[] {
  if (messages.length <= max) return messages
  const sys = messages[0]?.role === 'system' ? [messages[0]] : []
  const rest = sys.length ? messages.slice(1) : messages
  // 3.1.1 (support case E8b): the oldest messages go in whole blocks counted
  // from the start. "The newest 380" began one message later on every send,
  // so a chat past the cap never sent the same beginning twice and nothing
  // came out of the upstream cache.
  const over = rest.length - (max - sys.length)
  const drop = Math.min(rest.length, Math.ceil(over / COUNT_DROP_BLOCK) * COUNT_DROP_BLOCK)
  const kept = rest.slice(drop)
  while (kept.length > 0 && isToolResultMessage(kept[0] as unknown as OllamaChatMessage)) {
    kept.shift()
  }
  return [...sys, ...kept]
}

/**
 * Hysteresis (2.6.6, plan A3). Trimming to exactly the budget every step moves
 * the prompt prefix every step, and a moved prefix is a cold upstream cache:
 * the whole history is billed at full price again. So compaction waits until
 * the history is 15 percent OVER budget and then drops in one big block down
 * to 70 percent of it. In between, the array passes through byte-for-byte and
 * the cache keeps hitting.
 *
 * The decision is taken from the messages array alone, with no watermark kept
 * anywhere, so a run aborted mid-step strands no state (plan A3, Runde 2).
 */
export const COMPACT_TRIGGER_RATIO = 1.15
export const COMPACT_TARGET_RATIO = 0.7

/**
 * How many messages one drop step removes when the carried history has to
 * shrink (trimWorkingHistory in context-decay).
 *
 * The hysteresis pair above is what keeps the prefix still; this is the step
 * size of the search for how much to drop, and it is a block rather than a
 * single message because each probe re-measures the whole decayed history.
 * One at a time would make a long run quadratic for no gain.
 */
export const COMPACT_DROP_BLOCK = 16

/**
 * Where a history over the trigger is cut (3.1.1, support case E8b).
 *
 * The hysteresis above keeps the prefix still only while the array it is
 * handed was cut the step before. Every conversation surface hands it the
 * FULL history on every send, and so does an agent run at the start of each
 * turn. Once the full history is over the trigger it is over it for good, so
 * every send dropped down to the target again, counted from the newest
 * message: the cut moved with every message that arrived, the prefix was new
 * every time and the upstream cache never hit. Measured on a paid model: a
 * step at about 4,000 credits instead of 150 to 400.
 *
 * So the cut may only sit on fixed marks, and the marks are counted from the
 * START of the history: every `block` tokens of it is one. The cut is the
 * first mark behind which the rest fits the budget. New messages at the end
 * move no mark, so the cut stands until the rest has grown past the budget
 * again, and then it moves one mark on, back down towards the target. In
 * between every request starts with the request before it, byte for byte,
 * with nothing remembered anywhere.
 *
 * A history that was never cut still passes whole up to the trigger, as
 * before. Once it has been cut it lives between target and budget.
 */
export const STABLE_BLOCK_FLOOR = 64

/**
 * The distance between two marks: the room between target and budget,
 * rounded DOWN to a coarse step (a quarter of the power of two below it).
 * Rounded, because an agent's budget is calibrated against the backend's own
 * count on every step and moves by a few tokens; marks that moved with it
 * would be no marks at all.
 */
export function stableDropBlock(budgetTokens: number): number {
  const span = Math.floor(Math.max(0, budgetTokens) * (1 - COMPACT_TARGET_RATIO))
  if (span <= STABLE_BLOCK_FLOOR) return STABLE_BLOCK_FLOOR
  let power = STABLE_BLOCK_FLOOR
  while (power * 2 <= span) power *= 2
  const step = power / 4
  return Math.floor(span / step) * step
}

/**
 * The first mark at which `fits(cut)` holds, as an index into `sizes`:
 * everything before it is dropped. `sizes` are the messages' own sizes, in
 * order. Never past `maxCut`; when no mark up to there fits, the last mark
 * before it is the answer (still a fixed place), or `maxCut` without one.
 * Nothing is cut when the whole history fits.
 */
export function stableCutIndex(
  sizes: number[],
  block: number,
  maxCut: number,
  fits: (cut: number) => boolean,
): number {
  if (fits(0)) return 0
  const step = Math.max(1, Math.floor(block))
  let before = 0
  let lastMark = -1
  for (let i = 1; i <= maxCut && i <= sizes.length; i++) {
    const after = before + sizes[i - 1]
    // Message i-1 carried the history over the next multiple of the block.
    if (Math.floor(after / step) > Math.floor(before / step)) {
      lastMark = i
      if (fits(i)) return i
    }
    before = after
  }
  return lastMark >= 0 ? lastMark : Math.max(0, maxCut)
}

export interface CompactOptions {
  /** Wait for budget × 1.15, then drop to budget × 0.7. */
  hysteresis?: boolean
  /** Who reads the trim notice: an agent run (default) or a conversation,
   *  which gets chatTrimNotice (GH #201). */
  notice?: 'agent' | 'chat'
}

export function compactMessages(
  messages: OllamaChatMessage[],
  maxTokens: number,
  opts: CompactOptions = {},
): OllamaChatMessage[] {
  return compactMessagesWithCount(messages, maxTokens, opts).messages
}

/**
 * compactMessages, and how many of the older messages it left out. The count
 * is what the chat shows under an answer whose request was trimmed (GH #201),
 * so nobody has to guess from a token counter that turns were dropped.
 * `shortened` is 1 when the pinned first user message went out capped: it is
 * not counted as dropped, and without the count it was cut without a word.
 */
export function compactMessagesWithCount(
  messages: OllamaChatMessage[],
  maxTokens: number,
  opts: CompactOptions = {},
): { messages: OllamaChatMessage[]; dropped: number; shortened: number } {
  const unchanged = { messages, dropped: 0, shortened: 0 }
  const currentTokens = estimateMessageTokens(messages)
  const triggerTokens = opts.hysteresis ? Math.floor(maxTokens * COMPACT_TRIGGER_RATIO) : maxTokens
  const targetTokens = opts.hysteresis ? Math.floor(maxTokens * COMPACT_TARGET_RATIO) : maxTokens

  // Already within budget — BOTH budgets. A history that fits the token
  // window but exceeds the message-count ceiling still has to shrink.
  if (currentTokens <= triggerTokens && messages.length <= MAX_SEND_MESSAGES) return unchanged

  // Separate system prompt (always kept). A stray system message deeper in
  // the history that is only an old trim notice is dropped outright here:
  // strict Jinja chat templates raise on any mid-conversation system message
  // ("System message must be at the beginning", Discord #bug-reports
  // 2026-08-21), so one may never survive a compaction round.
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
  const nonSystem = (systemMsg ? messages.slice(1) : [...messages]).filter(
    (m) => !(m.role === 'system' && typeof m.content === 'string' && trimNoticeRe().test(m.content)),
  )

  // If we have fewer messages than KEEP_RECENT, can't compact further
  if (nonSystem.length <= KEEP_RECENT) return unchanged

  const systemTokens = systemMsg ? estimateMessageTokens([systemMsg]) : 0
  const budget = Math.max(0, targetTokens - systemTokens)

  // Cap oversized TOOL RESULTS before fitting the suffix. KEEP_RECENT below
  // keeps the newest messages even when they exceed the budget — without this
  // cap a single giant file_read result rode along VERBATIM in every request
  // (live 2026-07-26: ~225k-token prompts against a 6.5k trim target, every
  // iteration slow and expensive). Only tool results are capped; user and
  // assistant text is never touched. The cap adapts to the budget (chars ≈
  // tokens × 4), floored so tiny budgets still keep a useful head+tail.
  const perResultCap = Math.max(4000, Math.min(32000, Math.floor(budget * 4 * 0.35)))
  // GH #167: the cap is a token budget spelled in Latin characters. A
  // Japanese result carries about three times the tokens per character, so
  // its character cap shrinks by its own density; ASCII keeps exactly 4.
  const capped = nonSystem.map((m) => {
    if (!isToolResultMessage(m) || typeof m.content !== 'string') return m
    const cap = Math.floor((perResultCap * charsPerToken(m.content)) / 4)
    return m.content.length > cap ? { ...m, content: truncateToolResult(m.content, cap) } : m
  })

  // Pin the TASK (audit C5). The oldest message is the user's actual
  // instruction, and the suffix window is precisely the mechanism that drops
  // it first — after which a 30-minute run works on whatever the recent tool
  // results imply instead of what was asked. Keep the first user message
  // (capped) out of the drop zone, alongside the system prompt.
  const firstUserIdx = capped.findIndex((m) => m.role === 'user')
  // Strip an earlier round's trim notice BEFORE capping, so the notice this
  // round appends below never stacks and never gets sliced apart by the cap.
  const rawTask =
    firstUserIdx >= 0 && typeof capped[firstUserIdx].content === 'string'
      ? stripTrimNotice(capped[firstUserIdx].content)
      : null
  const pinnedTask =
    rawTask !== null
      ? {
          ...capped[firstUserIdx],
          content:
            rawTask.length > PINNED_TASK_MAX_CHARS
              ? truncateToolResult(rawTask, PINNED_TASK_MAX_CHARS)
              : rawTask,
        }
      : null
  const pinnedTokens = pinnedTask ? estimateMessageTokens([pinnedTask]) : 0

  // Accumulate a recent suffix that fits, newest-first. Keep at least
  // KEEP_RECENT messages even when that exceeds budget (recent context is the
  // most valuable), otherwise stop as soon as the next message would overflow.
  // The trim notice rides on top of the window, so its room comes off first.
  // Without the hysteresis (a local chat, GH #201) nothing else leaves slack
  // under the budget, and the notice alone pushed the payload past it.
  const noticeTokens = estimateTokens(opts.notice === 'chat' ? chatTrimNotice(999) : AGENT_NOTICE_SIZE_PROBE) + 8
  const suffixBudget = Math.max(0, budget - pinnedTokens - noticeTokens)
  let kept: OllamaChatMessage[] = []
  if (opts.hysteresis) {
    // 3.1.1: the cut sits on a fixed mark counted from the start of the
    // history (stableCutIndex above), not wherever the target falls counted
    // from the newest message. The rest fills the room up to the budget, and
    // one block further on it is back near the target.
    const sizes = capped.map((m) => estimateMessageTokens([m]))
    const restFrom: number[] = new Array(sizes.length + 1).fill(0)
    for (let i = sizes.length - 1; i >= 0; i--) restFrom[i] = restFrom[i + 1] + sizes[i]
    const room = Math.max(0, maxTokens - systemTokens - pinnedTokens - noticeTokens)
    const maxCut = capped.length - KEEP_RECENT
    const byTokens = stableCutIndex(sizes, stableDropBlock(maxTokens), maxCut, (at) => restFrom[at] <= room)
    // A history of many short messages is over the message count long before
    // it is over any token budget. Its marks are counted in messages, from
    // the start as well, or the cut would fall on "the newest 377" again,
    // one message further on every step (the shape of E8b).
    const overCount = capped.length - COUNT_BUDGET
    const byCount = overCount > 0 ? Math.ceil(overCount / COUNT_DROP_BLOCK) * COUNT_DROP_BLOCK : 0
    kept = capped.slice(Math.min(maxCut, Math.max(byTokens, byCount)))
  } else {
    let used = 0
    for (let i = capped.length - 1; i >= 0; i--) {
      // Count bound first: it holds even where the token check would keep
      // adding, otherwise a many-short-turns history fits every token budget
      // and still trips the proxy's message-count cap.
      if (kept.length >= COUNT_BUDGET) break
      const t = estimateMessageTokens([capped[i]])
      if (used + t > suffixBudget && kept.length >= KEEP_RECENT) break
      kept.unshift(capped[i])
      used += t
    }
  }

  // Drop leading orphan tool results (their tool_call fell outside the window)
  // so strict OpenAI-compatible providers don't reject a result with no call.
  while (kept.length > 0 && isToolResultMessage(kept[0])) {
    kept.shift()
  }

  // The pin is only needed when the first user message did NOT survive into
  // the suffix on its own.
  const pinNeeded = pinnedTask !== null && !kept.includes(capped[firstUserIdx])

  const droppedCount = capped.length - kept.length - (pinNeeded ? 1 : 0)
  let notice: string | null = null
  if (droppedCount > 0 && opts.notice === 'chat') {
    notice = chatTrimNotice(droppedCount)
  } else if (droppedCount > 0) {
    // What was dropped is exactly the record of the work already done, while
    // the pin keeps the instruction alive forever. Measured on the installed
    // build 2026-08-06, Coding + Ollama + hermes, a 30 step plan: the run
    // walked steps 1 to 18, compaction fired, and the very next call was
    // todo_write followed by get_current_time, system_info, process_list,
    // file_list. It had started the plan over from the top, because the only
    // thing it could still see was the plan itself. The owner watching it: "es
    // wiederholt sich die ganze Zeit ... und er sagt immer dasselbe."
    //
    // So the notice carries the trail. Names only, no arguments and no
    // results: it is the cheapest thing that answers "where was I".
    const dropped = capped.slice(0, capped.length - kept.length)
    const done: string[] = []
    for (const m of dropped) done.push(...toolNamesIn(m))
    const omitted = Math.max(0, done.length - DONE_TRAIL_MAX)
    const trail = done.slice(done.length - DONE_TRAIL_MAX)
    const doneLine = done.length
      ? ` Already done in this run, in order${omitted ? ` (${omitted} earlier call${omitted === 1 ? '' : 's'} omitted)` : ''}: ${trail.join(', ')}. Carry on AFTER the last one, do not start the task again from the beginning.`
      : ''

    // Wording matters here: the old notice ("Re-read any file you still need
    // with file_read.") actively FED a re-read loop — every iteration the
    // model was told to read again what it had just read. Keep the honest
    // recovery path but make it single-shot and anti-repeat.
    notice = `[${droppedCount} earlier message${droppedCount === 1 ? ' was' : 's were'} trimmed to fit the context window. The original task still stands. Results you already saw still hold.${doneLine} If a detail is genuinely missing, re-read that specific file once; never repeat a call that already ran.]`
  }

  // The notice used to be its own role:'system' message pushed right here,
  // between the pin and the window. Why that is forbidden, and where it goes
  // instead, is now documented once at attachNoteToUserMaterial above — the
  // written summary of 2.6.8 obeys the identical rule through the same call.
  return {
    messages: attachNoteToUserMaterial<OllamaChatMessage>({
      system: systemMsg,
      pinned: pinNeeded ? pinnedTask : null,
      kept,
      note: notice,
      strip: stripTrimNotice,
    }),
    dropped: Math.max(0, droppedCount),
    shortened: pinNeeded && rawTask !== null && rawTask.length > PINNED_TASK_MAX_CHARS ? 1 : 0,
  }
}

/** The least a shortened turn keeps, in tokens: enough for its start and its end. */
const SHORTENED_TURN_FLOOR = 256

/**
 * What a shortened turn keeps when the same history is sent again and again
 * (3.1.1, support case E8b): the largest rung of a fixed ladder that still
 * fits, each rung half as long again as the one below.
 *
 * Cut to the token, the longest turn of a history that sits at its limit came
 * out a little shorter on every send, and the longest turn is often the first
 * one: the request changed right behind the system prompt and the upstream
 * cache had nothing to hit. On a rung the turn goes out with the same bytes
 * until the history has grown by the whole distance to the next rung down.
 */
export function steadyKeep(exactTokens: number): number {
  let rung = SHORTENED_TURN_FLOOR
  while (rung * 1.5 <= exactTokens) rung = Math.floor(rung * 1.5)
  return rung
}

/**
 * Shorten the longest turns until the payload fits `maxTokens`, keeping the
 * head and the tail of each. Never the system prompt (index 0), and never the
 * message being answered: by default the last one, or whatever `isKept` names.
 * A group round passes `isKept`, because there the last message is usually the
 * speaker before this one, and that is exactly the turn that may be too long.
 *
 * compactMessages only drops whole older messages and always keeps the newest
 * KEEP_RECENT, so one very long answer inside that window rode along whole. In
 * a group round that is the speaker before this one: an 82K-character answer
 * against a 16K model and every later speaker of the round was refused by the
 * engine (T1 2026-10-29, GH #201 follow-up). The person's history keeps the
 * full text; only this request carries the shortened copy.
 */
export function shortenLongTurns<T extends { role: string; content: string }>(
  messages: T[],
  maxTokens: number,
  isKept: (m: T, index: number) => boolean = (_m, i) => i === messages.length - 1,
  opts: { steady?: boolean } = {},
): { messages: T[]; shortened: number } {
  const size = (m: T) => estimateMessageTokens([m as unknown as OllamaChatMessage])
  let total = estimateMessageTokens(messages as unknown as OllamaChatMessage[])
  if (total <= maxTokens) return { messages, shortened: 0 }
  const out = [...messages]
  const touched = new Set<number>()
  const first = out[0]?.role === 'system' ? 1 : 0
  for (let round = 0; round < out.length && total > maxTokens; round++) {
    let at = -1
    let largest = SHORTENED_TURN_FLOOR
    for (let i = first; i < out.length; i++) {
      if (isKept(messages[i], i)) continue
      const t = size(out[i])
      if (t > largest) { largest = t; at = i }
    }
    if (at < 0) break
    const exact = Math.max(SHORTENED_TURN_FLOOR, largest - (total - maxTokens) - 32)
    const keep = opts.steady ? steadyKeep(exact) : exact
    const text = out[at].content
    const chars = Math.max(200, Math.floor((text.length * keep) / largest) - 40)
    if (chars >= text.length) break
    out[at] = { ...out[at], content: truncateToolResult(text, chars) }
    touched.add(at)
    total = estimateMessageTokens(out as unknown as OllamaChatMessage[])
  }
  return touched.size ? { messages: out, shortened: touched.size } : { messages, shortened: 0 }
}
