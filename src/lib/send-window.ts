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
import { isCompatProviderId } from '../api/providers/compat-id'

/**
 * Providers where a token sent is a token billed.
 *
 * `openai` is on this list because that is the slot api.openai.com sits in. It
 * is also the slot a llama.cpp on 127.0.0.1:8080, a vLLM in the LAN, LM Studio
 * and this app's own engine sit in, because `ProviderId` is a fixed set of
 * four and every OpenAI-protocol backend shares one of them. So the id alone
 * cannot answer the cost question for this entry, and `localBackend` is what
 * finishes it: where the send goes to a machine on this network, nobody is
 * billed and there is nothing to cap. The classification itself is NOT
 * repeated here as a second list; it lives in lib/lan-openai-slot.ts, which is
 * the same answer the context window uses (GH #129).
 */
export const PAID_PROVIDER_IDS: ReadonlySet<string> = new Set(['lu-cloud', 'openai', 'anthropic'])

/**
 * Default ceiling for one sent step, in tokens. Power users may raise it.
 *
 * 64k until 3.0.4. A long Code-tab run rides that ceiling on every step, and
 * on a model without a prompt cache every one of those tokens is sent, and
 * paid for, again on every step. With the age
 * decay capping old results and the run ledger keeping the dropped steps
 * known, 32k carries a coding run at half the price per step.
 */
export const DEFAULT_SEND_WINDOW_TOKENS = 32768

/** The pre-3.0.4 default. No UI ever wrote this setting, so a stored 64000 is
 *  the old default riding along in a profile, not anyone's choice. */
export const RETIRED_SEND_WINDOW_DEFAULT = 64000

/** The share of the model window a step was already limited to before 2.6.6. */
export const WINDOW_SHARE = 0.8

/** Small-Model Mode keeps its own, much tighter profile (Knob 4). */
export const SMALL_MODEL_SHARE = 0.5
export const SMALL_MODEL_CEILING = 6000

/**
 * The send window setting for one model: the user's per-model pick from the
 * context dropdown, else the global default. Every caller of
 * effectiveSendWindow reads it through here, so the counter, the request
 * builder and /compact always agree on the same number.
 */
export function sendWindowFor(
  settings: { codexSendWindowTokens?: number; cloudSendWindowByModel?: Record<string, number> },
  model: string,
): number | undefined {
  const pick = settings.cloudSendWindowByModel?.[model]
  if (typeof pick === 'number' && pick > 0) return Math.floor(pick)
  return settings.codexSendWindowTokens
}

export interface SendWindowInput {
  /** Provider id of the active model ('lu-cloud', 'ollama', …). */
  providerId: string
  /** The context window the loop resolved for this model (num_ctx). */
  modelWindow: number
  /** settings.codexSendWindowTokens. */
  sendWindowTokens?: number
  /** settings.contextDecay. Ignored for the cap since CA (14.11.2026): a paid
   *  provider is always capped, decay on or off. Kept so callers need not
   *  change. */
  capEnabled?: boolean
  /** settings.smallModelMode. */
  smallModelMode?: boolean
  /**
   * The send goes to a server on this machine or in the LAN
   * (`sendsToALanBackend` in lib/lan-openai-slot). Only the `openai` slot can
   * be either; left out, the provider id decides alone, which is what every
   * caller did before 3.0.0.
   */
  localBackend?: boolean
}

export function isPaidProvider(providerId: string, localBackend?: boolean): boolean {
  // A server in the next room bills nobody, whichever protocol it speaks.
  if (localBackend === true) return false
  // An extra OpenAI-compatible slot (`openai-<slug>`) is a hosted API with
  // the user's own key unless `localBackend` already said otherwise above.
  return PAID_PROVIDER_IDS.has(providerId) || isCompatProviderId(providerId)
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
  if (!isPaidProvider(input.providerId, input.localBackend)) return base
  // The decay switch (`capEnabled`) no longer lifts the cap on a provider
  // that bills (CA, 14.11.2026). Turning decay off means "do not shorten old
  // results", and it had silently also meant "send the whole history on every
  // step, however long": the support logs of that week show runs sending
  // 120-278k tokens per step on LU Cloud, every one of them paid in full. A
  // run that wants more than the cap per step picks it per model in the
  // context menu, where the price per step is shown.
  void input.capEnabled
  const cap =
    typeof input.sendWindowTokens === 'number' && input.sendWindowTokens > 0
      ? Math.floor(input.sendWindowTokens)
      : DEFAULT_SEND_WINDOW_TOKENS
  return Math.min(base, cap)
}

/** What the messages of a step are left with at the very least, however large the catalogue is. */
export const MIN_MESSAGE_BUDGET = 4096

/**
 * The budget of the messages once the tool catalogue has its place. The
 * catalogue is sent as a field of its own, so the estimate of the messages
 * never sees it; without this a full history plus the catalogue is more than
 * the window. Never below `MIN_MESSAGE_BUDGET`, and never above the budget
 * that came in.
 */
export function budgetBesideTheCatalog(sendWindow: number, catalogTokens: number): number {
  const catalog = Number.isFinite(catalogTokens) && catalogTokens > 0 ? Math.ceil(catalogTokens) : 0
  return Math.min(sendWindow, Math.max(MIN_MESSAGE_BUDGET, sendWindow - catalog))
}
