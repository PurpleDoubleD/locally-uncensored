/**
 * @vitest-environment jsdom
 *
 * CA (14.11.2026): nine paying customers lost credits to agent runs nobody
 * watched. A task now pauses at a credit limit and all agent runs together at
 * an hourly one, priced from the model's declared rates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentCostBrake, HOUR_CREDIT_LIMIT, RUN_CREDIT_LIMIT } from '../agent-cost-brake'
import { _resetCreditLedger, hourCredits } from '../agent-core/credit-ledger'

// direct/deepseek-v4.1-flash-like price: a 30k step costs ~600 credits.
const RATES = { inputPerMillion: 20_000, outputPerMillion: 60_000 }

beforeEach(() => _resetCreditLedger())
afterEach(() => _resetCreditLedger())

describe('per task', () => {
  it('a normal step is well under the limit and says nothing', () => {
    const b = new AgentCostBrake({ paid: true, rates: RATES })
    b.record(30_000, { output: 300, billing: 'credits' })
    expect(b.take().action).toBe('ok')
    expect(b.creditsUsed).toBe(618)
  })

  it('tells at half, pauses at the limit, with the amount in credits and euros', () => {
    const b = new AgentCostBrake({ paid: true, rates: RATES, runCreditLimit: 10_000, hourCreditLimit: 0 })
    const seen: string[] = []
    for (let i = 0; i < 40; i++) {
      b.record(30_000, { output: 300, billing: 'credits' })
      const v = b.take()
      if (v.action !== 'ok') seen.push(`${v.action}: ${v.message}`)
      if (v.action === 'halt') break
    }
    expect(seen[0]).toMatch(/^warn: This task has used up to \d,000 credits so far \(under 1 €\)\. It pauses at 10,000\./)
    expect(seen[seen.length - 1]).toMatch(/^halt: Paused to protect your credits: this task has used up to 1\d,000 credits \(under 1 €\)/)
    expect(seen[seen.length - 1]).toMatch(/Send "continue"/)
  })

  it('a Flash step on the free allowance costs no credits', () => {
    const b = new AgentCostBrake({ paid: true, rates: RATES, runCreditLimit: 1_000 })
    for (let i = 0; i < 20; i++) b.record(30_000, { output: 300, billing: 'flash' })
    expect(b.creditsUsed).toBe(0)
    expect(b.take().action).toBe('ok')
  })

  it('without a declared price it counts tokens only, as before', () => {
    const b = new AgentCostBrake({ paid: true })
    b.record(30_000, { output: 300 })
    expect(b.creditsUsed).toBe(0)
  })

  it('0 switches the task limit off', () => {
    const b = new AgentCostBrake({ paid: true, rates: RATES, runCreditLimit: 0, hourCreditLimit: 0 })
    for (let i = 0; i < 60; i++) { b.record(30_000, { billing: 'credits' }); expect(b.take().action).toBe('ok') }
  })

  it('the defaults', () => {
    expect(RUN_CREDIT_LIMIT).toBe(100_000)
    expect(HOUR_CREDIT_LIMIT).toBe(250_000)
  })
})

describe('per hour, across runs', () => {
  it('many short runs together pause once, then the user decides', () => {
    const verdicts: string[] = []
    for (let run = 0; run < 20; run++) {
      const b = new AgentCostBrake({ paid: true, rates: RATES, runCreditLimit: 0, hourCreditLimit: 20_000 })
      for (let i = 0; i < 5; i++) {
        b.record(30_000, { billing: 'credits' })
        const v = b.take()
        if (v.action === 'halt') { verdicts.push(`run ${run}`); break }
      }
    }
    expect(verdicts).toHaveLength(1)
    expect(hourCredits()).toBeGreaterThan(20_000)
  })
})
