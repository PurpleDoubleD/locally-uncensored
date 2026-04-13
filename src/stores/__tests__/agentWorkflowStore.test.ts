import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-' + Math.random().toString(36).slice(2, 8)),
}))

vi.mock('../../lib/built-in-workflows', () => ({
  BUILT_IN_WORKFLOWS: [
    {
      id: 'builtin-1',
      name: 'Built-in Workflow',
      description: 'A built-in test workflow',
      icon: 'Search',
      steps: [{ id: 's1', type: 'prompt', label: 'Step 1' }],
      variables: { topic: 'default' },
      isBuiltIn: true,
      createdAt: 1000,
      updatedAt: 1000,
    },
  ],
}))

import { useAgentWorkflowStore } from '../agentWorkflowStore'
import type { StepResult } from '../../types/agent-workflows'

describe('agentWorkflowStore', () => {
  beforeEach(() => {
    useAgentWorkflowStore.setState({
      workflows: [
        {
          id: 'builtin-1',
          name: 'Built-in Workflow',
          description: 'A built-in test workflow',
          icon: 'Search',
          steps: [{ id: 's1', type: 'prompt', label: 'Step 1' }],
          variables: { topic: 'default' },
          isBuiltIn: true,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      executions: [],
      activeExecutionId: null,
    })
  })

  // ── addWorkflow ────────────────────────────────────────────

  describe('addWorkflow', () => {
    it('returns a UUID for the new workflow', () => {
      const id = useAgentWorkflowStore.getState().addWorkflow({
        name: 'Custom',
        description: 'Custom workflow',
        icon: 'Zap',
        steps: [],
        variables: {},
        isBuiltIn: false,
      })
      expect(id).toBeDefined()
      expect(typeof id).toBe('string')
    })

    it('appends workflow with createdAt and updatedAt timestamps', () => {
      const before = Date.now()
      useAgentWorkflowStore.getState().addWorkflow({
        name: 'Custom',
        description: 'desc',
        icon: 'Zap',
        steps: [],
        variables: {},
        isBuiltIn: false,
      })
      const workflows = useAgentWorkflowStore.getState().workflows
      const added = workflows[workflows.length - 1]
      expect(added.name).toBe('Custom')
      expect(added.createdAt).toBeGreaterThanOrEqual(before)
      expect(added.updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('does not remove existing workflows', () => {
      useAgentWorkflowStore.getState().addWorkflow({
        name: 'Second',
        description: '',
        icon: 'Zap',
        steps: [],
        variables: {},
        isBuiltIn: false,
      })
      expect(useAgentWorkflowStore.getState().workflows.length).toBe(2)
    })
  })

  // ── updateWorkflow ─────────────────────────────────────────

  describe('updateWorkflow', () => {
    it('merges updates and sets updatedAt', () => {
      useAgentWorkflowStore.getState().addWorkflow({
        name: 'Original',
        description: 'desc',
        icon: 'Zap',
        steps: [],
        variables: {},
        isBuiltIn: false,
      })
      const id = useAgentWorkflowStore.getState().workflows[1].id
      const before = Date.now()
      useAgentWorkflowStore.getState().updateWorkflow(id, { name: 'Updated' })
      const updated = useAgentWorkflowStore.getState().workflows.find(w => w.id === id)!
      expect(updated.name).toBe('Updated')
      expect(updated.description).toBe('desc') // unchanged
      expect(updated.updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('is a no-op for non-existent id', () => {
      const before = [...useAgentWorkflowStore.getState().workflows]
      useAgentWorkflowStore.getState().updateWorkflow('nonexistent', { name: 'X' })
      expect(useAgentWorkflowStore.getState().workflows).toEqual(before)
    })
  })

  // ── removeWorkflow ─────────────────────────────────────────

  describe('removeWorkflow', () => {
    it('removes a non-builtIn workflow', () => {
      const id = useAgentWorkflowStore.getState().addWorkflow({
        name: 'Removable',
        description: '',
        icon: 'Zap',
        steps: [],
        variables: {},
        isBuiltIn: false,
      })
      expect(useAgentWorkflowStore.getState().workflows.length).toBe(2)
      useAgentWorkflowStore.getState().removeWorkflow(id)
      expect(useAgentWorkflowStore.getState().workflows.length).toBe(1)
    })

    it('does NOT remove a builtIn workflow', () => {
      useAgentWorkflowStore.getState().removeWorkflow('builtin-1')
      expect(useAgentWorkflowStore.getState().workflows.length).toBe(1)
      expect(useAgentWorkflowStore.getState().workflows[0].id).toBe('builtin-1')
    })
  })

  // ── duplicateWorkflow ──────────────────────────────────────

  describe('duplicateWorkflow', () => {
    it('creates a copy with new UUID', () => {
      const newId = useAgentWorkflowStore.getState().duplicateWorkflow('builtin-1')
      expect(newId).not.toBeNull()
      expect(newId).not.toBe('builtin-1')
    })

    it('sets isBuiltIn to false on the duplicate', () => {
      const newId = useAgentWorkflowStore.getState().duplicateWorkflow('builtin-1')!
      const dup = useAgentWorkflowStore.getState().workflows.find(w => w.id === newId)!
      expect(dup.isBuiltIn).toBe(false)
    })

    it('appends "(copy)" to the name', () => {
      const newId = useAgentWorkflowStore.getState().duplicateWorkflow('builtin-1')!
      const dup = useAgentWorkflowStore.getState().workflows.find(w => w.id === newId)!
      expect(dup.name).toBe('Built-in Workflow (copy)')
    })

    it('returns null for non-existent workflow', () => {
      const result = useAgentWorkflowStore.getState().duplicateWorkflow('nonexistent')
      expect(result).toBeNull()
    })

    it('sets new createdAt and updatedAt timestamps', () => {
      const before = Date.now()
      const newId = useAgentWorkflowStore.getState().duplicateWorkflow('builtin-1')!
      const dup = useAgentWorkflowStore.getState().workflows.find(w => w.id === newId)!
      expect(dup.createdAt).toBeGreaterThanOrEqual(before)
      expect(dup.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  // ── getWorkflow ────────────────────────────────────────────

  describe('getWorkflow', () => {
    it('returns the workflow by id', () => {
      const wf = useAgentWorkflowStore.getState().getWorkflow('builtin-1')
      expect(wf).toBeDefined()
      expect(wf!.name).toBe('Built-in Workflow')
    })

    it('returns undefined for unknown id', () => {
      expect(useAgentWorkflowStore.getState().getWorkflow('nope')).toBeUndefined()
    })
  })

  // ── startExecution ─────────────────────────────────────────

  describe('startExecution', () => {
    it('creates execution with running status and currentStepIndex=0', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1', 'conv-1')
      expect(execId).not.toBeNull()
      const exec = useAgentWorkflowStore.getState().executions[0]
      expect(exec.status).toBe('running')
      expect(exec.currentStepIndex).toBe(0)
      expect(exec.conversationId).toBe('conv-1')
    })

    it('copies workflow variables to execution', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      const exec = useAgentWorkflowStore.getState().executions.find(e => e.id === execId)!
      expect(exec.variables).toEqual({ topic: 'default' })
    })

    it('sets activeExecutionId', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1')
      expect(useAgentWorkflowStore.getState().activeExecutionId).toBe(execId)
    })

    it('returns null for non-existent workflow', () => {
      const result = useAgentWorkflowStore.getState().startExecution('nonexistent')
      expect(result).toBeNull()
    })

    it('trims execution history to MAX_EXECUTION_HISTORY (50)', () => {
      // Fill up with 50 executions
      for (let i = 0; i < 55; i++) {
        useAgentWorkflowStore.getState().startExecution('builtin-1')
      }
      expect(useAgentWorkflowStore.getState().executions.length).toBeLessThanOrEqual(50)
    })
  })

  // ── addStepResult ──────────────────────────────────────────

  describe('addStepResult', () => {
    it('appends result and increments currentStepIndex', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      const result: StepResult = {
        stepId: 's1',
        status: 'completed',
        output: 'done',
        startedAt: Date.now(),
        completedAt: Date.now(),
      }
      useAgentWorkflowStore.getState().addStepResult(execId, result)
      const exec = useAgentWorkflowStore.getState().executions.find(e => e.id === execId)!
      expect(exec.stepResults).toHaveLength(1)
      expect(exec.stepResults[0].stepId).toBe('s1')
      expect(exec.currentStepIndex).toBe(1)
    })

    it('adds multiple step results sequentially', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      for (let i = 0; i < 3; i++) {
        useAgentWorkflowStore.getState().addStepResult(execId, {
          stepId: `s${i}`,
          status: 'completed',
          output: `output-${i}`,
          startedAt: Date.now(),
        })
      }
      const exec = useAgentWorkflowStore.getState().executions.find(e => e.id === execId)!
      expect(exec.stepResults).toHaveLength(3)
      expect(exec.currentStepIndex).toBe(3)
    })
  })

  // ── cancelExecution ────────────────────────────────────────

  describe('cancelExecution', () => {
    it('sets status to cancelled and completedAt', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      const before = Date.now()
      useAgentWorkflowStore.getState().cancelExecution(execId)
      const exec = useAgentWorkflowStore.getState().executions.find(e => e.id === execId)!
      expect(exec.status).toBe('cancelled')
      expect(exec.completedAt).toBeGreaterThanOrEqual(before)
    })

    it('clears activeExecutionId if cancelled execution was active', () => {
      const execId = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      expect(useAgentWorkflowStore.getState().activeExecutionId).toBe(execId)
      useAgentWorkflowStore.getState().cancelExecution(execId)
      expect(useAgentWorkflowStore.getState().activeExecutionId).toBeNull()
    })

    it('does not clear activeExecutionId if a different execution is cancelled', () => {
      const exec1 = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      const exec2 = useAgentWorkflowStore.getState().startExecution('builtin-1')!
      // exec2 is now active
      useAgentWorkflowStore.getState().cancelExecution(exec1)
      expect(useAgentWorkflowStore.getState().activeExecutionId).toBe(exec2)
    })
  })

  // ── clearExecutionHistory ──────────────────────────────────

  describe('clearExecutionHistory', () => {
    it('clears all executions and activeExecutionId', () => {
      useAgentWorkflowStore.getState().startExecution('builtin-1')
      useAgentWorkflowStore.getState().clearExecutionHistory()
      expect(useAgentWorkflowStore.getState().executions).toEqual([])
      expect(useAgentWorkflowStore.getState().activeExecutionId).toBeNull()
    })
  })
})
