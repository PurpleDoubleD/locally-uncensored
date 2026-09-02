/**
 * Context Compaction — prevents "Failed to fetch" from context window exhaustion.
 *
 * Strategy:
 * - Keep the last N messages intact (recent context matters most)
 * - Summarize older messages into compact one-liners
 * - Tool call + result pairs become: "Used tool_name('args') → result_snippet"
 * - Token estimation via heuristic: text.length / 4
 */

import { getModelContextCached } from '../api/ollama'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { useModelStore } from '../stores/modelStore'
import { truncateToolResult } from './truncate-tool-result'
import type { OllamaChatMessage } from '../types/agent-mode'

// ── Token Estimation ────────────────────────────────────────────

/**
 * Rough token estimate. Ollama models typically tokenize ~4 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1
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

    if (providerId === 'openai' || providerId === 'anthropic') {
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

// ── Message Compaction ──────────────────────────────────────────

export const KEEP_RECENT = 4 // Always keep at least the last N messages untouched

/** Hard ceiling on how many messages one request may carry, independent of
 * tokens. The LU Cloud proxy rejects anything above 400 messages, and a chat
 * of many SHORT turns sits under every token budget while the count keeps
 * growing — the token-only compaction never fired and the chat hard-400ed on
 * every send, permanently (yaserrieh, 2026-08-21: "[network] HTTP 400 too
 * many messages" after ~7 coding tasks in one chat). 380 mirrors the web
 * app's MAX_SEND_MESSAGES and leaves room for the pin and the trim notice. */
export const MAX_SEND_MESSAGES = 380

/** Suffix quota inside compactMessages: system prompt, pinned task and trim
 * notice ride on top of the kept window, so the window itself stays 3 short
 * of the ceiling. */
const COUNT_BUDGET = MAX_SEND_MESSAGES - 3

/** How much of the pinned first user message survives compaction. Enough for
 * any real instruction; a pasted 200 KB file does not ride along forever. */
const PINNED_TASK_MAX_CHARS = 8000

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
  /\s*\[\d+ earlier messages? (?:was|were) trimmed to fit the context window\.[^\]]*\]\s*/g

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
 * message must be at the beginning" (platorius, Discord #bug-reports
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
  const kept = rest.slice(-(max - sys.length))
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

export interface CompactOptions {
  /** Wait for budget × 1.15, then drop to budget × 0.7. */
  hysteresis?: boolean
}

export function compactMessages(
  messages: OllamaChatMessage[],
  maxTokens: number,
  opts: CompactOptions = {},
): OllamaChatMessage[] {
  const currentTokens = estimateMessageTokens(messages)
  const triggerTokens = opts.hysteresis ? Math.floor(maxTokens * COMPACT_TRIGGER_RATIO) : maxTokens
  const targetTokens = opts.hysteresis ? Math.floor(maxTokens * COMPACT_TARGET_RATIO) : maxTokens

  // Already within budget — BOTH budgets. A history that fits the token
  // window but exceeds the message-count ceiling still has to shrink.
  if (currentTokens <= triggerTokens && messages.length <= MAX_SEND_MESSAGES) return messages

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
  if (nonSystem.length <= KEEP_RECENT) return messages

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
  const capped = nonSystem.map((m) =>
    isToolResultMessage(m) && typeof m.content === 'string' && m.content.length > perResultCap
      ? { ...m, content: truncateToolResult(m.content, perResultCap) }
      : m,
  )

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
  const suffixBudget = Math.max(0, budget - pinnedTokens)
  const kept: OllamaChatMessage[] = []
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
  if (droppedCount > 0) {
    // What was dropped is exactly the record of the work already done, while
    // the pin keeps the instruction alive forever. Measured on the installed
    // build 2026-08-06, Coding + Ollama + hermes, a 30 step plan: the run
    // walked steps 1 to 18, compaction fired, and the very next call was
    // todo_write followed by get_current_time, system_info, process_list,
    // file_list. It had started the plan over from the top, because the only
    // thing it could still see was the plan itself. David watching it: "es
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
  return attachNoteToUserMaterial<OllamaChatMessage>({
    system: systemMsg,
    pinned: pinNeeded ? pinnedTask : null,
    kept,
    note: notice,
    strip: stripTrimNotice,
  })
}
