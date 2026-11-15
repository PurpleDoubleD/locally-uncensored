/**
 * The model's own reasoning goes back with its tool calls (CA, cloud loops,
 * 13.11.2026).
 *
 * Users report cloud models that call the same tool again and again. One root
 * cause sat in the wire format: all three agent loops kept the reasoning of a
 * step only for the screen and sent the assistant turn back with content and
 * tool_calls alone. The reasoners on LU Cloud (GLM 5.x, DeepSeek V3.2/V4,
 * Kimi K3, Qwen 3.x) are built for interleaved thinking: their chat templates
 * render `reasoning_content` of the assistant turns after the last user
 * message, so the model continues from its own plan after a tool result.
 * DeepSeek's thinking-with-tools mode even requires it (its API answers 400
 * without it, api-docs.deepseek.com/guides/thinking_mode), and Z.AI's GLM
 * keeps a plan across tool calls only when the reasoning comes back
 * unchanged (docs.z.ai/guides/capabilities/thinking-mode). Without it every
 * step starts with no memory of why the last call was made, and re-reading
 * the same file is the rational move.
 *
 * What goes back: the reasoning of the steps of the run that is going, never
 * that of earlier user turns (history rebuilt from the store carries none, and
 * the templates drop it there anyway). Capped per step: a model that thought
 * for 100k characters must not turn every later request into a 100k-character
 * input bill. The END of the reasoning is kept, because that is where the
 * decision is.
 *
 * Only providers that ask for it send the field (ProviderConfig
 * `replayReasoning`, set by LU Cloud). An unknown message field is not
 * something every OpenAI-compatible server forgives.
 */

/** Per step, in characters (about 3k tokens). */
export const REPLAY_REASONING_CHARS = 12_000

/** The reasoning of one step as it goes back, or undefined when there is none. */
export function replayableReasoning(text: string | undefined | null): string | undefined {
  const t = (text ?? '').trim()
  if (!t) return undefined
  if (t.length <= REPLAY_REASONING_CHARS) return t
  return '[…]\n' + t.slice(t.length - REPLAY_REASONING_CHARS)
}
