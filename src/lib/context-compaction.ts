/**
 * Context Compaction — prevents "Failed to fetch" from context window exhaustion.
 *
 * Strategy (from Claude Code / Claw Code pattern):
 * - Keep the last N messages intact (recent context matters most)
 * - Summarize older messages into compact one-liners
 * - Tool call + result pairs become: "Used tool_name('args') → result_snippet"
 * - Token estimation via heuristic: text.length / 4
 */

import { getModelContext } from '../api/ollama'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
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

    if (providerId === 'openai' || providerId === 'anthropic') {
      // Use provider's getContextLength for cloud models
      const { provider, modelId } = getProviderForModel(modelName)
      return await provider.getContextLength(modelId)
    }

    // Ollama: use existing endpoint
    return await getModelContext(modelName)
  } catch {
    return 4096
  }
}

// ── Message Compaction ──────────────────────────────────────────

const KEEP_RECENT = 4 // Always keep the last N messages untouched

/**
 * Compact a message array to fit within a token budget.
 *
 * - If already within budget, returns messages unchanged.
 * - Otherwise, keeps the system prompt + last KEEP_RECENT messages,
 *   and summarizes everything in between.
 */
export function compactMessages(
  messages: OllamaChatMessage[],
  maxTokens: number
): OllamaChatMessage[] {
  const currentTokens = estimateMessageTokens(messages)

  // Already within budget
  if (currentTokens <= maxTokens) return messages

  // Separate system prompt (always kept)
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null
  const nonSystem = systemMsg ? messages.slice(1) : [...messages]

  // If we have fewer messages than KEEP_RECENT, can't compact further
  if (nonSystem.length <= KEEP_RECENT) return messages

  // Split: old messages (to compact) + recent messages (to keep)
  const oldMessages = nonSystem.slice(0, -KEEP_RECENT)
  const recentMessages = nonSystem.slice(-KEEP_RECENT)

  // Summarize old messages
  const summary = summarizeMessages(oldMessages)

  // Build compacted array
  const compacted: OllamaChatMessage[] = []

  if (systemMsg) compacted.push(systemMsg)

  // Insert summary as a system-level context message
  if (summary) {
    compacted.push({
      role: 'system',
      content: `[Previous conversation summary]\n${summary}`,
    })
  }

  // Keep recent messages intact
  compacted.push(...recentMessages)

  return compacted
}

// ── Message Summarization ───────────────────────────────────────

/**
 * Summarize a sequence of messages into a compact string.
 * Tool call + result pairs become one-liners.
 */
function summarizeMessages(messages: OllamaChatMessage[]): string {
  const lines: string[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'user') {
      // User message → short summary
      const content = msg.content.trim()
      if (content.length > 0 && !content.startsWith('<tool_response>')) {
        lines.push(`User asked: ${truncate(content, 80)}`)
      }
    } else if (msg.role === 'assistant') {
      // Check if this is a tool call (next message might be 'tool' or contains tool_response)
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Native tool call
        for (const tc of msg.tool_calls) {
          const toolName = tc.function?.name || 'unknown'
          const args = JSON.stringify(tc.function?.arguments || {})
          const argsShort = truncate(args, 60)

          // Look ahead for the tool result
          const nextMsg = messages[i + 1]
          if (nextMsg && (nextMsg.role === 'tool' || nextMsg.role === 'user')) {
            const resultShort = truncate(nextMsg.content, 80)
            lines.push(`Used ${toolName}(${argsShort}) → ${resultShort}`)
            i++ // skip the result message
          } else {
            lines.push(`Called ${toolName}(${argsShort})`)
          }
        }
      } else if (msg.content.includes('<tool_call>')) {
        // Hermes XML tool call
        const match = msg.content.match(/"name"\s*:\s*"([^"]+)"/)
        const toolName = match?.[1] || 'tool'
        const nextMsg = messages[i + 1]
        if (nextMsg?.content?.includes('<tool_response>')) {
          const resultShort = truncate(nextMsg.content.replace(/<\/?tool_response>/g, ''), 80)
          lines.push(`Used ${toolName} → ${resultShort}`)
          i++
        } else {
          lines.push(`Called ${toolName}`)
        }
      } else if (msg.content.trim().length > 0) {
        // Regular assistant message
        lines.push(`Assistant: ${truncate(msg.content, 100)}`)
      }
    } else if (msg.role === 'tool') {
      // Standalone tool result (shouldn't happen if paired above, but just in case)
      lines.push(`Tool result: ${truncate(msg.content, 80)}`)
    }

    i++
  }

  return lines.join('\n')
}

function truncate(text: string, maxLen: number): string {
  const cleaned = text.replace(/\n/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen - 3) + '...'
}
