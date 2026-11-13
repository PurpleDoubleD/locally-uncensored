/**
 * A clean end when a run has to stop (CA U6, C59's open L2).
 *
 * At the step budget or a loop-guard halt LU used to end on a bracketed line
 * ("[Agent halted: …]") and the user had to work out from the tool rows what
 * had been done. Hermes and OpenClaw run one last pass without tools that says
 * what was done, what is open and what comes next. This is that pass: one call,
 * no tools, a short answer, and on any failure the old line stays alone.
 *
 * Not used for the cost brake (another paid call is the opposite of braking)
 * or for Stop (the user asked for silence).
 */
import type { ChatMessage } from '../../api/providers/types'
import { settleThinking } from '../thinking-stripper'
import { stripToolCallTags } from '../../api/hermes-tool-calling'

export const FINISH_PROMPT =
  'Stop here: this run has reached its limit, and no more tools can be called. ' +
  'In at most six short lines, in the language the user wrote in, say what is done, what is still open, ' +
  'and the one next step you would take. No tool calls, no code blocks.'

export const FINISH_TIMEOUT_MS = 90_000

interface Chatty {
  chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: never[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<{ content: string }>
}

/** The summary, or null when the pass failed, timed out or said nothing. */
export async function finishWithoutTools(opts: {
  provider: unknown
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<string | null> {
  if (opts.signal?.aborted) return null
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FINISH_TIMEOUT_MS)
  try {
    const provider = opts.provider as Chatty
    const turn = await provider.chatWithTools(
      opts.model,
      [...opts.messages, { role: 'user', content: FINISH_PROMPT }],
      [],
      { signal: ctrl.signal, maxTokens: 600 },
    )
    const text = stripToolCallTags(settleThinking(turn?.content || '', '', false).content).trim()
    return text || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** How the summary is appended under the halt line. */
export function finishSection(summary: string | null): string {
  return summary ? `\n\n**Where it stopped**\n\n${summary}` : ''
}
