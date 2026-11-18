/**
 * 3.1.2, A38 (GitHub #256): an agent run on an OpenAI compatible provider with
 * the user's own key stopped at 2M tokens "to protect your credits", and there
 * was no way to raise the limit. The limit is a setting now (2M by default,
 * 5M, 10M, No limit), both agent loops pass it, and the stop names credits only
 * where LU Cloud bills them.
 *
 * Run: npx vitest run src/lib/__tests__/a38-run-token-limit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentCostBrake, RUN_HALT_CHOICES, RUN_HALT_TOKENS } from '../agent-cost-brake'
import { isPaidProvider } from '../send-window'
import { lockedRule } from '../settings-catalog'

const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', '..', ...p), 'utf8')

/** Steps of 100k until the brake halts; the number of steps, or -1. */
function stepsUntilHalt(b: AgentCostBrake, max = 400): number {
  for (let i = 1; i <= max; i++) {
    b.record(100_000)
    if (b.take().action === 'halt') return i
  }
  return -1
}

function haltMessage(b: AgentCostBrake): string {
  for (let i = 0; i < 400; i++) {
    b.record(100_000)
    const v = b.take()
    if (v.action === 'halt') return v.message
  }
  throw new Error('never halted')
}

describe('A38: the token limit per run', () => {
  it('offers 2M (default), 5M, 10M and No limit', () => {
    expect(RUN_HALT_TOKENS).toBe(2_000_000)
    expect(RUN_HALT_CHOICES).toEqual([2_000_000, 5_000_000, 10_000_000, 0])
  })

  it('without a setting a run stops at 2M, as in 3.1.1', () => {
    expect(stepsUntilHalt(new AgentCostBrake({ paid: true }))).toBe(20)
    expect(stepsUntilHalt(new AgentCostBrake({ paid: true, runHaltTokens: undefined }))).toBe(20)
  })

  it('an own value moves the stop', () => {
    expect(stepsUntilHalt(new AgentCostBrake({ paid: true, runHaltTokens: 5_000_000 }))).toBe(50)
    expect(stepsUntilHalt(new AgentCostBrake({ paid: true, runHaltTokens: 10_000_000 }))).toBe(100)
  })

  it('No limit never stops a run and never warns about the sum', () => {
    const b = new AgentCostBrake({ paid: true, runHaltTokens: 0 })
    const actions: string[] = []
    for (let i = 0; i < 300; i++) {
      b.record(30_000)
      actions.push(b.take().action)
    }
    expect(b.inputTokens).toBe(9_000_000)
    expect(actions).not.toContain('halt')
    expect(actions).not.toContain('warn')
  })

  it('the loop guard switch still works as before: off, the limit only warns', () => {
    const b = new AgentCostBrake({ paid: true, loopGuardEnabled: false, runHaltTokens: 5_000_000 })
    expect(stepsUntilHalt(b, 80)).toBe(-1)
  })

  it('an own key on an OpenAI compatible slot is still braked, at the chosen limit', () => {
    expect(isPaidProvider('openai-experientiallabs')).toBe(true)
    expect(isPaidProvider('openai-experientiallabs', true)).toBe(false)
  })
})

describe('A38: the stop speaks of credits only on LU Cloud', () => {
  it('LU Cloud: credits', () => {
    const msg = haltMessage(new AgentCostBrake({ paid: true, luCloud: true }))
    expect(msg).toMatch(/^Stopped to protect your credits: this run has sent 2\.0M tokens/)
    expect(msg).toContain('Settings → Agent → Agent Permissions')
  })

  it('own key or another provider: the API budget, and where the setting is', () => {
    const msg = haltMessage(new AgentCostBrake({ paid: true, luCloud: false }))
    expect(msg).toMatch(/^Stopped to protect your API budget: this run has sent 2\.0M tokens/)
    expect(msg).not.toContain('credits')
    expect(msg).toContain('The token limit per run is in Settings → Agent → Agent Permissions.')
  })

  it('left out, the provider is not LU Cloud', () => {
    expect(haltMessage(new AgentCostBrake({ paid: true }))).toContain('your API budget')
  })
})

describe('A38: the wiring', () => {
  for (const file of ['useAgentChat.ts', 'useCodex.ts']) {
    it(`${file} passes the setting and the provider to the brake`, () => {
      const src = read('hooks', file)
      const at = src.indexOf('new AgentCostBrake({')
      expect(at).toBeGreaterThan(-1)
      const call = src.slice(at, src.indexOf('})', at))
      expect(call).toContain('runHaltTokens: useSettingsStore.getState().settings.agentRunHaltTokens')
      expect(call).toContain("luCloud: providerId === 'lu-cloud'")
    })
  }

  it('the setting sits right after the credit limits in Agent Permissions', () => {
    const page = read('components', 'settings', 'SettingsPage.tsx')
    const credit = page.indexOf('<CreditLimitSettings />')
    const tokens = page.indexOf('<RunTokenLimitSettings />')
    expect(credit).toBeGreaterThan(page.indexOf('<Section title="Agent Permissions">'))
    expect(tokens).toBeGreaterThan(credit)
    expect(page.slice(credit, tokens).trim()).toBe('<CreditLimitSettings />')
  })

  it('the agent can never raise its own token limit', () => {
    expect(lockedRule('agentRunHaltTokens')?.category).toBe('spending')
  })
})
