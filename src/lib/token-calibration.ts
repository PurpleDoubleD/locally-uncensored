/**
 * The run's own count, held against the model's (CA, 14.11.2026).
 *
 * The agent loops size every step with an estimate (characters per token,
 * lib/token-estimate.ts). The context meter shows what the model reported,
 * when it reports. On code, logs and JSON the estimate reads low; a local
 * tokenizer can count a fifth more. David saw a local 27B in Agent mode at
 * about 31K of a 32K window with no compaction and no answer: the loop had
 * built against 80 % of the window by its own count (about 26K), so it never
 * saw a reason to compact, and the model, given about 1K for its answer, spent
 * that thinking.
 *
 * So after every step the loop holds the estimate it sent against the real
 * prompt count the backend reported, and divides its budgets by the ratio for
 * the steps after: the trigger, the trim and the last check then measure in the
 * model's own tokens. Only upward (an estimate that reads high is safe), and at
 * most double (a count from a backend that reports something else entirely
 * must not starve the run).
 */
export const MAX_CALIBRATION = 2

export class TokenCalibration {
  private ratio = 1

  /** One step: what the loop estimated it sent, and what the backend counted. */
  observe(estimated: number, real: number | undefined | null): void {
    if (!(typeof real === 'number' && real > 0 && estimated > 0)) return
    this.ratio = Math.min(MAX_CALIBRATION, Math.max(1, real / estimated))
  }

  /** Real tokens per estimated token, 1 until a step reported. */
  get factor(): number {
    return this.ratio
  }

  /** A budget in real tokens, as the estimate has to read it. */
  budget(tokens: number): number {
    return tokens > 0 ? Math.max(1, Math.floor(tokens / this.ratio)) : tokens
  }
}
