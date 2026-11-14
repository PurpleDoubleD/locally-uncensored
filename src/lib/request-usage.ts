import type { Message, RequestUsage } from '../types/chat'
import type { ChatBilling } from '../api/providers/types'
import { useChatStore } from '../stores/chatStore'
import { FLASH_MARK_LABEL } from './flash-entitlement'

/**
 * Tokens per answer, the line under it and `/usage`.
 *
 * Discord 22.10.2026 (#general): "Whats the cmd to see how much tokens was
 * used in the previous request?" The app had the numbers and showed none of
 * them: `message.usage` is the context counter's anchor and keeps only the
 * LAST model call of an answer, which is right for "how full is the window"
 * and wrong for "what did this request take". An agent answer makes several
 * calls, each one reads the whole prompt again, and the request took their
 * sum. So the sum lives in its own field, `message.requestUsage`.
 *
 * Only what a backend reported counts: Ollama's prompt_eval_count/eval_count,
 * usage.prompt_tokens/completion_tokens of an OpenAI compatible server (LU
 * Engine, LU Cloud, LM Studio), Anthropic's input/output tokens. A call
 * without numbers adds nothing, and an answer without any shows no line.
 * There is no estimate here on purpose: a char/4 guess under an answer reads
 * like a meter reading.
 *
 * Credits: the app does not learn what an answer cost. LU Cloud books it on
 * the server (cache, upstream cost) and sends only how it billed the request
 * (`x-lu-chat-billing`). So a Flash answer on the free allowance says
 * "No credits", the same word as the model picker, and a credit answer says
 * that it used credits without inventing an amount.
 */

/** What one model call reports. */
export interface CallCounts {
  promptEvalCount?: number
  evalCount?: number
  cachedPromptCount?: number
  billing?: ChatBilling
}

const count = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0

/**
 * Adds one call to the running sum of a request. Returns `prev` unchanged
 * when the call reported nothing, so a caller can skip the store write.
 */
export function addCallUsage(prev: RequestUsage | undefined, call: CallCounts): RequestUsage | undefined {
  const input = count(call.promptEvalCount)
  const output = count(call.evalCount)
  const reported = input > 0 || output > 0
  if (!reported && !call.billing) return prev
  const base: RequestUsage = prev ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
  const billing: ChatBilling | undefined =
    base.billing === 'credits' || call.billing === 'credits' ? 'credits' : (call.billing ?? base.billing)
  const cached = Math.min(count(call.cachedPromptCount), input)
  const cachedSum = (base.cachedTokens ?? 0) + cached
  return {
    inputTokens: base.inputTokens + input,
    outputTokens: base.outputTokens + output,
    calls: base.calls + (reported ? 1 : 0),
    ...(billing ? { billing } : {}),
    ...(cachedSum > 0 ? { cachedTokens: cachedSum } : {}),
  }
}

/**
 * One request's sum, written onto its answer after every call that reported.
 * Made fresh per request, so a regenerate or a new agent run never adds onto
 * the numbers of the previous one.
 */
export function requestUsageTracker(conversationId: string, messageId: string): { add: (call: CallCounts) => void } {
  let sum: RequestUsage | undefined
  return {
    add(call) {
      const next = addCallUsage(sum, call)
      if (next === sum || !next) return
      sum = next
      useChatStore.getState().updateMessageRequestUsage(conversationId, messageId, next)
    },
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US')

/** The small line under an answer, and its title. Null when there is nothing real to say. */
export function requestUsageLine(u: RequestUsage | undefined): { text: string; title: string } | null {
  if (!u) return null
  const parts: string[] = []
  const notes: string[] = []
  if (u.calls > 0) {
    parts.push(`${fmt(u.inputTokens)} in`, `${fmt(u.outputTokens)} out`)
    notes.push(
      `Tokens for this answer, as reported by the model: ${fmt(u.inputTokens)} in (prompt with system prompt, tools and history), ${fmt(u.outputTokens)} out.`,
    )
    if (u.calls > 1) notes.push(`Summed over ${u.calls} model calls.`)
    // CA (14.11.2026): what the backend served from its prompt cache. On a
    // long agent run that is most of the input, and it is billed at a
    // fraction; a run that shows none is paying full price on every step.
    if (u.cachedTokens && u.inputTokens > 0) {
      const pct = Math.round((u.cachedTokens / u.inputTokens) * 100)
      parts.push(`${pct}% cached`)
      notes.push(`${fmt(u.cachedTokens)} of the input tokens came from the model's prompt cache.`)
    }
  }
  if (u.billing === 'flash') {
    parts.push(FLASH_MARK_LABEL)
    notes.push('Flash model on your plan: this answer used no credits.')
  } else if (u.billing === 'credits') {
    parts.push('Credits')
    notes.push('This answer used credits.')
  }
  if (parts.length === 0) return null
  return { text: parts.join(' · '), title: notes.join(' ') }
}

/**
 * What `/usage` says: the newest answer in this chat, in a sentence. App
 * notices (`role: 'system'`) and hidden tool turns are not answers.
 */
export function lastRequestUsageNotice(messages: Message[]): string {
  // `modelId` marks a model's answer; a /goal confirmation is an assistant
  // line the app wrote and carries none.
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && !m.hidden && (m.modelId || m.requestUsage))
  if (!last) return 'No answer in this chat yet, so there is no token count to show.'
  const u = last.requestUsage
  if (!u || (u.calls === 0 && !u.billing)) {
    return 'The last answer has no token count. Its backend did not report one, or the answer is from before 3.0.8.'
  }
  const bits: string[] = []
  if (u.calls > 0) {
    bits.push(`Last answer: ${fmt(u.inputTokens)} tokens in, ${fmt(u.outputTokens)} tokens out`
      + (u.calls > 1 ? `, summed over ${u.calls} model calls.` : '.'))
  } else {
    bits.push('Last answer: the backend reported no token count.')
  }
  if (u.billing === 'flash') bits.push(`${FLASH_MARK_LABEL}: a Flash model on your plan.`)
  else if (u.billing === 'credits') bits.push('It used credits.')
  return bits.join(' ')
}
