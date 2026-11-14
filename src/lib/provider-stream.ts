/**
 * Consume one provider.chatStream turn into the same result shape that
 * chatWithTools returns, while feeding live callbacks along the way.
 *
 * This is the shared piece of the 2.6.0 streaming normalisation (the owner
 * 2026-07-31): Code and Agent mode used to stream only on the Ollama
 * transport and sat silent on every other provider until the whole call
 * returned. Every transport now goes through chatStream — tool defs travel
 * in ChatOptions.tools, tool-call deltas accumulate inside the provider and
 * arrive on the done chunk.
 *
 * Callbacks receive the CUMULATIVE text first (what the existing UI paths
 * paint directly) and the raw delta second (what the Hermes display filter
 * feeds on). `onToolProgress` hears about a call while its arguments are still
 * arriving, so the run can name it before the done chunk.
 */

import type {
  ChatBilling,
  ChatMessage,
  ChatOptions,
  ProviderClient,
  ToolCall,
  ToolCallProgress,
} from '../api/providers/types'

export interface StreamedProviderTurn {
  content: string
  toolCalls: ToolCall[]
  thinking: string
  promptEvalCount?: number
  evalCount?: number
  /** Of promptEvalCount, served from the upstream's prompt cache. */
  cachedPromptCount?: number
  finishReason?: string
  billing?: ChatBilling
}

/**
 * No watchdog of its own here. Until 30.09.2026 this file wrapped chatStream
 * in a second one (audit A7, 05.08.) that aborted after 300 s without a
 * YIELDED chunk. A provider yields only content, reasoning and the done chunk;
 * tool-call arguments accumulate inside it without a yield. A long file_write
 * on a native model therefore looked stalled while its bytes were still
 * flowing, and the run died with "Stream stalled" in the middle of the write
 * (customer case a user: 43 aborted requests, the run ended, "continue"
 * repeated the step). Dead lines are caught where the bytes are: readChunks in
 * api/stream-idle.ts, which every provider reads through since 31.08.
 */
export async function streamProviderTurn(
  provider: ProviderClient,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  onContent?: (full: string, delta: string) => void,
  onThinking?: (full: string, delta: string) => void,
  onToolProgress?: (progress: ToolCallProgress) => void,
): Promise<StreamedProviderTurn> {
  let content = ''
  let thinking = ''
  const turn: StreamedProviderTurn = { content: '', toolCalls: [], thinking: '' }
  for await (const chunk of provider.chatStream(model, messages, options)) {
    if (chunk.content) {
      content += chunk.content
      onContent?.(content, chunk.content)
    }
    if (chunk.thinking) {
      thinking += chunk.thinking
      onThinking?.(thinking, chunk.thinking)
    }
    if (chunk.toolProgress) onToolProgress?.(chunk.toolProgress)
    if (chunk.done) {
      if (chunk.toolCalls?.length) turn.toolCalls = chunk.toolCalls
      turn.promptEvalCount = chunk.promptEvalCount
      turn.evalCount = chunk.evalCount
      turn.cachedPromptCount = chunk.cachedPromptCount
      turn.finishReason = chunk.finishReason
      turn.billing = chunk.billing
    }
  }
  turn.content = content
  turn.thinking = thinking
  return turn
}
