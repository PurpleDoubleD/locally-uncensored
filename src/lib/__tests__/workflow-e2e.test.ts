import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { BUILT_IN_WORKFLOWS } from '../built-in-workflows'
import { useMemoryStore } from '../../stores/memoryStore'

// ── Helpers ───────────────────────────────────────────────────

function resetStores() {
  useAgentWorkflowStore.setState({
    workflows: [...BUILT_IN_WORKFLOWS],
    executions: [],
    activeExecutionId: null,
  })
  useMemoryStore.setState({
    entries: [],
    settings: { autoExtractEnabled: true, autoExtractInAllModes: true, maxMemoriesInPrompt: 10, maxMemoryChars: 3000 },
    lastSynced: 0,
  })
}

// ── Built-in Workflows ─────────────────────────────────────────

describe('Built-in Workflows', () => {
  it('has exactly 3 built-in workflows', () => {
    expect(BUILT_IN_WORKFLOWS).toHaveLength(3)
  })

  it('Research Topic has correct structure', () => {
    const wf = BUILT_IN_WORKFLOWS.find(w => w.name === 'Research Topic')!
    expect(wf).toBeDefined()
    expect(wf.isBuiltIn).toBe(true)
    expect(wf.icon).toBe('Search')
    expect(wf.steps.length).toBe(6)
    expect(wf.steps[0].type).toBe('user_input')
    expect(wf.steps[1].type).toBe('tool')
    expect(wf.steps[1].toolName).toBe('web_search')
    expect(wf.steps[2].type).toBe('prompt')
    expect(wf.steps[3].type).toBe('tool')
    expect(wf.steps[3].toolName).toBe('web_fetch')
    expect(wf.steps[4].type).toBe('prompt')
    expect(wf.steps[5].type).toBe('memory_save')
    expect(wf.steps[5].memorySave?.type).toBe('reference')
  })

  it('Summarize URL has correct structure', () => {
    const wf = BUILT_IN_WORKFLOWS.find(w => w.name === 'Summarize URL')!
    expect(wf).toBeDefined()
    expect(wf.steps.length).toBe(3)
    expect(wf.steps[0].type).toBe('user_input')
    expect(wf.steps[1].type).toBe('tool')
    expect(wf.steps[1].toolName).toBe('web_fetch')
    expect(wf.steps[2].type).toBe('prompt')
  })

  it('Code Review has correct structure', () => {
    const wf = BUILT_IN_WORKFLOWS.find(w => w.name === 'Code Review')!
    expect(wf).toBeDefined()
    expect(wf.steps.length).toBe(3)
    expect(wf.steps[0].type).toBe('user_input')
    expect(wf.steps[1].type).toBe('tool')
    expect(wf.steps[1].toolName).toBe('file_read')
    expect(wf.steps[2].type).toBe('prompt')
  })

  it('all built-in workflow steps have IDs and labels', () => {
    for (const wf of BUILT_IN_WORKFLOWS) {
      for (const step of wf.steps) {
        expect(step.id).toBeTruthy()
        expect(step.label).toBeTruthy()
        expect(step.type).toBeTruthy()
      }
    }
  })

  it('all built-in workflows have unique IDs', () => {
    const ids = BUILT_IN_WORKFLOWS.map(w => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('tool steps reference valid tools from registry', () => {
    const validTools = ['web_search', 'web_fetch', 'file_read', 'file_write', 'code_execute', 'image_generate', 'run_workflow']
    for (const wf of BUILT_IN_WORKFLOWS) {
      for (const step of wf.steps) {
        if (step.type === 'tool' && step.toolName) {
          expect(validTools).toContain(step.toolName)
        }
      }
    }
  })
})

// ── Workflow Store CRUD ────────────────────────────────────────

describe('Workflow Store CRUD', () => {
  beforeEach(resetStores)

  it('starts with built-in workflows', () => {
    const { workflows } = useAgentWorkflowStore.getState()
    expect(workflows.length).toBeGreaterThanOrEqual(3)
    expect(workflows.filter(w => w.isBuiltIn)).toHaveLength(3)
  })

  it('addWorkflow creates a custom workflow', () => {
    const id = useAgentWorkflowStore.getState().addWorkflow({
      name: 'Custom Flow',
      description: 'A test workflow',
      icon: 'Zap',
      steps: [{ id: 'step-1', type: 'user_input', label: 'Input', userInputPrompt: 'Enter something' }],
      variables: {},
      isBuiltIn: false,
    })
    expect(id).toBeTruthy()
    const wf = useAgentWorkflowStore.getState().getWorkflow(id)
    expect(wf).toBeDefined()
    expect(wf!.name).toBe('Custom Flow')
    expect(wf!.isBuiltIn).toBe(false)
    expect(wf!.createdAt).toBeGreaterThan(0)
  })

  it('updateWorkflow modifies name and description', () => {
    const id = useAgentWorkflowStore.getState().addWorkflow({
      name: 'Original', description: 'Orig desc', icon: 'Zap', steps: [], variables: {}, isBuiltIn: false,
    })
    useAgentWorkflowStore.getState().updateWorkflow(id, { name: 'Updated', description: 'New desc' })
    const wf = useAgentWorkflowStore.getState().getWorkflow(id)!
    expect(wf.name).toBe('Updated')
    expect(wf.description).toBe('New desc')
    expect(wf.updatedAt).toBeGreaterThanOrEqual(wf.createdAt)
  })

  it('removeWorkflow deletes custom but not built-in', () => {
    const customId = useAgentWorkflowStore.getState().addWorkflow({
      name: 'Deletable', description: '', icon: 'Zap', steps: [], variables: {}, isBuiltIn: false,
    })
    const builtInId = BUILT_IN_WORKFLOWS[0].id

    // Delete custom
    useAgentWorkflowStore.getState().removeWorkflow(customId)
    expect(useAgentWorkflowStore.getState().getWorkflow(customId)).toBeUndefined()

    // Try to delete built-in — should be protected
    useAgentWorkflowStore.getState().removeWorkflow(builtInId)
    expect(useAgentWorkflowStore.getState().getWorkflow(builtInId)).toBeDefined()
  })

  it('duplicateWorkflow creates a copy', () => {
    const builtInId = BUILT_IN_WORKFLOWS[0].id
    const copyId = useAgentWorkflowStore.getState().duplicateWorkflow(builtInId)
    expect(copyId).toBeTruthy()

    const copy = useAgentWorkflowStore.getState().getWorkflow(copyId!)!
    expect(copy.name).toContain('(copy)')
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.id).not.toBe(builtInId)
    expect(copy.steps.length).toBe(BUILT_IN_WORKFLOWS[0].steps.length)
  })

  it('duplicateWorkflow returns null for non-existent ID', () => {
    const result = useAgentWorkflowStore.getState().duplicateWorkflow('non-existent')
    expect(result).toBeNull()
  })

  it('getWorkflow returns undefined for non-existent ID', () => {
    expect(useAgentWorkflowStore.getState().getWorkflow('non-existent')).toBeUndefined()
  })
})

// ── Workflow Execution Store ───────────────────────────────────

describe('Workflow Execution Store', () => {
  beforeEach(resetStores)

  it('startExecution creates execution record', () => {
    const builtInId = BUILT_IN_WORKFLOWS[0].id
    const execId = useAgentWorkflowStore.getState().startExecution(builtInId, 'conv-123')

    expect(execId).toBeTruthy()
    const { executions, activeExecutionId } = useAgentWorkflowStore.getState()
    expect(executions).toHaveLength(1)
    expect(executions[0].workflowId).toBe(builtInId)
    expect(executions[0].status).toBe('running')
    expect(executions[0].conversationId).toBe('conv-123')
    expect(activeExecutionId).toBe(execId)
  })

  it('startExecution returns null for non-existent workflow', () => {
    const result = useAgentWorkflowStore.getState().startExecution('non-existent')
    expect(result).toBeNull()
  })

  it('updateExecution modifies execution fields', () => {
    const execId = useAgentWorkflowStore.getState().startExecution(BUILT_IN_WORKFLOWS[0].id)!
    useAgentWorkflowStore.getState().updateExecution(execId, { status: 'waiting_input' })
    expect(useAgentWorkflowStore.getState().executions[0].status).toBe('waiting_input')
  })

  it('addStepResult appends result and increments step index', () => {
    const execId = useAgentWorkflowStore.getState().startExecution(BUILT_IN_WORKFLOWS[0].id)!
    useAgentWorkflowStore.getState().addStepResult(execId, {
      stepId: 'step-1', status: 'completed', output: 'Step 1 done', startedAt: Date.now(), completedAt: Date.now(),
    })

    const exec = useAgentWorkflowStore.getState().executions[0]
    expect(exec.stepResults).toHaveLength(1)
    expect(exec.currentStepIndex).toBe(1)
  })

  it('cancelExecution sets status and clears active', () => {
    const execId = useAgentWorkflowStore.getState().startExecution(BUILT_IN_WORKFLOWS[0].id)!
    useAgentWorkflowStore.getState().cancelExecution(execId)

    const exec = useAgentWorkflowStore.getState().executions[0]
    expect(exec.status).toBe('cancelled')
    expect(exec.completedAt).toBeGreaterThan(0)
    expect(useAgentWorkflowStore.getState().activeExecutionId).toBeNull()
  })

  it('caps execution history at 50', () => {
    for (let i = 0; i < 55; i++) {
      useAgentWorkflowStore.getState().startExecution(BUILT_IN_WORKFLOWS[0].id, `conv-${i}`)
    }
    expect(useAgentWorkflowStore.getState().executions.length).toBeLessThanOrEqual(50)
  })

  it('clearExecutionHistory removes all', () => {
    useAgentWorkflowStore.getState().startExecution(BUILT_IN_WORKFLOWS[0].id)
    useAgentWorkflowStore.getState().startExecution(BUILT_IN_WORKFLOWS[1].id)
    useAgentWorkflowStore.getState().clearExecutionHistory()
    expect(useAgentWorkflowStore.getState().executions).toHaveLength(0)
    expect(useAgentWorkflowStore.getState().activeExecutionId).toBeNull()
  })
})

// ── Variable Interpolation (indirect via built-in workflow templates) ──

describe('Workflow Template Variables', () => {
  it('Research Topic uses {{user_input}} in search args', () => {
    const wf = BUILT_IN_WORKFLOWS.find(w => w.name === 'Research Topic')!
    const searchStep = wf.steps.find(s => s.toolName === 'web_search')!
    expect(searchStep.toolArgTemplates?.query).toBe('{{user_input}}')
  })

  it('Research Topic uses {{last_output}} in fetch args', () => {
    const wf = BUILT_IN_WORKFLOWS.find(w => w.name === 'Research Topic')!
    const fetchStep = wf.steps.find(s => s.toolName === 'web_fetch')!
    expect(fetchStep.toolArgTemplates?.url).toBe('{{last_output}}')
  })

  it('memory_save step uses {{user_input}} and {{last_output}} in templates', () => {
    const wf = BUILT_IN_WORKFLOWS.find(w => w.name === 'Research Topic')!
    const saveStep = wf.steps.find(s => s.type === 'memory_save')!
    expect(saveStep.memorySave?.titleTemplate).toContain('{{user_input}}')
    expect(saveStep.memorySave?.contentTemplate).toContain('{{last_output}}')
  })
})

// ── Full Workflow Lifecycle E2E ─────────────────────────────────

describe('Workflow Lifecycle E2E', () => {
  beforeEach(resetStores)

  it('custom workflow: create → edit → duplicate → run → delete', () => {
    const store = useAgentWorkflowStore.getState()

    // Create
    const id = store.addWorkflow({
      name: 'My Workflow',
      description: 'Test flow',
      icon: 'Zap',
      steps: [
        { id: 's1', type: 'user_input', label: 'Ask', userInputPrompt: 'What?' },
        { id: 's2', type: 'memory_save', label: 'Save', memorySave: { type: 'project', titleTemplate: 'Result', contentTemplate: '{{last_output}}' } },
      ],
      variables: {},
      isBuiltIn: false,
    })

    // Edit
    useAgentWorkflowStore.getState().updateWorkflow(id, {
      name: 'My Workflow v2',
      steps: [
        { id: 's1', type: 'user_input', label: 'Ask updated', userInputPrompt: 'What now?' },
      ],
    })
    expect(useAgentWorkflowStore.getState().getWorkflow(id)!.name).toBe('My Workflow v2')
    expect(useAgentWorkflowStore.getState().getWorkflow(id)!.steps).toHaveLength(1)

    // Duplicate
    const copyId = useAgentWorkflowStore.getState().duplicateWorkflow(id)!
    expect(useAgentWorkflowStore.getState().getWorkflow(copyId)!.name).toBe('My Workflow v2 (copy)')

    // Start execution
    const execId = useAgentWorkflowStore.getState().startExecution(id)!
    expect(useAgentWorkflowStore.getState().executions[0].status).toBe('running')

    // Simulate step completion
    useAgentWorkflowStore.getState().addStepResult(execId, {
      stepId: 's1', status: 'completed', output: 'user typed something', startedAt: Date.now(),
    })
    expect(useAgentWorkflowStore.getState().executions[0].stepResults).toHaveLength(1)

    // Complete execution
    useAgentWorkflowStore.getState().updateExecution(execId, { status: 'completed', completedAt: Date.now() })
    expect(useAgentWorkflowStore.getState().executions[0].status).toBe('completed')

    // Delete custom
    useAgentWorkflowStore.getState().removeWorkflow(id)
    expect(useAgentWorkflowStore.getState().getWorkflow(id)).toBeUndefined()

    // Copy still exists
    expect(useAgentWorkflowStore.getState().getWorkflow(copyId)).toBeDefined()
  })
})
