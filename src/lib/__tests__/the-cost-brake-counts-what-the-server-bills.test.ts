/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  _resetCreditLedger, addHourCredits, creditFactor, hourCredits, reconcileNow, setSpentReader, FACTOR_FLOOR, RECONCILE_EVERY,
} from '../agent-core/credit-ledger'
import { AgentCostBrake } from '../agent-cost-brake'

// CA bench, Kimi K2.6 on LU Cloud, 14.11.2026: the hour counted 1.6–2.7× what
// the server billed (cached input is cheaper, and the server hides the cache
// fields), so the brake paused at about half its limit.

const T0 = 1_800_000_000_000
let spent: number | null
const reader = async () => spent

beforeEach(() => {
  _resetCreditLedger()
  spent = 50_000
})

describe('the hour reconciles with the server', () => {
  it('counts what the server billed once it has been asked', async () => {
    setSpentReader(reader)
    await reconcileNow(T0) // baseline 50,000
    addHourCredits(3_000, T0 + 1_000)
    addHourCredits(3_000, T0 + 2_000) // 6,000 estimated, at full price
    spent = 53_000 // the server billed half
    await reconcileNow(T0 + 3_000)
    expect(hourCredits(T0 + 4_000)).toBeCloseTo(3_000, 0)
    expect(creditFactor()).toBeCloseTo(0.5, 5)
    // The next steps are priced at the measured factor.
    addHourCredits(2_000, T0 + 5_000)
    expect(hourCredits(T0 + 6_000)).toBeCloseTo(4_000, 0)
  })

  it('stays at full price without an answer', async () => {
    setSpentReader(async () => null)
    await reconcileNow(T0)
    addHourCredits(12_000, T0 + 1_000)
    await reconcileNow(T0 + 2_000)
    expect(creditFactor()).toBe(1)
    expect(hourCredits(T0 + 3_000)).toBe(12_000)
  })

  it('stays at full price when the request fails', async () => {
    setSpentReader(async () => { throw new Error('offline') })
    addHourCredits(12_000, T0)
    await reconcileNow(T0 + 1_000)
    expect(creditFactor()).toBe(1)
    expect(hourCredits(T0 + 2_000)).toBe(12_000)
  })

  it('takes no measurement when the counter goes backwards (top-up, new month)', async () => {
    setSpentReader(reader)
    await reconcileNow(T0)
    addHourCredits(12_000, T0 + 1_000)
    spent = 10_000
    await reconcileNow(T0 + 2_000)
    expect(creditFactor()).toBe(1)
    expect(hourCredits(T0 + 3_000)).toBe(12_000)
  })

  it('brakes earlier, never later, when the server billed more', async () => {
    setSpentReader(reader)
    await reconcileNow(T0)
    addHourCredits(5_000, T0 + 1_000)
    spent = 57_500 // a chat in between: 7,500 for 5,000 estimated
    await reconcileNow(T0 + 2_000)
    expect(hourCredits(T0 + 3_000)).toBeCloseTo(7_500, 0)
    expect(creditFactor()).toBeCloseTo(1.5, 5)
  })

  it('never prices a step below the floor', async () => {
    setSpentReader(reader)
    await reconcileNow(T0)
    addHourCredits(5_000, T0 + 1_000)
    spent = 50_100 // implausibly cheap: a lagging counter
    await reconcileNow(T0 + 2_000)
    expect(creditFactor()).toBe(FACTOR_FLOOR)
    expect(hourCredits(T0 + 3_000)).toBeCloseTo(5_000 * FACTOR_FLOOR, 0)
  })

  it('a lowering leaves the hour with the steps it lowered', async () => {
    setSpentReader(reader)
    await reconcileNow(T0)
    addHourCredits(6_000, T0 + 1_000)
    spent = 53_000
    await reconcileNow(T0 + 30 * 60_000)
    // An hour after the step, step and correction are both gone; a new step
    // counts in full, not lowered by a correction that outlived its step.
    addHourCredits(1_000, T0 + 61 * 60_000)
    expect(hourCredits(T0 + 61 * 60_000)).toBeCloseTo(1_000 * creditFactor(), 0)
  })

  it('asks the server on its own every RECONCILE_EVERY estimated credits', async () => {
    let asked = 0
    setSpentReader(async () => { asked++; return spent })
    addHourCredits(1, T0) // first step: asks for the baseline
    await Promise.resolve(); await Promise.resolve()
    addHourCredits(RECONCILE_EVERY - 10, T0 + 1)
    expect(asked).toBe(1)
    addHourCredits(20, T0 + 2)
    await Promise.resolve(); await Promise.resolve()
    expect(asked).toBe(2)
  })
})

describe('the per-task limit uses the measured price', () => {
  it('pauses at the limit, not at half of it', async () => {
    setSpentReader(reader)
    await reconcileNow(T0)
    addHourCredits(5_000)
    spent = 52_500
    await reconcileNow()
    expect(creditFactor()).toBeCloseTo(0.5, 5)
    // 1M input tokens at 10 credits per million = 10 credits full price, 5 measured.
    const brake = new AgentCostBrake({ paid: true, rates: { inputPerMillion: 10_000, outputPerMillion: 0 }, runCreditLimit: 15_000, hourCreditLimit: 0, runHaltTokens: 1e12 })
    brake.record(1_000_000) // 10,000 full price → 5,000
    brake.record(1_000_000) // → 10,000
    expect(brake.take().action).not.toBe('halt')
    brake.record(1_000_000) // → 15,000
    expect(brake.take().action).toBe('halt')
  })
})
