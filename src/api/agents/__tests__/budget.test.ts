import { describe, it, expect } from 'vitest'
import { AgentBudget, budgetFromSettings } from '../budget'

describe('AgentBudget', () => {
  it('starts clean: exceeded() = none', () => {
    const b = new AgentBudget({ maxToolCalls: 10, maxIterations: 5 })
    expect(b.exceeded().kind).toBe('none')
    expect(b.haltMessage()).toBe('')
  })

  it('detects tool-call cap hit', () => {
    const b = new AgentBudget({ maxToolCalls: 3, maxIterations: 100 })
    b.addToolCalls(3)
    const ex = b.exceeded()
    expect(ex.kind).toBe('tool_calls')
    if (ex.kind === 'tool_calls') {
      expect(ex.used).toBe(3)
      expect(ex.cap).toBe(3)
    }
    expect(b.haltMessage()).toMatch(/tool-call budget reached/)
  })

  it('detects iteration cap hit (iterations checked first)', () => {
    const b = new AgentBudget({ maxToolCalls: 100, maxIterations: 2 })
    b.addIteration()
    b.addIteration()
    expect(b.exceeded().kind).toBe('iterations')
    expect(b.haltMessage()).toMatch(/iteration cap/)
  })

  it('iteration cap reported when both would trigger', () => {
    const b = new AgentBudget({ maxToolCalls: 1, maxIterations: 1 })
    b.addToolCalls(5)
    b.addIteration()
    // Iteration cap is checked first by design — halts early on deeper runs.
    expect(b.exceeded().kind).toBe('iterations')
  })

  it('addToolCalls accumulates across batches', () => {
    const b = new AgentBudget({ maxToolCalls: 5, maxIterations: 100 })
    b.addToolCalls(2)
    b.addToolCalls(2)
    expect(b.exceeded().kind).toBe('none')
    b.addToolCalls(1)
    expect(b.exceeded().kind).toBe('tool_calls')
  })

  it('ignores zero and negative additions', () => {
    const b = new AgentBudget({ maxToolCalls: 1, maxIterations: 100 })
    b.addToolCalls(0)
    b.addToolCalls(-5)
    expect(b.exceeded().kind).toBe('none')
  })

  it('cap = 0 means unlimited', () => {
    const b = new AgentBudget({ maxToolCalls: 0, maxIterations: 0 })
    b.addToolCalls(10_000)
    for (let i = 0; i < 50; i++) b.addIteration()
    expect(b.exceeded().kind).toBe('none')
  })

  it('snapshot reports current usage + caps', () => {
    const b = new AgentBudget({ maxToolCalls: 10, maxIterations: 5 })
    b.addToolCalls(3)
    b.addIteration()
    const snap = b.snapshot()
    expect(snap).toEqual({
      toolCalls: 3,
      iterations: 1,
      caps: { maxToolCalls: 10, maxIterations: 5 },
    })
  })

  it('budgetFromSettings reads the two relevant fields', () => {
    const b = budgetFromSettings({ agentMaxToolCalls: 7, agentMaxIterations: 3 })
    b.addToolCalls(7)
    expect(b.exceeded().kind).toBe('tool_calls')
  })
})
