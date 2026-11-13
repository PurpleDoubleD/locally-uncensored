/**
 * Cost brake for one agent run (C83).
 *
 * tid2110, 10.11.2026, LU Cloud direct/deepseek-v4.1-flash: 233 tool calls
 * in one run, one every ~4 s, and every single request carried 420-447k
 * tokens of input. Around 214k credits were gone before the user looked.
 * The loop guard now catches near-copies of the same call (detector 8), but
 * a run can also burn money with calls that honestly differ. This brake
 * looks only at what the backend REPORTED the run sent, whatever the calls
 * were:
 *
 *  - One request at or above LARGE_REQUEST_TOKENS gets a notice once per run:
 *    each further step re-reads that much again.
 *  - The run's summed input reaching RUN_HALT_TOKENS ends the run, with a
 *    plain sentence that says how much it sent and that a new message goes
 *    on from here.
 *
 * Only providers that bill (isPaidProvider) are braked; a model on this
 * machine or in the LAN costs nothing per token. The loop guard switch (C44,
 * Settings → Agent Permissions) is respected: with the guard off, the brake
 * never ends a run, it only says once that the limit has been passed.
 */

export const LARGE_REQUEST_TOKENS = 400_000
export const RUN_HALT_TOKENS = 3_000_000

export type CostBrakeVerdict =
  | { action: 'ok' }
  | { action: 'warn'; message: string }
  | { action: 'halt'; reason: string; message: string }

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

export class AgentCostBrake {
  private readonly paid: boolean
  private readonly mayHalt: boolean
  private readonly largeAt: number
  private readonly haltAt: number
  private sum = 0
  private calls = 0
  private largeWarned = false
  private sumWarned = false
  private pending: CostBrakeVerdict = { action: 'ok' }

  constructor(opts: { paid: boolean; loopGuardEnabled?: boolean; largeRequestTokens?: number; runHaltTokens?: number }) {
    this.paid = opts.paid
    this.mayHalt = opts.loopGuardEnabled !== false
    this.largeAt = opts.largeRequestTokens ?? LARGE_REQUEST_TOKENS
    this.haltAt = opts.runHaltTokens ?? RUN_HALT_TOKENS
  }

  /** Input tokens summed over this run so far, as reported by the backend. */
  get inputTokens(): number {
    return this.sum
  }

  /**
   * One model call's reported input. A call without a count adds nothing:
   * the brake never guesses, the same rule as the usage line under an answer.
   */
  record(promptTokens: number | undefined): void {
    if (!this.paid) return
    const n = typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens > 0 ? Math.round(promptTokens) : 0
    if (n === 0) return
    this.sum += n
    this.calls++
    if (this.sum >= this.haltAt) {
      if (this.mayHalt) {
        this.pending = {
          action: 'halt',
          reason: `cost brake: this run sent ${fmtTokens(this.sum)} tokens of input in ${this.calls} model calls (limit ${fmtTokens(this.haltAt)})`,
          message:
            `Stopped to protect your credits: this run has sent ${fmtTokens(this.sum)} tokens to the model in ${this.calls} steps, ` +
            `the latest step alone ${fmtTokens(n)}. Every step re-reads the whole conversation, so long runs get expensive fast. ` +
            'Send a new message to go on, or start a new chat to begin with a small context.',
        }
        return
      }
      if (!this.sumWarned) {
        this.sumWarned = true
        this.pending = {
          action: 'warn',
          message:
            `This run has now sent ${fmtTokens(this.sum)} tokens to the model in ${this.calls} steps. ` +
            'The loop guard is switched off, so it keeps going until you press Stop.',
        }
        return
      }
    }
    if (n >= this.largeAt && !this.largeWarned) {
      this.largeWarned = true
      this.pending = {
        action: 'warn',
        message:
          `Large request: this step sent ${fmtTokens(n)} tokens to the model. Every further step sends about as much again, ` +
          'and that is what you pay for. A new chat, or Compact, makes the next steps much cheaper.',
      }
    }
  }

  /** The verdict since the last take(), then cleared. Halt stays sticky. */
  take(): CostBrakeVerdict {
    const v = this.pending
    if (v.action !== 'halt') this.pending = { action: 'ok' }
    return v
  }
}
