import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DELEGATE_TASK_TOOL_DEF,
  SUB_AGENT_MAX_DEPTH,
  SUB_AGENT_BUDGET,
  buildDelegateExecutor,
  _getDepth,
  _setDepth,
} from '../sub-agent'

describe('sub-agent — tool definition', () => {
  it('has the expected shape', () => {
    expect(DELEGATE_TASK_TOOL_DEF.name).toBe('delegate_task')
    expect(DELEGATE_TASK_TOOL_DEF.category).toBe('workflow')
    expect(DELEGATE_TASK_TOOL_DEF.source).toBe('builtin')
    expect(DELEGATE_TASK_TOOL_DEF.inputSchema.required).toContain('goal')
  })

  it('description contains the nesting warning', () => {
    expect(DELEGATE_TASK_TOOL_DEF.description).toMatch(/nesting depth is 2/i)
  })
})

describe('sub-agent — buildDelegateExecutor', () => {
  beforeEach(() => {
    _setDepth(0)
  })

  it('rejects calls without a goal argument', async () => {
    const exec = buildDelegateExecutor(async () => 'unreachable')
    const out = await exec({})
    expect(out).toMatch(/requires a "goal" argument/i)
  })

  it('rejects whitespace-only goal', async () => {
    const exec = buildDelegateExecutor(async () => 'unreachable')
    const out = await exec({ goal: '   ' })
    expect(out).toMatch(/requires a "goal" argument/i)
  })

  it('invokes runner with trimmed goal + context + fresh budget', async () => {
    const runner = vi.fn(async (goal: string, context: string, { budget }: any) => {
      expect(goal).toBe('do the thing')
      expect(context).toBe('background notes')
      expect(budget.snapshot()).toEqual({
        toolCalls: 0,
        iterations: 0,
        caps: { ...SUB_AGENT_BUDGET },
      })
      return 'final answer'
    })
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: '  do the thing  ', context: '  background notes  ' })
    expect(out).toBe('final answer')
    expect(runner).toHaveBeenCalledOnce()
  })

  it('depth resets after a successful run', async () => {
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    await exec({ goal: 'x' })
    expect(_getDepth()).toBe(0)
  })

  it('depth resets even when runner throws', async () => {
    const runner = vi.fn(async () => {
      throw new Error('boom')
    })
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toMatch(/Error: boom/)
    expect(_getDepth()).toBe(0)
  })

  it('refuses once MAX_DEPTH is reached', async () => {
    _setDepth(SUB_AGENT_MAX_DEPTH)
    const runner = vi.fn(async () => 'should not run')
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toMatch(/Maximum sub-agent nesting depth/)
    expect(runner).not.toHaveBeenCalled()
    // And the tracker is not nudged by a refused call.
    expect(_getDepth()).toBe(SUB_AGENT_MAX_DEPTH)
  })

  it('allows a call at depth = MAX_DEPTH - 1 (recursive boundary)', async () => {
    _setDepth(SUB_AGENT_MAX_DEPTH - 1)
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toBe('ok')
    expect(_getDepth()).toBe(SUB_AGENT_MAX_DEPTH - 1)
  })

  it('serialises concurrent calls via shared depth counter (approximate)', async () => {
    // Two simultaneous executors, each with its own goal. Both increment
    // _depth on the way in; neither should see > 2 depth even when
    // interleaved, because _depth is incremented synchronously before
    // the async runner awaits.
    let observedMax = 0
    const runner = async () => {
      observedMax = Math.max(observedMax, _getDepth())
      await new Promise((r) => setTimeout(r, 5))
      return 'done'
    }
    const exec = buildDelegateExecutor(runner)
    await Promise.all([exec({ goal: 'a' }), exec({ goal: 'b' })])
    // Two concurrent calls both pass the guard at depth 0 and 1, so the
    // observed max is SUB_AGENT_MAX_DEPTH. A THIRD concurrent call would
    // be refused before the runner fires.
    expect(observedMax).toBeLessThanOrEqual(SUB_AGENT_MAX_DEPTH)
  })
})
