/**
 * The auto-compact decision — one place, one answer (2.6.8, Compact step 1).
 *
 * Everything needed to make this call already existed and was already correct;
 * what was missing was the call itself. `computeContextFill` (token-usage.ts)
 * gives the numerator and says how trustworthy it is; `useActiveContextWindow`
 * gives the denominator and says whether it is the model's real, confirmed
 * window or a fallback. Nothing read either of those two flags. This module is
 * the reader.
 *
 * Leaf module by contract: no React, no network, no store. Every input is a
 * number or a flag the caller already holds, so the whole decision unit-tests
 * without a renderer and without a backend — the same shape as send-window.ts
 * and context-window.ts, which it sits beside.
 *
 * ── OPT-IN, AND WHY THAT IS THE WHOLE DESIGN ───────────────────────────────
 *
 * Owner decision, 2026-09-02: "einstellbar sonst aus". There is deliberately
 * NO default threshold. Without one, `shouldCompact` is false forever and this
 * module changes nothing about how the app behaves — the mechanical trim in
 * context-compaction.ts keeps running exactly as it does today, and it stays
 * the safety net underneath.
 *
 * That is not timidity, it is what makes the feature supportable: auto-compact
 * replaces conversation history with a model's summary of it. When the summary
 * is wrong the user loses work, and they lose it silently. A feature with that
 * failure mode earns its default-on only after the field says it works.
 *
 * ── THE CONFIDENCE MARGIN ──────────────────────────────────────────────────
 *
 * A threshold is a claim about a ratio, and the ratio is only as good as its
 * two halves. Both halves can be estimates, and — this is the part that
 * matters — BOTH of their errors point the same way:
 *
 *   - The numerator under-reads. `estimateTokens` is `chars / 4`, calibrated
 *     on English prose. Code, JSON, tool results and non-English text all
 *     tokenize denser than that, so the estimate says "less" than the truth.
 *   - The denominator over-reads. A window that is not `isTrue` is a fallback
 *     guess, and the fallbacks in useActiveContextWindow (the model's
 *     advertised max, DEFAULT_CONTEXT_CAP, 8192) are all ceilings, not floors.
 *
 * A ratio built from a low numerator and a high denominator is low. So on the
 * least reliable inputs, a 0.8 threshold is really being applied at something
 * above 0.8 of the actual window — which is the one direction that must not
 * happen, because past the actual window there is no compaction any more,
 * there is a truncated prompt or a 400.
 *
 * Hence the margin: the shakier the inputs, the earlier the effective
 * threshold. The margins are NOT stacked. A numerator estimate and a window
 * guess are two symptoms of the same situation (a local backend that has not
 * reported anything yet), and adding them would put a user's 0.8 at 0.6 —
 * far enough off the setting that the number in Settings would stop meaning
 * anything. The worst single margin applies.
 */

/** Where the fill number came from. Mirrors ContextFill['source']. */
export type FillSource = 'built' | 'usage' | 'estimate'

/**
 * Margin subtracted from the user's threshold, by how much the numerator can
 * be trusted.
 *
 *  - `built`: the number IS the payload the builder last built — decay, plan
 *    pruning and compaction included. Nothing to correct for.
 *  - `usage` + real: anchored on the model's own reported promptTokens, with
 *    only the tail since that turn estimated. A small correction covers the
 *    tail.
 *  - `usage` + estimated: anchored on a provisional usage the agent path
 *    wrote, i.e. an estimate wearing a usage's clothes.
 *  - `estimate`: chars/4 over the whole visible conversation, nothing else.
 */
export const MARGIN_BUILT = 0
export const MARGIN_USAGE_REAL = 0.03
export const MARGIN_USAGE_ESTIMATED = 0.08
export const MARGIN_ESTIMATE = 0.12

/** Margin for a denominator that is a fallback rather than the live window. */
export const MARGIN_WINDOW_GUESSED = 0.08

/**
 * Floor for the effective threshold. A user may set a low threshold on
 * purpose; the margin must not turn a deliberate 0.3 into a 0.18 that
 * compacts a conversation that has barely started.
 */
export const MIN_EFFECTIVE_THRESHOLD = 0.25

/** Bounds of a threshold the UI may hand in. Outside these it reads as off. */
export const MIN_THRESHOLD = 0.3
export const MAX_THRESHOLD = 0.95

/**
 * Fewer messages than this and there is nothing worth summarizing: the
 * mechanical suffix window keeps KEEP_RECENT (4) untouched anyway, so a
 * summary would be written about at most a handful of turns and would very
 * likely be longer than what it replaced.
 */
export const MIN_MESSAGES_TO_COMPACT = 8

/**
 * Messages that must arrive after a compaction before another one may fire.
 *
 * Without this, a conversation whose ratio stays above the threshold even
 * AFTER summarizing — one giant tool result is enough — compacts on every
 * single turn: a summary of a summary of a summary, each one paid for, each
 * one further from what actually happened. It is the same failure the
 * mechanical path solved with COMPACT_TRIGGER_RATIO / COMPACT_TARGET_RATIO
 * hysteresis, in the currency this decision is denominated in (messages, not
 * tokens), because that is what the caller can count without rebuilding the
 * request.
 */
export const MIN_MESSAGES_SINCE_COMPACT = 6

export interface CompactTriggerInput {
  /** computeContextFill().used — tokens the next request will carry. */
  used: number
  /** The honest denominator: ctx.sendWindow, else ctx.contextWindow. */
  window: number
  /** computeContextFill().source. */
  source: FillSource
  /** computeContextFill().real — the usage anchor was not itself an estimate. */
  real: boolean
  /** ctx.isTrue — the window is the live one, not a fallback. */
  windowIsTrue: boolean
  /** Messages in the conversation right now. */
  messageCount: number
  /**
   * settings.autoCompactThreshold. Undefined, 0, or outside
   * [MIN_THRESHOLD, MAX_THRESHOLD] means the feature is off.
   */
  threshold?: number
  /**
   * Messages in the conversation at the last compaction, if there was one.
   * Undefined = never compacted.
   */
  lastCompactAtMessageCount?: number
}

export type CompactTriggerReason =
  | 'off'          // no usable threshold — the opt-in was never taken
  | 'no-window'    // denominator not resolved yet; a ratio would be a fiction
  | 'too-short'    // nothing worth summarizing
  | 'cooldown'     // compacted too recently
  | 'below'        // under the effective threshold
  | 'over'         // fire

export interface CompactTriggerResult {
  shouldCompact: boolean
  /** used / window, or 0 when there is no window. Uncapped, so it may exceed 1. */
  ratio: number
  /** The threshold after the confidence margin — what `ratio` was compared to. */
  effectiveThreshold: number
  /** The margin that was applied, so the UI can explain an early trigger. */
  margin: number
  reason: CompactTriggerReason
}

/** The margin the numerator's provenance earns. */
export function numeratorMargin(source: FillSource, real: boolean): number {
  if (source === 'built') return MARGIN_BUILT
  if (source === 'usage') return real ? MARGIN_USAGE_REAL : MARGIN_USAGE_ESTIMATED
  return MARGIN_ESTIMATE
}

/**
 * The single margin for this pair of inputs: the worst one, never the sum.
 * See the module head, "THE CONFIDENCE MARGIN".
 */
export function confidenceMargin(input: {
  source: FillSource
  real: boolean
  windowIsTrue: boolean
}): number {
  return Math.max(
    numeratorMargin(input.source, input.real),
    input.windowIsTrue ? 0 : MARGIN_WINDOW_GUESSED,
  )
}

/** A threshold the user actually opted into, or null. */
export function usableThreshold(threshold?: number): number | null {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null
  if (threshold < MIN_THRESHOLD || threshold > MAX_THRESHOLD) return null
  return threshold
}

/**
 * Should this conversation be compacted before the next send?
 *
 * Pure. The caller resolves the numbers (TokenCounter already resolves both of
 * them for its own display) and acts on the answer; nothing here reads or
 * writes anything.
 */
export function shouldAutoCompact(input: CompactTriggerInput): CompactTriggerResult {
  const threshold = usableThreshold(input.threshold)
  const margin = confidenceMargin(input)
  const effectiveThreshold = threshold === null
    ? 0
    : Math.max(MIN_EFFECTIVE_THRESHOLD, threshold - margin)
  const ratio = input.window > 0 ? input.used / input.window : 0
  const no = (reason: CompactTriggerReason): CompactTriggerResult => ({
    shouldCompact: false, ratio, effectiveThreshold, margin, reason,
  })

  if (threshold === null) return no('off')
  // A ratio over a denominator that is still being probed is not a small
  // error, it is a different question. useActiveContextWindow reports 0 until
  // the provider answers, and every consumer already handles that state.
  if (input.window <= 0) return no('no-window')
  if (input.messageCount < MIN_MESSAGES_TO_COMPACT) return no('too-short')
  if (
    input.lastCompactAtMessageCount !== undefined &&
    input.messageCount - input.lastCompactAtMessageCount < MIN_MESSAGES_SINCE_COMPACT
  ) {
    return no('cooldown')
  }
  if (ratio < effectiveThreshold) return no('below')

  return { shouldCompact: true, ratio, effectiveThreshold, margin, reason: 'over' }
}


/**
 * Der Satz "wie weit ist es noch bis zur automatischen Kompaktierung".
 *
 * ── WARUM DAS HIER STEHT UND NICHT IM BAUTEIL ──────────────────────────────
 *
 * Erstens sammelt vitest nur Dateien unter `__tests__` mit der Endung
 * `.test.ts`; was in einer `.tsx` steht, hat keinen Test, der es je
 * ausfuehrt. Zweitens gehoert dieser Text zur Schwelle und nicht zum Balken: er soll spaeter auch in einer
 * Statuszeile und im Compact-Menue auftauchen koennen, ohne dass jemand ihn
 * ein zweites Mal formuliert.
 *
 * ── WARUM DIE WIRKSAME UND NICHT DIE EINGESTELLTE SCHWELLE ─────────────────
 *
 * `shouldAutoCompact` zieht einen Sicherheitsabschlag ab, solange der
 * Fuellstand nur geschaetzt ist. Wer hier die eingestellte Zahl anzeigte,
 * naennte im haeufigsten Fall — kein echter Usage-Report — eine Prozentzahl,
 * bei der nichts passiert. Darum bekommt diese Funktion das fertige URTEIL
 * herein und rechnet nicht selbst.
 */
export function autoCompactHint(verdict: CompactTriggerResult | null): string {
  if (!verdict) return ''
  if (verdict.shouldCompact) return 'Auto-compaction triggers on the next message'
  switch (verdict.reason) {
    case 'off':
      return ''
    case 'cooldown':
      return 'Auto-compaction is on, paused briefly after the last summary'
    case 'too-short':
      return `Auto-compaction is on, but starts only from ${MIN_MESSAGES_TO_COMPACT} messages`
    case 'no-window':
      // Das Fenster wird noch abgefragt. Eine Prozentzahl auf einen Nenner,
      // den niemand kennt, waere eine erfundene Zahl.
      return 'Auto-compaction is on, waiting for the model to report its context window'
    default: {
      // In Prozentpunkten DES FENSTERS, nicht als Anteil der Restspanne:
      // "noch 23 % frei" ist die Zahl, die der Nutzer am Balken wiederfindet.
      const rest = Math.max(0, Math.round((verdict.effectiveThreshold - verdict.ratio) * 100))
      return `${rest}% of the window left before auto-compaction`
    }
  }
}
