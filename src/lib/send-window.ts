/**
 * The window an agent step is allowed to SEND (2.6.6, plan A2).
 *
 * A 262k-context cloud model let the coding loop grow its prompt to whatever
 * the history happened to be: the compaction budget was 0.8 × the model
 * window, so nothing trimmed until 209k tokens, and every step of a long run
 * was billed at that size. The model window is what the model can read; it was
 * never a statement about what a step is worth paying for.
 *
 * So paid providers get a second, tighter ceiling: min(0.8 × model window,
 * codexSendWindowTokens), default 64k. A local backend has no bill on the
 * other end, so it never gets that second ceiling — `effectiveSendWindow`
 * returns the plain 0.8 × window base for it, and always has.
 *
 * What changed in 2.6.8 (Compact-Schritt 2) is not this function, it is who
 * asks it. The chat surfaces used to skip it entirely on a local model; now
 * they apply that base there too, because an overflowing window is a
 * correctness problem and not a billing one. The reasoning sits at the one
 * place that made the call: `chatBudgetApplies` in chat-send-budget.ts.
 *
 * num_ctx is untouched either way, so no model is ever asked to run in a
 * smaller allocation than before (that would only trade money for a trim
 * loop).
 */

/** Providers where a token sent is a token billed. */
export const PAID_PROVIDER_IDS: ReadonlySet<string> = new Set(['lu-cloud', 'openai', 'anthropic'])

/** Default ceiling for one sent step, in tokens. Power users may raise it. */
export const DEFAULT_SEND_WINDOW_TOKENS = 64000

/** The share of the model window a step was already limited to before 2.6.6. */
export const WINDOW_SHARE = 0.8

/** Small-Model Mode keeps its own, much tighter profile (Knob 4). */
export const SMALL_MODEL_SHARE = 0.5
export const SMALL_MODEL_CEILING = 6000

export interface SendWindowInput {
  /** Provider id of the active model ('lu-cloud', 'ollama', …). */
  providerId: string
  /** The context window the loop resolved for this model (num_ctx). */
  modelWindow: number
  /** settings.codexSendWindowTokens. */
  sendWindowTokens?: number
  /** settings.contextDecay. The notaus switches the cap off with the decay. */
  capEnabled?: boolean
  /** settings.smallModelMode. */
  smallModelMode?: boolean
}

export function isPaidProvider(providerId: string): boolean {
  return PAID_PROVIDER_IDS.has(providerId)
}

/**
 * The compaction budget for one step. Identical to the pre-2.6.6 number
 * everywhere the cap does not apply, so a local run cannot change behaviour.
 */
export function effectiveSendWindow(input: SendWindowInput): number {
  const window = Number.isFinite(input.modelWindow) && input.modelWindow > 0 ? input.modelWindow : 0
  const base = input.smallModelMode
    ? Math.floor(Math.min(window * SMALL_MODEL_SHARE, SMALL_MODEL_CEILING))
    : Math.floor(window * WINDOW_SHARE)
  if (input.capEnabled === false) return base
  if (!isPaidProvider(input.providerId)) return base
  const cap =
    typeof input.sendWindowTokens === 'number' && input.sendWindowTokens > 0
      ? Math.floor(input.sendWindowTokens)
      : DEFAULT_SEND_WINDOW_TOKENS
  return Math.min(base, cap)
}
