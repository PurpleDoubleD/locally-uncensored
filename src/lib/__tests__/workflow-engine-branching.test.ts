/**
 * WorkflowEngine branching — the part of a workflow that decides where to go
 * next. src/lib/workflow-engine.ts had no tests at all.
 *
 * Measured against the version before this round, where the condition was
 * evaluated twice: once by the step (correctly), then again by the runner to
 * pick the branch — but by then the step's own "true"/"false" had been written
 * into last_output, so a condition reading last_output compared that marker
 * against the user's value and always went down the else branch.
 *
 * Only condition and memory_save steps are used here: both are synchronous and
 * need no model, so the test exercises the real engine rather than a copy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { WorkflowEngine, MAX_STEPS_EXECUTED } from '../workflow-engine'
import { useMemoryStore } from '../../stores/memoryStore'
import type { AgentWorkflow, WorkflowStep, WorkflowEngineCallbacks } from '../../types/agent-workflows'

const saved: { title: string; content: string }[] = []

beforeEach(() => {
  saved.length = 0
  vi.spyOn(useMemoryStore.getState(), 'addMemory').mockImplementation((m) => {
    saved.push({ title: m.title, content: m.content })
    return 'mem-id'
  })
})

function noteStep(id: string, content = '{{last_output}}'): WorkflowStep {
  return {
    id,
    type: 'memory_save',
    label: id,
    memorySave: { type: 'reference', titleTemplate: id, contentTemplate: content, tags: [] },
  }
}

function conditionStep(id: string, condition: WorkflowStep['condition']): WorkflowStep {
  return { id, type: 'condition', label: id, condition }
}

function run(steps: WorkflowStep[], variables: Record<string, string> = {}) {
  const workflow: AgentWorkflow = {
    id: 'wf', name: 'test', description: '', icon: 'Zap', steps,
    variables: {}, isBuiltIn: false, createdAt: 0, updatedAt: 0,
  }
  const errors: string[] = []
  const callbacks: WorkflowEngineCallbacks = {
    onStepStart: () => {},
    onStepComplete: () => {},
    onStepError: (_i, e) => errors.push(e),
    onWaitingForInput: () => {},
    onComplete: () => {},
    onError: (e) => errors.push(e),
  }
  const engine = new WorkflowEngine(workflow, 'conv', callbacks, variables)
  return engine.run().then((results) => ({ results, errors }))
}

describe('a condition sends the run down the branch it actually chose', () => {
  // A branch is a jump, not a scope: after landing, the run continues down the
  // list. So what the assertions pin is which step the jump ENTERED.
  const branchWorkflow = [
    conditionStep('check', { source: 'last_output', operator: 'contains', value: 'error', thenStepId: 'onErr', elseStepId: 'onOk' }),
    noteStep('onOk', 'clean'),
    noteStep('onErr', 'failed'),
  ]

  it('takes the then branch when the output matches', async () => {
    await run(branchWorkflow, { last_output: 'the build reported an error in main.rs' })

    // Before the fix this landed on 'onOk' — the else branch — because the
    // runner compared the marker "true" against "error".
    expect(saved.map((s) => s.title)).toEqual(['onErr'])
  })

  it('takes the else branch when it does not', async () => {
    await run(branchWorkflow, { last_output: 'the build succeeded' })

    expect(saved[0].title).toBe('onOk')
  })

  it('branches on a named variable just as well', async () => {
    await run(
      [
        conditionStep('check', { source: 'mode', operator: 'equals', value: 'fast', thenStepId: 'quick', elseStepId: 'slow' }),
        noteStep('slow', 'thorough'),
        noteStep('quick', 'quick'),
      ],
      { mode: 'fast' },
    )

    expect(saved.map((s) => s.title)).toEqual(['quick'])
  })

  it('falls through to the next step when the branch target does not exist', async () => {
    // The builder writes empty thenStepId/elseStepId, so this is what an
    // unconfigured condition step has to do: nothing but continue.
    await run(
      [
        conditionStep('check', { source: 'last_output', operator: 'contains', value: 'x', thenStepId: '', elseStepId: '' }),
        noteStep('after'),
      ],
      { last_output: 'x marks it' },
    )

    expect(saved.map((s) => s.title)).toEqual(['after'])
  })
})

describe('a condition does not overwrite the output it inspected', () => {
  it('leaves last_output for the step after it', async () => {
    await run(
      [
        conditionStep('check', { source: 'last_output', operator: 'contains', value: 'summary', thenStepId: '', elseStepId: '' }),
        noteStep('after', '{{last_output}}'),
      ],
      { last_output: 'the summary of the document' },
    )

    // Before, this saved the literal "true".
    expect(saved[0].content).toBe('the summary of the document')
  })
})

describe('a workflow that branches backwards still terminates', () => {
  it('stops at the step budget instead of looping forever', async () => {
    // "Not done yet? go back" is the natural way to write a retry, and
    // run_workflow gives an agent no way to cancel — so the runner has to.
    const { errors } = await run(
      [
        noteStep('start', 'working'),
        conditionStep('again?', { source: 'mode', operator: 'equals', value: 'retry', thenStepId: 'start', elseStepId: '' }),
      ],
      { mode: 'retry' },
    )

    expect(errors.join(' ')).toMatch(/exceeded 500 steps/)
    expect(saved.length).toBeLessThanOrEqual(MAX_STEPS_EXECUTED)
  })
})
