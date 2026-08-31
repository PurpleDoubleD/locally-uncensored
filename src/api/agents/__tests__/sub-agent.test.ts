import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Doubles for the modules defaultSubAgentRunner pulls in lazily ─────
//
// The runner resolves provider, registry, permissions and audit store at call
// time, so the whole delegated ReAct loop is drivable from here: the provider
// double decides what tool calls the sub-agent emits, the registry double
// decides what the executor may run, and the permission double decides which
// gate the call has to pass.

const chatWithTools = vi.fn()
const toolExecute = vi.fn(async () => 'tool output')
// Typed like the real useToolAuditStore.record, so the assertions below can
// read what the runner passed; a bare `vi.fn(() => ...)` has an empty args
// tuple and `calls[0][0]` does not exist on it.
const auditRecord = vi.fn((_input: {
  id?: string
  convId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  parentToolCallId?: string
  startedAt?: number
}) => 'audit-1')
const auditComplete = vi.fn()
let permLevel: 'auto' | 'confirm' | 'blocked' = 'auto'

const SHELL_DEF = {
  name: 'shell_execute',
  description: 'run a command',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  category: 'system',
  source: 'builtin',
}

vi.mock('../../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel: 'ollama::qwen' }) },
}))

vi.mock('../../providers', () => ({
  getProviderForModel: (name: string) => ({
    provider: { chatWithTools },
    modelId: name.includes('::') ? name.split('::')[1] : name,
  }),
}))

vi.mock('../../mcp', () => ({
  toolRegistry: {
    getAll: () => [SHELL_DEF],
    resolveExecutable: (name: string) => (name === 'shell_execute' ? SHELL_DEF : undefined),
    execute: (...args: any[]) => toolExecute(...(args as [])),
    getPermissionLevelWithOverrides: () => permLevel,
  },
}))

vi.mock('../../../stores/permissionStore', () => ({
  usePermissionStore: {
    getState: () => ({ getEffectivePermissions: () => ({}), perToolOverrides: {} }),
  },
}))

vi.mock('../../../stores/toolAuditStore', () => ({
  useToolAuditStore: { getState: () => ({ record: auditRecord, complete: auditComplete }) },
}))

import {
  DELEGATE_TASK_TOOL_DEF,
  SUB_AGENT_MAX_PARALLEL,
  SUB_AGENT_BUDGET,
  buildDelegateExecutor,
  defaultSubAgentRunner,
  _getDepth,
  _setDepth,
} from '../sub-agent'
import { AgentBudget } from '../budget'
import type { AgentRunContext } from '../../agent-context'
import { dequeueApproval, headApproval, resetApprovals } from '../../../lib/approval-queue'

describe('sub-agent — tool definition', () => {
  it('has the expected shape', () => {
    expect(DELEGATE_TASK_TOOL_DEF.name).toBe('delegate_task')
    expect(DELEGATE_TASK_TOOL_DEF.category).toBe('workflow')
    expect(DELEGATE_TASK_TOOL_DEF.source).toBe('builtin')
    expect(DELEGATE_TASK_TOOL_DEF.inputSchema.required).toContain('goal')
  })

  it('description contains the recursion + parallel hints', () => {
    expect(DELEGATE_TASK_TOOL_DEF.description).toMatch(/recursion is filtered/i)
    expect(DELEGATE_TASK_TOOL_DEF.description).toMatch(/PARALLELIZE/i)
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

  it('refuses once MAX_PARALLEL in-flight is reached', async () => {
    _setDepth(SUB_AGENT_MAX_PARALLEL)
    const runner = vi.fn(async () => 'should not run')
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toMatch(/Maximum sub-agent concurrency/)
    expect(runner).not.toHaveBeenCalled()
    // And the tracker is not nudged by a refused call.
    expect(_getDepth()).toBe(SUB_AGENT_MAX_PARALLEL)
  })

  it('allows a call at MAX_PARALLEL - 1 (boundary)', async () => {
    _setDepth(SUB_AGENT_MAX_PARALLEL - 1)
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toBe('ok')
    expect(_getDepth()).toBe(SUB_AGENT_MAX_PARALLEL - 1)
  })

  // ── Parallel siblings (Bonus, 2026-05) ─────────────────────────

  it('runs three parallel siblings concurrently — no false refusals', async () => {
    let observedMax = 0
    const starts: number[] = []
    const runner = async (goal: string) => {
      starts.push(Date.now())
      observedMax = Math.max(observedMax, _getDepth())
      await new Promise((r) => setTimeout(r, 10))
      return `done:${goal}`
    }
    const exec = buildDelegateExecutor(runner)
    const out = await Promise.all([
      exec({ goal: 'a' }),
      exec({ goal: 'b' }),
      exec({ goal: 'c' }),
    ])
    expect(out).toEqual(['done:a', 'done:b', 'done:c'])
    // All three should be in flight at the same time → observedMax = 3.
    expect(observedMax).toBe(3)
    // And every refusal would have been "should not run" — none returned.
    expect(out.every((s) => !s.startsWith('Error'))).toBe(true)
  })

  it('a 5th parallel sibling is refused (cap is 4)', async () => {
    _setDepth(0)
    const runner = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return 'ok'
    })
    const exec = buildDelegateExecutor(runner)
    const five = [
      exec({ goal: 'a' }),
      exec({ goal: 'b' }),
      exec({ goal: 'c' }),
      exec({ goal: 'd' }),
      exec({ goal: 'e' }),
    ]
    const settled = await Promise.all(five)
    const refused = settled.filter((s) => /Maximum sub-agent concurrency/.test(s))
    expect(refused).toHaveLength(1)
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('after a refusal, the next call succeeds once a slot frees', async () => {
    _setDepth(SUB_AGENT_MAX_PARALLEL)
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    expect(await exec({ goal: 'x' })).toMatch(/Maximum sub-agent concurrency/)
    _setDepth(0)
    expect(await exec({ goal: 'x' })).toBe('ok')
  })
})

// ── AGT-1: the delegated loop inherits the parent run's gates ──────────
//
// Before 2.6.7 defaultSubAgentRunner called executeParallel with getTool +
// execute + explainError and nothing else, so a sub-agent ran the whole
// registry — shell_execute, file_write, file_edit, all 'confirm' by default —
// with no approval prompt, no audit entry and no way to stop it. These pin the
// three gates it now has to pass.

const makeRun = (over: Partial<AgentRunContext> = {}): AgentRunContext => ({
  token: 'run-test',
  chatId: null,
  conversationId: 'conv-1',
  workspace: null,
  artifactMode: false,
  readOnlyShellTurn: false,
  mode: null,
  artifacts: [],
  ...over,
})

/** Script the provider: one tool-calling turn, then a plain final answer. */
function scriptOneToolCall(): void {
  chatWithTools
    .mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'tc1', function: { name: 'shell_execute', arguments: { command: 'ls' } } }],
    })
    .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
}

/** The message array the sub-agent sent on its Nth provider turn (0-based). */
const messagesOfTurn = (n: number): any[] => chatWithTools.mock.calls[n][1] as any[]
const lastToolMessage = (n: number): string => {
  const msgs = messagesOfTurn(n)
  return String(msgs[msgs.length - 1]?.content ?? '')
}

const tick = () => new Promise((r) => setTimeout(r, 0))

async function waitForPrompt(convId: string) {
  for (let i = 0; i < 100; i++) {
    const head = headApproval(convId)
    if (head) return head
    await tick()
  }
  throw new Error('no approval was raised')
}

const runSub = (run?: AgentRunContext) =>
  defaultSubAgentRunner('do it', '', { budget: new AgentBudget({ ...SUB_AGENT_BUDGET }), run })

describe('sub-agent — approval gate (AGT-1)', () => {
  beforeEach(() => {
    _setDepth(0)
    permLevel = 'auto'
    chatWithTools.mockReset()
    toolExecute.mockReset()
    toolExecute.mockResolvedValue('tool output')
    auditRecord.mockClear()
    auditComplete.mockClear()
    resetApprovals()
  })

  it('a confirm-level tool call raises an approval instead of dispatching', async () => {
    permLevel = 'confirm'
    scriptOneToolCall()
    const p = runSub(makeRun())

    const head = await waitForPrompt('conv-1')
    expect(head.toolName).toBe('shell_execute')
    expect(head.args).toEqual({ command: 'ls' })
    // Still waiting on the user — nothing has run.
    expect(toolExecute).not.toHaveBeenCalled()

    dequeueApproval('conv-1')!.resolve(false)
    await p
    expect(toolExecute).not.toHaveBeenCalled()
    expect(lastToolMessage(1)).toMatch(/rejected/i)
  })

  it('an approved confirm-level call dispatches once the user says yes', async () => {
    permLevel = 'confirm'
    scriptOneToolCall()
    const p = runSub(makeRun())

    await waitForPrompt('conv-1')
    dequeueApproval('conv-1')!.resolve(true)
    expect(await p).toBe('done')
    expect(toolExecute).toHaveBeenCalledOnce()
    expect(lastToolMessage(1)).toBe('tool output')
  })

  it('auto-level tools run unprompted (the gate is a gate, not a wall)', async () => {
    permLevel = 'auto'
    scriptOneToolCall()
    expect(await runSub(makeRun())).toBe('done')
    expect(headApproval('conv-1')).toBeNull()
    expect(toolExecute).toHaveBeenCalledOnce()
  })

  it('blocked tools are refused without asking anyone', async () => {
    permLevel = 'blocked'
    scriptOneToolCall()
    await runSub(makeRun())
    expect(headApproval('conv-1')).toBeNull()
    expect(toolExecute).not.toHaveBeenCalled()
    expect(lastToolMessage(1)).toMatch(/Blocked: shell_execute is not permitted/)
  })

  it('fails closed when the delegation has no conversation to ask in', async () => {
    permLevel = 'confirm'
    scriptOneToolCall()
    await runSub(undefined)
    expect(toolExecute).not.toHaveBeenCalled()
    expect(lastToolMessage(1)).toMatch(/no conversation to ask in/)
  })

  it('records every delegated call in the parent conversation audit trail', async () => {
    permLevel = 'auto'
    scriptOneToolCall()
    await runSub(makeRun())
    expect(auditRecord).toHaveBeenCalledOnce()
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      convId: 'conv-1',
      toolName: 'shell_execute',
      parentToolCallId: 'sub-agent',
    })
    expect(auditComplete).toHaveBeenCalledOnce()
  })
})

describe('sub-agent — abort signal (AGT-1)', () => {
  beforeEach(() => {
    _setDepth(0)
    permLevel = 'auto'
    chatWithTools.mockReset()
    toolExecute.mockReset()
    toolExecute.mockResolvedValue('tool output')
    resetApprovals()
  })

  it('Stop during the model turn keeps the batch from dispatching', async () => {
    const ctrl = new AbortController()
    chatWithTools.mockImplementationOnce(async () => {
      ctrl.abort() // user hits Stop while the sub-agent is thinking
      return {
        content: '',
        toolCalls: [{ id: 'tc1', function: { name: 'shell_execute', arguments: { command: 'ls' } } }],
      }
    })
    const out = await runSub(makeRun({ abortSignal: ctrl.signal }))
    expect(toolExecute).not.toHaveBeenCalled()
    expect(out).toMatch(/stopped by the user/)
    // And it did not start another ReAct iteration after the abort.
    expect(chatWithTools).toHaveBeenCalledOnce()
  })

  it('Stop answers a tool call that is waiting for approval', async () => {
    permLevel = 'confirm'
    const ctrl = new AbortController()
    scriptOneToolCall()
    const p = runSub(makeRun({ abortSignal: ctrl.signal }))

    await waitForPrompt('conv-1')
    ctrl.abort()
    const out = await p
    expect(toolExecute).not.toHaveBeenCalled()
    expect(headApproval('conv-1')).toBeNull()
    expect(out).toMatch(/stopped by the user/)
  })

  it('an already-aborted run never reaches the provider at all', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await runSub(makeRun({ abortSignal: ctrl.signal }))
    expect(chatWithTools).not.toHaveBeenCalled()
    expect(out).toMatch(/stopped by the user/)
  })
})
