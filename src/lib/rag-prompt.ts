/**
 * The retrieval block, built in one place.
 *
 * Plain chat (hooks/useChat) and Agent mode (hooks/useAgentChat) each carried
 * their own copy of this string. Two copies of a prompt are two prompts as soon
 * as one of them is edited, and A9 needed a third caller to prove the block
 * reaches a CLOUD request, so it moves here.
 *
 * It is a suffix, not a prefix, on purpose: the retrieved chunks are the most
 * volatile thing in the prompt (every turn pulls different ones). At byte 0 they
 * pushed an upstream prefix cache, which matches from the first byte and stops
 * at the first difference, off the ENTIRE prompt on every RAG turn. Behind
 * persona, memory and caveman, everything a cache could match stays
 * byte-identical from turn to turn (plan A5).
 *
 * Provider-independent by construction: the result is appended to the system
 * message, and a system message is the one thing Ollama, the built-in engine,
 * LM Studio and LU Cloud all take. That is why Document Chat works in Cloud
 * mode at all.
 */

export const RAG_INSTRUCTION =
  "Use the following document context to help answer the user's question. " +
  'If the context is not relevant, ignore it and answer normally.'

/**
 * @param chunks the retrieved passages, already ranked and cut to the budget
 * @returns the suffix to append to the system prompt, or '' when there is
 *   nothing to say. Empty in, empty out: a turn without a hit must not spend
 *   tokens on an instruction pointing at no context.
 */
export function buildRagSuffix(chunks: { content: string }[]): string {
  if (!chunks || chunks.length === 0) return ''
  const contextBlock = chunks
    .map((c, i) => `[Source ${i + 1}]\n${c.content}`)
    .join('\n\n')
  return `\n\n${RAG_INSTRUCTION}\n\n---\n${contextBlock}\n---`
}
