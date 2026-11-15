/**
 * CA (13./14.11.2026): the wiring of the night's fixes in the two agent loops,
 * plus the small helpers they use. Behaviour of each piece has its own test;
 * this file keeps the pieces connected.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { billingOf, creditRatesOf } from '../agent-core/credit-rates'
import { useModelStore } from '../../stores/modelStore'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const AGENT = read('../../hooks/useAgentChat.ts')
const CODE = read('../../hooks/useCodex.ts')

describe('Code tab: no <think> request on top of a catalogue reasoner', () => {
  it('the tag request needs a model without its own thinkMode', () => {
    const at = CODE.indexOf('reason through your thinking inside <think></think> tags')
    const cond = CODE.slice(CODE.lastIndexOf('if (settings.thinkingEnabled', at), at)
    expect(cond).toMatch(/codexThinkMode\(activeModel\) === undefined/)
  })
})

describe('the cost brake in both loops', () => {
  for (const [name, src] of [['Agent', AGENT], ['Code', CODE]] as const) {
    it(`${name}: priced from the model, limits from settings, billing per step`, () => {
      expect(src).toMatch(/rates: creditRatesOf\(activeModel\)/)
      expect(src).toMatch(/runCreditLimit: useSettingsStore\.getState\(\)\.settings\.agentRunCreditLimit/)
      expect(src).toMatch(/hourCreditLimit: useSettingsStore\.getState\(\)\.settings\.agentHourCreditLimit/)
      expect(src).toMatch(/costBrake\.record\(turn\.promptEvalCount, \{ output: turn\.evalCount, billing: billingOf\(turn\) \}\)/)
    })
    it(`${name}: a warning and a pause also show above the chat`, () => {
      expect((src.match(/show\('cost-brake', brake\.message, 'ruhig'\)/g) ?? []).length).toBe(2)
    })
  }
})

describe('creditRatesOf / billingOf', () => {
  beforeEach(() => useModelStore.setState({ models: [] } as never))

  it('reads the declared price, null without one', () => {
    useModelStore.setState({ models: [
      { name: 'lu-cloud::x', creditRates: { inputPerMillion: 20_000, outputPerMillion: 60_000 } },
      { name: 'openai::local' },
    ] } as never)
    expect(creditRatesOf('lu-cloud::x')).toEqual({ inputPerMillion: 20_000, outputPerMillion: 60_000 })
    expect(creditRatesOf('openai::local')).toBeNull()
    expect(creditRatesOf(null)).toBeNull()
  })

  it('billing only as LU Cloud spells it', () => {
    expect(billingOf({ billing: 'flash' })).toBe('flash')
    expect(billingOf({ billing: 'credits' })).toBe('credits')
    expect(billingOf({ billing: 'free' })).toBeUndefined()
    expect(billingOf(null)).toBeUndefined()
  })
})
