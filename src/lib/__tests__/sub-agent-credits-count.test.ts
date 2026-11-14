/**
 * CA, 14.11.2026: a sub-agent (delegate_task) on LU Cloud spent outside both
 * credit limits; only the main loops fed the hour ledger. Its steps now count
 * toward the hour, and past the hour limit it stops with what it found.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { stepCredits } from '../agent-cost-brake'

describe('stepCredits', () => {
  const rates = { inputPerMillion: 100_000, outputPerMillion: 400_000 }
  it('prices a step from the catalogue rates', () => {
    expect(stepCredits(rates, 10_000, 1_000)).toBe(1_000 + 400)
  })
  it('a Flash step and an unknown price cost nothing', () => {
    expect(stepCredits(rates, 10_000, 1_000, 'flash')).toBe(0)
    expect(stepCredits(null, 10_000, 1_000)).toBe(0)
  })
  it('a step without a count costs nothing, never a guess', () => {
    expect(stepCredits(rates, undefined, undefined)).toBe(0)
  })
})

describe('the sub-agent feeds the hour ledger', () => {
  it('after every model step, and stops past the hour limit', () => {
    const src = readFileSync('src/api/agents/sub-agent.ts', 'utf8')
    const call = src.indexOf('const raw = await provider.chatWithTools(modelId, messages')
    const ledger = src.indexOf('addHourCredits(spent)', call)
    expect(ledger).toBeGreaterThan(call)
    expect(src.slice(ledger, ledger + 600)).toMatch(/hour >= limit/)
    expect(src).toMatch(/Paused to protect your credits: agent runs used the hourly limit/)
  })
})

describe('the sub-agent checks its request fits, like the main loops', () => {
  it('fitToWindow runs right before every request, and an overfull one stops with the material', () => {
    const src = readFileSync('src/api/agents/sub-agent.ts', 'utf8')
    const fit = src.indexOf('const fit = fitToWindow(messages, ctx,')
    const call = src.indexOf('const raw = await provider.chatWithTools(modelId, sendThese')
    expect(fit).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(fit)
    expect(src).toMatch(/Stopped: what this sub-agent gathered no longer fits the model's context window\./)
  })
})
