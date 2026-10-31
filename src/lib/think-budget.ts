import type { ProviderId } from '../api/providers/types'

/**
 * The think budget: how many tokens a model may spend on reasoning before it
 * has to answer (Discord wish D12).
 *
 * 0 means "auto", which is exactly what every request did before this setting
 * existed: the bundled engine thinks without a limit, Anthropic gets the
 * automatic budget the provider has always computed. Only a number above 0
 * changes anything on the wire.
 *
 * Which backends really take a token budget (read from their sources and API
 * references, 14.10.2026):
 *
 *  - Bundled engine (llama-server b9949, commit 049326a0; unchanged in b11960): per request
 *    `thinking_budget_tokens` on /v1/chat/completions, see
 *    tools/server/server-common.cpp. The server hands it to its reasoning
 *    budget sampler, which forces the end of the thought once the budget is
 *    spent. It only bites on a model whose template has a thinking end tag;
 *    any other model ignores it.
 *  - Anthropic: `thinking.budget_tokens`, at least 1024.
 *
 * And which do not, so the control says so instead of pretending:
 *
 *  - Ollama: `think` is on/off (or low/medium/high on a few models), no count.
 *  - LM Studio and other OpenAI-compatible servers: no budget field we can
 *    rely on. A self-hosted llama.cpp may take the same field as the bundled
 *    engine, but its version is unknown, so it is not claimed.
 *  - OpenAI and the hosted models: `reasoning_effort` rungs only, which is
 *    the effort control beside the Think button.
 */

/** 'engine' and 'anthropic' take a token count, 'none' takes nothing. */
export type ThinkBudgetSupport = 'engine' | 'anthropic' | 'none'

/** Anthropic refuses a smaller `budget_tokens`. */
export const ANTHROPIC_MIN_THINK_BUDGET = 1024

/** Ceiling for a stored value. Larger than any reasoning budget a served model
 *  can use; it only stops a hand-edited store from putting nonsense on the
 *  wire. */
export const THINK_BUDGET_MAX = 1_000_000

/** Step of the number field. */
export const THINK_BUDGET_STEP = 256

/** Any stored value as a whole number of tokens, 0 for "auto". */
export function normalizeThinkBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(THINK_BUDGET_MAX, Math.max(0, Math.trunc(value)))
}

/**
 * Whether the backend behind this model slot takes a token budget.
 *
 * The OpenAI-compatible slot holds one backend at a time; only when it is the
 * app's own managed engine is the server version known.
 */
export function thinkBudgetSupport(providerId: ProviderId, managedEngine: boolean): ThinkBudgetSupport {
  if (providerId === 'anthropic') return 'anthropic'
  if (providerId === 'openai' && managedEngine) return 'engine'
  return 'none'
}

/**
 * The count that goes on the wire for this request, or undefined to leave the
 * field out. Only while thinking is really on: with Think off there is no
 * thought to cap, and a budget must never switch thinking on by itself.
 */
export function thinkBudgetForRequest(thinking: boolean | undefined, budget: unknown): number | undefined {
  if (thinking !== true) return undefined
  const n = normalizeThinkBudget(budget)
  return n > 0 ? n : undefined
}

/** The short line under the field: what the number does on THIS backend. */
export function thinkBudgetHint(support: ThinkBudgetSupport, budget: number): string {
  if (support === 'none') return 'Not supported by this backend.'
  if (budget <= 0) {
    // On the engine Auto follows the effort control beside Think (issue 176,
    // lib/local-effort.ts): Low and Medium set a budget, High sets none.
    return support === 'anthropic'
      ? 'Auto: the app picks a budget from Max tokens.'
      : 'Auto: follows the effort setting. Low 1024, Medium 4096, High no limit.'
  }
  if (support === 'anthropic' && budget < ANTHROPIC_MIN_THINK_BUDGET) {
    return `Anthropic needs at least ${ANTHROPIC_MIN_THINK_BUDGET}, so ${ANTHROPIC_MIN_THINK_BUDGET} is sent.`
  }
  return 'Thinking stops after this many tokens.'
}
