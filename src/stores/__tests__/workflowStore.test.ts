import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkflowStore } from '../workflowStore'
import type { WorkflowTemplate } from '../../types/workflows'

// ── Helpers ─────────────────────────────────────────────────────

function makeWorkflow(id: string, name: string, opts: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id,
    name,
    description: `Workflow ${name}`,
    source: 'manual',
    modelTypes: ['sdxl'],
    mode: 'image',
    workflow: { '1': { class_type: 'KSampler' } },
    parameterMap: {},
    installedAt: Date.now(),
    ...opts,
  }
}

const INITIAL_STATE = {
  installedWorkflows: [],
  modelTypeAssignments: {},
  modelNameAssignments: {},
  civitaiApiKey: '',
}

// ═══════════════════════════════════════════════════════════════
//  workflowStore
// ═══════════════════════════════════════════════════════════════

describe('workflowStore', () => {
  beforeEach(() => {
    useWorkflowStore.setState(INITIAL_STATE)
  })

  // ── Initial state ──────────────────────────────────────────

  describe('initial state', () => {
    it('has empty workflows and assignments', () => {
      const state = useWorkflowStore.getState()
      expect(state.installedWorkflows).toEqual([])
      expect(state.modelTypeAssignments).toEqual({})
      expect(state.modelNameAssignments).toEqual({})
      expect(state.civitaiApiKey).toBe('')
    })
  })

  // ── installWorkflow ────────────────────────────────────────

  describe('installWorkflow', () => {
    it('adds a workflow to the list', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'SDXL Basic'))
      expect(useWorkflowStore.getState().installedWorkflows).toHaveLength(1)
      expect(useWorkflowStore.getState().installedWorkflows[0].name).toBe('SDXL Basic')
    })

    it('prepends new workflows (most recent first)', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'First'))
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-2', 'Second'))
      const workflows = useWorkflowStore.getState().installedWorkflows
      expect(workflows[0].id).toBe('wf-2')
      expect(workflows[1].id).toBe('wf-1')
    })

    it('deduplicates by id — replaces existing with same id', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Original'))
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Updated'))
      const workflows = useWorkflowStore.getState().installedWorkflows
      expect(workflows).toHaveLength(1)
      expect(workflows[0].name).toBe('Updated')
    })

    it('deduplication moves updated workflow to front', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'First'))
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-2', 'Second'))
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'First Updated'))
      const workflows = useWorkflowStore.getState().installedWorkflows
      expect(workflows[0].id).toBe('wf-1')
      expect(workflows[0].name).toBe('First Updated')
      expect(workflows[1].id).toBe('wf-2')
    })

    it('handles multiple unique workflows', () => {
      for (let i = 0; i < 5; i++) {
        useWorkflowStore.getState().installWorkflow(makeWorkflow(`wf-${i}`, `Workflow ${i}`))
      }
      expect(useWorkflowStore.getState().installedWorkflows).toHaveLength(5)
    })
  })

  // ── removeWorkflow ─────────────────────────────────────────

  describe('removeWorkflow', () => {
    it('removes a workflow by id', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Test'))
      useWorkflowStore.getState().removeWorkflow('wf-1')
      expect(useWorkflowStore.getState().installedWorkflows).toHaveLength(0)
    })

    it('does nothing when id does not exist', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Test'))
      useWorkflowStore.getState().removeWorkflow('nonexistent')
      expect(useWorkflowStore.getState().installedWorkflows).toHaveLength(1)
    })

    it('cascades to modelTypeAssignments', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Test'))
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().removeWorkflow('wf-1')
      expect(useWorkflowStore.getState().modelTypeAssignments).toEqual({})
    })

    it('cascades to modelNameAssignments', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Test'))
      useWorkflowStore.getState().assignToModelName('sdxl_turbo.safetensors', 'wf-1')
      useWorkflowStore.getState().removeWorkflow('wf-1')
      expect(useWorkflowStore.getState().modelNameAssignments).toEqual({})
    })

    it('cascades to both assignment maps simultaneously', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'Test'))
      useWorkflowStore.getState().assignToModelType('flux', 'wf-1')
      useWorkflowStore.getState().assignToModelName('flux-model.safetensors', 'wf-1')
      useWorkflowStore.getState().removeWorkflow('wf-1')
      expect(useWorkflowStore.getState().modelTypeAssignments).toEqual({})
      expect(useWorkflowStore.getState().modelNameAssignments).toEqual({})
    })

    it('does not cascade assignments pointing to other workflows', () => {
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-1', 'One'))
      useWorkflowStore.getState().installWorkflow(makeWorkflow('wf-2', 'Two'))
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().assignToModelType('flux', 'wf-2')
      useWorkflowStore.getState().removeWorkflow('wf-1')
      expect(useWorkflowStore.getState().modelTypeAssignments).toEqual({ flux: 'wf-2' })
    })
  })

  // ── assignToModelType / unassignModelType ──────────────────

  describe('assignToModelType', () => {
    it('creates a model type to workflow mapping', () => {
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      expect(useWorkflowStore.getState().modelTypeAssignments['sdxl']).toBe('wf-1')
    })

    it('overwrites previous assignment for same type', () => {
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-2')
      expect(useWorkflowStore.getState().modelTypeAssignments['sdxl']).toBe('wf-2')
    })

    it('allows different types to map to same workflow', () => {
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().assignToModelType('flux', 'wf-1')
      expect(useWorkflowStore.getState().modelTypeAssignments['sdxl']).toBe('wf-1')
      expect(useWorkflowStore.getState().modelTypeAssignments['flux']).toBe('wf-1')
    })
  })

  describe('unassignModelType', () => {
    it('removes a model type assignment', () => {
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().unassignModelType('sdxl')
      expect(useWorkflowStore.getState().modelTypeAssignments['sdxl']).toBeUndefined()
    })

    it('does nothing for non-existent type', () => {
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().unassignModelType('flux')
      expect(useWorkflowStore.getState().modelTypeAssignments['sdxl']).toBe('wf-1')
    })
  })

  // ── assignToModelName / unassignModelName ──────────────────

  describe('assignToModelName', () => {
    it('creates a model name to workflow mapping', () => {
      useWorkflowStore.getState().assignToModelName('sdxl_turbo.safetensors', 'wf-1')
      expect(useWorkflowStore.getState().modelNameAssignments['sdxl_turbo.safetensors']).toBe('wf-1')
    })

    it('overwrites previous assignment for same name', () => {
      useWorkflowStore.getState().assignToModelName('model.safetensors', 'wf-1')
      useWorkflowStore.getState().assignToModelName('model.safetensors', 'wf-2')
      expect(useWorkflowStore.getState().modelNameAssignments['model.safetensors']).toBe('wf-2')
    })
  })

  describe('unassignModelName', () => {
    it('removes a model name assignment', () => {
      useWorkflowStore.getState().assignToModelName('model.safetensors', 'wf-1')
      useWorkflowStore.getState().unassignModelName('model.safetensors')
      expect(useWorkflowStore.getState().modelNameAssignments['model.safetensors']).toBeUndefined()
    })

    it('does nothing for non-existent name', () => {
      useWorkflowStore.getState().assignToModelName('model.safetensors', 'wf-1')
      useWorkflowStore.getState().unassignModelName('other.safetensors')
      expect(useWorkflowStore.getState().modelNameAssignments['model.safetensors']).toBe('wf-1')
    })
  })

  // ── getWorkflowForModel ────────────────────────────────────

  describe('getWorkflowForModel', () => {
    it('returns null when no assignments exist', () => {
      const wf = useWorkflowStore.getState().getWorkflowForModel('model.safetensors', 'sdxl')
      expect(wf).toBeNull()
    })

    it('returns workflow matched by model name (priority 1)', () => {
      const workflow = makeWorkflow('wf-name', 'Name Match')
      useWorkflowStore.getState().installWorkflow(workflow)
      useWorkflowStore.getState().assignToModelName('specific.safetensors', 'wf-name')
      const result = useWorkflowStore.getState().getWorkflowForModel('specific.safetensors', 'sdxl')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('wf-name')
    })

    it('returns workflow matched by model type (priority 2)', () => {
      const workflow = makeWorkflow('wf-type', 'Type Match')
      useWorkflowStore.getState().installWorkflow(workflow)
      useWorkflowStore.getState().assignToModelType('flux', 'wf-type')
      const result = useWorkflowStore.getState().getWorkflowForModel('any-flux.safetensors', 'flux')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('wf-type')
    })

    it('name override takes priority over type', () => {
      const wfType = makeWorkflow('wf-type', 'Type Workflow')
      const wfName = makeWorkflow('wf-name', 'Name Workflow')
      useWorkflowStore.getState().installWorkflow(wfType)
      useWorkflowStore.getState().installWorkflow(wfName)
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-type')
      useWorkflowStore.getState().assignToModelName('special.safetensors', 'wf-name')
      const result = useWorkflowStore.getState().getWorkflowForModel('special.safetensors', 'sdxl')
      expect(result!.id).toBe('wf-name')
    })

    it('falls back to type when name has no match', () => {
      const wfType = makeWorkflow('wf-type', 'Type Workflow')
      useWorkflowStore.getState().installWorkflow(wfType)
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-type')
      const result = useWorkflowStore.getState().getWorkflowForModel('unassigned.safetensors', 'sdxl')
      expect(result!.id).toBe('wf-type')
    })

    it('returns null when assigned workflow is not installed', () => {
      useWorkflowStore.getState().assignToModelType('sdxl', 'deleted-wf')
      const result = useWorkflowStore.getState().getWorkflowForModel('model.safetensors', 'sdxl')
      expect(result).toBeNull()
    })

    it('returns null when name assignment points to missing workflow', () => {
      useWorkflowStore.getState().assignToModelName('model.safetensors', 'deleted-wf')
      // Should fall through to type check, which also finds nothing
      const result = useWorkflowStore.getState().getWorkflowForModel('model.safetensors', 'sdxl')
      expect(result).toBeNull()
    })

    it('falls back to type when name assignment points to missing workflow', () => {
      const wfType = makeWorkflow('wf-type', 'Type Fallback')
      useWorkflowStore.getState().installWorkflow(wfType)
      useWorkflowStore.getState().assignToModelName('model.safetensors', 'deleted-wf')
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-type')
      const result = useWorkflowStore.getState().getWorkflowForModel('model.safetensors', 'sdxl')
      expect(result!.id).toBe('wf-type')
    })
  })

  // ── setCivitaiApiKey ───────────────────────────────────────

  describe('setCivitaiApiKey', () => {
    it('sets the CivitAI API key', () => {
      useWorkflowStore.getState().setCivitaiApiKey('civitai-key-123')
      expect(useWorkflowStore.getState().civitaiApiKey).toBe('civitai-key-123')
    })

    it('can clear the key', () => {
      useWorkflowStore.getState().setCivitaiApiKey('key')
      useWorkflowStore.getState().setCivitaiApiKey('')
      expect(useWorkflowStore.getState().civitaiApiKey).toBe('')
    })
  })

  // ── Integration scenarios ──────────────────────────────────

  describe('integration', () => {
    it('full lifecycle: install, assign, query, remove', () => {
      const wf = makeWorkflow('wf-1', 'My Custom SDXL')
      useWorkflowStore.getState().installWorkflow(wf)
      useWorkflowStore.getState().assignToModelType('sdxl', 'wf-1')
      useWorkflowStore.getState().assignToModelName('special-sdxl.safetensors', 'wf-1')

      // Query by name
      expect(useWorkflowStore.getState().getWorkflowForModel('special-sdxl.safetensors', 'sdxl')!.id).toBe('wf-1')
      // Query by type
      expect(useWorkflowStore.getState().getWorkflowForModel('other-sdxl.safetensors', 'sdxl')!.id).toBe('wf-1')

      // Remove
      useWorkflowStore.getState().removeWorkflow('wf-1')
      expect(useWorkflowStore.getState().getWorkflowForModel('special-sdxl.safetensors', 'sdxl')).toBeNull()
      expect(useWorkflowStore.getState().getWorkflowForModel('other-sdxl.safetensors', 'sdxl')).toBeNull()
    })
  })
})
