import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../agentStore'
import type { AgentRun, AgentLogEntry, ToolCall, AgentTask } from '../../types/agents'

function makeTask(id: string, toolCalls: ToolCall[] = []): AgentTask {
  return { id, description: `Task ${id}`, status: 'pending', toolCalls, reasoning: '', order: 0 }
}

function makeToolCall(id: string): ToolCall {
  return { id, tool: 'web_search', args: {}, status: 'pending', timestamp: Date.now() }
}

function makeRun(id: string, tasks: AgentTask[] = []): AgentRun {
  return {
    id,
    goal: `Goal for ${id}`,
    model: 'test-model',
    status: 'idle',
    tasks,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxIterations: 20,
    currentIteration: 0,
  }
}

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.setState({
      runs: [],
      activeRunId: null,
      maxIterations: 20,
      workspacePath: '~/agent-workspace',
    })
  })

  // ── createRun ──────────────────────────────────────────────

  describe('createRun', () => {
    it('adds the run to runs array', () => {
      const run = makeRun('run-1')
      useAgentStore.getState().createRun(run)
      expect(useAgentStore.getState().runs).toHaveLength(1)
      expect(useAgentStore.getState().runs[0].id).toBe('run-1')
    })

    it('sets activeRunId to the new run', () => {
      const run = makeRun('run-1')
      useAgentStore.getState().createRun(run)
      expect(useAgentStore.getState().activeRunId).toBe('run-1')
    })

    it('adds multiple runs', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().createRun(makeRun('run-2'))
      expect(useAgentStore.getState().runs).toHaveLength(2)
      expect(useAgentStore.getState().activeRunId).toBe('run-2')
    })
  })

  // ── updateRun ──────────────────────────────────────────────

  describe('updateRun', () => {
    it('merges partial updates into the run', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().updateRun('run-1', { status: 'executing' })
      expect(useAgentStore.getState().runs[0].status).toBe('executing')
    })

    it('auto-sets updatedAt', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      const before = Date.now()
      useAgentStore.getState().updateRun('run-1', { currentIteration: 5 })
      expect(useAgentStore.getState().runs[0].updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('does not modify other runs', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().createRun(makeRun('run-2'))
      useAgentStore.getState().updateRun('run-1', { status: 'completed' })
      expect(useAgentStore.getState().runs[1].status).toBe('idle')
    })

    it('is a no-op for non-existent runId', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().updateRun('nonexistent', { status: 'failed' })
      expect(useAgentStore.getState().runs[0].status).toBe('idle')
    })
  })

  // ── addLogEntry ────────────────────────────────────────────

  describe('addLogEntry', () => {
    it('appends a log entry to the correct run', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      const entry: AgentLogEntry = {
        id: 'log-1',
        type: 'thought',
        content: 'Thinking...',
        timestamp: Date.now(),
      }
      useAgentStore.getState().addLogEntry('run-1', entry)
      expect(useAgentStore.getState().runs[0].log).toHaveLength(1)
      expect(useAgentStore.getState().runs[0].log[0].id).toBe('log-1')
    })

    it('sets updatedAt on the run', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      const before = Date.now()
      useAgentStore.getState().addLogEntry('run-1', {
        id: 'log-1',
        type: 'action',
        content: 'Doing something',
        timestamp: Date.now(),
      })
      expect(useAgentStore.getState().runs[0].updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('appends multiple entries in order', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().addLogEntry('run-1', { id: 'a', type: 'thought', content: '1', timestamp: 1 })
      useAgentStore.getState().addLogEntry('run-1', { id: 'b', type: 'action', content: '2', timestamp: 2 })
      const log = useAgentStore.getState().runs[0].log
      expect(log).toHaveLength(2)
      expect(log[0].id).toBe('a')
      expect(log[1].id).toBe('b')
    })
  })

  // ── addToolCall ────────────────────────────────────────────

  describe('addToolCall', () => {
    it('appends a toolCall to the correct task', () => {
      const task = makeTask('task-1')
      useAgentStore.getState().createRun(makeRun('run-1', [task]))
      const tc = makeToolCall('tc-1')
      useAgentStore.getState().addToolCall('run-1', 'task-1', tc)
      const tasks = useAgentStore.getState().runs[0].tasks
      expect(tasks[0].toolCalls).toHaveLength(1)
      expect(tasks[0].toolCalls[0].id).toBe('tc-1')
    })

    it('does not affect other tasks in the same run', () => {
      const task1 = makeTask('task-1')
      const task2 = makeTask('task-2')
      useAgentStore.getState().createRun(makeRun('run-1', [task1, task2]))
      useAgentStore.getState().addToolCall('run-1', 'task-1', makeToolCall('tc-1'))
      expect(useAgentStore.getState().runs[0].tasks[1].toolCalls).toHaveLength(0)
    })

    it('updates updatedAt on the run', () => {
      useAgentStore.getState().createRun(makeRun('run-1', [makeTask('task-1')]))
      const before = Date.now()
      useAgentStore.getState().addToolCall('run-1', 'task-1', makeToolCall('tc-1'))
      expect(useAgentStore.getState().runs[0].updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  // ── updateToolCallStatus ───────────────────────────────────

  describe('updateToolCallStatus', () => {
    it('updates status on the correct nested toolCall', () => {
      const tc = makeToolCall('tc-1')
      useAgentStore.getState().createRun(makeRun('run-1', [makeTask('task-1', [tc])]))
      useAgentStore.getState().updateToolCallStatus('run-1', 'tc-1', 'completed', 'result data')
      const updated = useAgentStore.getState().runs[0].tasks[0].toolCalls[0]
      expect(updated.status).toBe('completed')
      expect(updated.result).toBe('result data')
    })

    it('sets error and duration when provided', () => {
      const tc = makeToolCall('tc-1')
      useAgentStore.getState().createRun(makeRun('run-1', [makeTask('task-1', [tc])]))
      useAgentStore.getState().updateToolCallStatus('run-1', 'tc-1', 'failed', undefined, 'timeout', 1500)
      const updated = useAgentStore.getState().runs[0].tasks[0].toolCalls[0]
      expect(updated.status).toBe('failed')
      expect(updated.error).toBe('timeout')
      expect(updated.duration).toBe(1500)
    })

    it('finds toolCall across multiple tasks', () => {
      const tc1 = makeToolCall('tc-1')
      const tc2 = makeToolCall('tc-2')
      useAgentStore.getState().createRun(makeRun('run-1', [
        makeTask('task-1', [tc1]),
        makeTask('task-2', [tc2]),
      ]))
      useAgentStore.getState().updateToolCallStatus('run-1', 'tc-2', 'completed', 'ok')
      expect(useAgentStore.getState().runs[0].tasks[1].toolCalls[0].status).toBe('completed')
      // tc-1 unchanged
      expect(useAgentStore.getState().runs[0].tasks[0].toolCalls[0].status).toBe('pending')
    })

    it('does not overwrite result when result is undefined', () => {
      const tc = makeToolCall('tc-1')
      tc.result = 'existing'
      useAgentStore.getState().createRun(makeRun('run-1', [makeTask('task-1', [tc])]))
      useAgentStore.getState().updateToolCallStatus('run-1', 'tc-1', 'completed')
      // result should NOT be overwritten since undefined was passed
      expect(useAgentStore.getState().runs[0].tasks[0].toolCalls[0].result).toBe('existing')
    })
  })

  // ── deleteRun ──────────────────────────────────────────────

  describe('deleteRun', () => {
    it('removes the run from the array', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().deleteRun('run-1')
      expect(useAgentStore.getState().runs).toHaveLength(0)
    })

    it('clears activeRunId if deleted run was active', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      expect(useAgentStore.getState().activeRunId).toBe('run-1')
      useAgentStore.getState().deleteRun('run-1')
      expect(useAgentStore.getState().activeRunId).toBeNull()
    })

    it('does not clear activeRunId if a different run is deleted', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().createRun(makeRun('run-2'))
      // run-2 is active
      useAgentStore.getState().deleteRun('run-1')
      expect(useAgentStore.getState().activeRunId).toBe('run-2')
      expect(useAgentStore.getState().runs).toHaveLength(1)
    })
  })

  // ── getActiveRun ───────────────────────────────────────────

  describe('getActiveRun', () => {
    it('returns the active run', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      const active = useAgentStore.getState().getActiveRun()
      expect(active).toBeDefined()
      expect(active!.id).toBe('run-1')
    })

    it('returns undefined when no run is active', () => {
      expect(useAgentStore.getState().getActiveRun()).toBeUndefined()
    })

    it('returns undefined after active run is deleted', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().deleteRun('run-1')
      expect(useAgentStore.getState().getActiveRun()).toBeUndefined()
    })

    it('returns the most recently set active run', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().createRun(makeRun('run-2'))
      useAgentStore.getState().setActiveRun('run-1')
      expect(useAgentStore.getState().getActiveRun()!.id).toBe('run-1')
    })
  })

  // ── setActiveRun ───────────────────────────────────────────

  describe('setActiveRun', () => {
    it('sets activeRunId', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().setActiveRun('run-1')
      expect(useAgentStore.getState().activeRunId).toBe('run-1')
    })

    it('can set to null', () => {
      useAgentStore.getState().createRun(makeRun('run-1'))
      useAgentStore.getState().setActiveRun(null)
      expect(useAgentStore.getState().activeRunId).toBeNull()
    })
  })
})
