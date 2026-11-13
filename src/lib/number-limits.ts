/**
 * Upper bounds for the number fields whose value travels straight into a
 * request or a run (Jaeger B, B9 and B13). Before, the Settings fields took
 * any whole number: 999999999 in "Context window (Ollama)" went out as
 * num_ctx, which asks Ollama or the LU Engine to reserve a KV cache of that
 * size, and a sub-agent could get 99999999 tool calls although it runs
 * unattended. The same numbers bound set_setting from the chat
 * (lib/settings-catalog.ts), so the field, the chat command and the request
 * agree.
 *
 * 0 keeps its meaning everywhere: auto, model default, or "use the default".
 */

/** num_ctx: 1M tokens, above the largest context any local model ships with. */
export const CONTEXT_WINDOW_MAX = 1_048_576
/** Longest answer in tokens. */
export const MAX_TOKENS_MAX = 1_000_000
/** Tool calls or steps of one sub-agent. */
export const SUB_AGENT_LIMIT_MAX = 1_000

/** A whole number from 0 to `max`; anything not a positive number is 0. */
export function clampCount(value: unknown, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(max, Math.floor(n))
}

export const clampContextWindow = (v: unknown): number => clampCount(v, CONTEXT_WINDOW_MAX)
export const clampMaxTokens = (v: unknown): number => clampCount(v, MAX_TOKENS_MAX)
export const clampSubAgentLimit = (v: unknown): number => clampCount(v, SUB_AGENT_LIMIT_MAX)
