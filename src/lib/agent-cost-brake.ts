import type { CreditRates } from '../api/providers/types'
import { HOSTED_CREDITS_PER_EUR } from './cloud-pitch'
import { addHourCredits, creditFactor, hourPauseDue, markHourPause } from './agent-core/credit-ledger'
/**
 * Cost brake for one agent run (C83).
 *
 * A support case, 10.11.2026, LU Cloud direct/deepseek-v4.1-flash: 233 tool calls
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
 *    on from here. Since 3.1.2 (A38, GitHub #256) the limit is a setting
 *    (2M, 5M, 10M, No limit), and the sentence speaks of credits only on
 *    LU Cloud; with the user's own key it is their API budget.
 *
 * Only providers that bill (isPaidProvider) are braked; a model on this
 * machine or in the LAN costs nothing per token. The loop guard switch (C44,
 * Settings → Agent Permissions) is respected: with the guard off, the token
 * limit never ends a run, it only says once that it has been passed. The two
 * credit limits are not tied to that switch (CA, 15.11.2026): they have their
 * own "No limit" in Settings → Agent, and a guard switched off against false
 * loop stops must not also switch off the pause that protects the credits.
 */

// CA (14.11.2026): 400k and 3M let the incidents of that week through. The
// send cap keeps a paid step at 32k now, so a step past 64k is unusual and
// worth a word, and 2M input per run is ~60 full steps at the cap.
export const LARGE_REQUEST_TOKENS = 64_000
export const RUN_HALT_TOKENS = 2_000_000
/**
 * 3.1.2 (A38, GitHub #256): the choices of Settings → Agent → Agent
 * Permissions for the token limit per run. 0 is "No limit". The limit used to
 * be fixed at 2M, which also stopped long runs on a provider with the user's
 * own key, where LU has no credits to protect.
 */
export const RUN_HALT_CHOICES: readonly number[] = [RUN_HALT_TOKENS, 5_000_000, 10_000_000, 0]

/**
 * Credits (CA, 14.11.2026). Where the model's catalogue entry declares its
 * credit price (LU Cloud), every step is priced from the tokens the backend
 * reported: an upper bound, because cached input is billed for less and the
 * app does not learn by how much. One task may use up to RUN_CREDIT_LIMIT
 * before it pauses and asks; all agent runs together up to HOUR_CREDIT_LIMIT
 * in a rolling hour. Half of the run limit gets a visible notice.
 * For scale: a Hosted plan carries 900,000 credits a month.
 */
export const RUN_CREDIT_LIMIT = 100_000
export const HOUR_CREDIT_LIMIT = 250_000

/** Loaded lazily: the quota client pulls in the cloud API. */
export function wireCloudSpent(): void {
  void import('./agent-core/cloud-spent').then((m) => m.ensureCloudSpentReader()).catch(() => {})
}

export type CostBrakeVerdict =
  | { action: 'ok' }
  | { action: 'warn'; message: string }
  | { action: 'halt'; reason: string; message: string }

const fmtCredits = (n: number): string => (Math.round(n / 1000) * 1000).toLocaleString('en-US')
const euros = (credits: number): string => {
  const e = credits / HOSTED_CREDITS_PER_EUR
  return e < 1 ? 'under 1 €' : `about ${e < 10 ? e.toFixed(1) : Math.round(e)} €`
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

export class AgentCostBrake {
  private readonly paid: boolean
  private readonly mayHalt: boolean
  private readonly largeAt: number
  private readonly haltAt: number
  private readonly luCloud: boolean
  private sum = 0
  private calls = 0
  private largeWarned = false
  private sumWarned = false
  private pending: CostBrakeVerdict = { action: 'ok' }
  private readonly rates: CreditRates | null
  private readonly runCreditLimit: number
  private readonly hourCreditLimit: number
  private credits = 0
  private halfWarned = false

  constructor(opts: {
    paid: boolean
    loopGuardEnabled?: boolean
    largeRequestTokens?: number
    /** 0 switches the token limit off (3.1.2, A38). */
    runHaltTokens?: number
    /** The run is billed by LU Cloud in credits. Off: the user's own key or
     *  another provider, and the halt speaks of an API budget instead. */
    luCloud?: boolean
    /** The model's declared credit price (LU Cloud catalogue). */
    rates?: CreditRates | null
    /** 0 switches the credit limit off. */
    runCreditLimit?: number
    hourCreditLimit?: number
  }) {
    this.paid = opts.paid
    this.mayHalt = opts.loopGuardEnabled !== false
    this.largeAt = opts.largeRequestTokens ?? LARGE_REQUEST_TOKENS
    const halt = opts.runHaltTokens ?? RUN_HALT_TOKENS
    this.haltAt = Number.isFinite(halt) && halt > 0 ? halt : Number.POSITIVE_INFINITY
    this.luCloud = opts.luCloud === true
    this.rates = opts.rates && opts.rates.inputPerMillion >= 0 && opts.rates.outputPerMillion >= 0 ? opts.rates : null
    this.runCreditLimit = opts.runCreditLimit ?? RUN_CREDIT_LIMIT
    this.hourCreditLimit = opts.hourCreditLimit ?? HOUR_CREDIT_LIMIT
    // A declared credit price means LU Cloud: let the ledger ask the server
    // what the steps really cost. Unit tests wire their own reader.
    if (this.paid && this.rates && import.meta.env?.MODE !== 'test') wireCloudSpent()
  }

  /** Credits this run used so far, upper bound; 0 without a declared price. */
  get creditsUsed(): number {
    return Math.round(this.credits)
  }

  /** Input tokens summed over this run so far, as reported by the backend. */
  get inputTokens(): number {
    return this.sum
  }

  /**
   * One model call's reported input. A call without a count adds nothing:
   * the brake never guesses, the same rule as the usage line under an answer.
   */
  record(promptTokens: number | undefined, extra: { output?: number; billing?: 'flash' | 'credits' } = {}): void {
    if (!this.paid) return
    const n = typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens > 0 ? Math.round(promptTokens) : 0
    if (n === 0) return
    this.sum += n
    this.calls++
    // Credits, where the price is known and the step was billed in credits
    // (a Flash step on the free allowance costs none).
    if (this.rates && extra.billing !== 'flash') {
      const out = typeof extra.output === 'number' && extra.output > 0 ? extra.output : 0
      const step = (n * this.rates.inputPerMillion + out * this.rates.outputPerMillion) / 1_000_000
      // At the price the server really charged lately (creditFactor, 1 until
      // it has been asked, see credit-ledger.ts), so the pause comes at the
      // limit and not at half of it.
      this.credits += step * creditFactor()
      const hour = addHourCredits(step)
      if (this.runCreditLimit > 0 && this.credits >= this.runCreditLimit) {
        this.pending = {
          action: 'halt',
          reason: `cost brake: this task used up to ${fmtCredits(this.credits)} credits in ${this.calls} steps (limit ${fmtCredits(this.runCreditLimit)})`,
          message:
            `Paused to protect your credits: this task has used up to ${fmtCredits(this.credits)} credits (${euros(this.credits)}) in ${this.calls} steps. ` +
            'Send "continue" to go on with the next ' + fmtCredits(this.runCreditLimit) + ', or change the limit in Settings → Agent.',
        }
        return
      }
      if (this.hourCreditLimit > 0 && hour >= this.hourCreditLimit && hourPauseDue()) {
        markHourPause()
        this.pending = {
          action: 'halt',
          reason: `cost brake: agent runs used up to ${fmtCredits(hour)} credits in the last hour (limit ${fmtCredits(this.hourCreditLimit)})`,
          message:
            `Paused to protect your credits: agent runs have used up to ${fmtCredits(hour)} credits (${euros(hour)}) in the last hour. ` +
            'Send "continue" to go on; the next pause comes in an hour at the earliest. The limit is in Settings → Agent.',
        }
        return
      }
      if (this.runCreditLimit > 0 && !this.halfWarned && this.credits >= this.runCreditLimit / 2) {
        this.halfWarned = true
        this.pending = {
          action: 'warn',
          message: `This task has used up to ${fmtCredits(this.credits)} credits so far (${euros(this.credits)}). It pauses at ${fmtCredits(this.runCreditLimit)}.`,
        }
      }
    }
    if (this.sum >= this.haltAt) {
      if (this.mayHalt) {
        this.pending = {
          action: 'halt',
          reason: `cost brake: this run sent ${fmtTokens(this.sum)} tokens of input in ${this.calls} model calls (limit ${fmtTokens(this.haltAt)})`,
          message:
            `Stopped to protect your ${this.luCloud ? 'credits' : 'API budget'}: this run has sent ${fmtTokens(this.sum)} tokens to the model in ${this.calls} steps, ` +
            `the latest step alone ${fmtTokens(n)}. Every step re-reads the whole conversation, so long runs get expensive fast. ` +
            'Send a new message to go on, or start a new chat to begin with a small context. ' +
            'The token limit per run is in Settings → Agent → Agent Permissions.',
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

/**
 * What one model step costs in credits, where the price is known and the step
 * was billed in credits; 0 otherwise. For loops that have no brake of their
 * own (the sub-agent), so their spending still counts toward the hour.
 */
export function stepCredits(
  rates: { inputPerMillion: number; outputPerMillion: number } | null | undefined,
  promptTokens: number | undefined,
  outputTokens: number | undefined,
  billing?: 'flash' | 'credits',
): number {
  if (!rates || billing === 'flash') return 0
  const n = typeof promptTokens === 'number' && promptTokens > 0 ? promptTokens : 0
  const out = typeof outputTokens === 'number' && outputTokens > 0 ? outputTokens : 0
  return (n * rates.inputPerMillion + out * rates.outputPerMillion) / 1_000_000
}
