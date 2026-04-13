/**
 * Built-in Workflows Tests
 *
 * Tests data integrity of BUILT_IN_WORKFLOWS from built-in-workflows.ts:
 * - Expected count and structure
 * - Step validity (tool/prompt fields, variable references)
 * - No duplicate IDs
 *
 * Run: npx vitest run src/lib/__tests__/built-in-workflows.test.ts
 */
import { describe, it, expect } from 'vitest'
import { BUILT_IN_WORKFLOWS } from '../built-in-workflows'
import type { WorkflowStepType } from '../../types/agent-workflows'

const VALID_STEP_TYPES: WorkflowStepType[] = ['prompt', 'tool', 'condition', 'loop', 'user_input', 'memory_save']

describe('built-in-workflows', () => {
  // ── Collection-level checks ──────────────────────────────────

  describe('BUILT_IN_WORKFLOWS', () => {
    it('has exactly 3 built-in workflows', () => {
      expect(BUILT_IN_WORKFLOWS).toHaveLength(3)
    })

    it('all workflows have isBuiltIn = true', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        expect(wf.isBuiltIn).toBe(true)
      }
    })

    it('all workflow IDs are unique', () => {
      const ids = BUILT_IN_WORKFLOWS.map(w => w.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all workflow names are unique', () => {
      const names = BUILT_IN_WORKFLOWS.map(w => w.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('all workflows have required fields', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        expect(typeof wf.id).toBe('string')
        expect(wf.id.length).toBeGreaterThan(0)
        expect(typeof wf.name).toBe('string')
        expect(wf.name.length).toBeGreaterThan(0)
        expect(typeof wf.description).toBe('string')
        expect(wf.description.length).toBeGreaterThan(0)
        expect(typeof wf.icon).toBe('string')
        expect(wf.icon.length).toBeGreaterThan(0)
        expect(Array.isArray(wf.steps)).toBe(true)
        expect(wf.steps.length).toBeGreaterThan(0)
        expect(typeof wf.variables).toBe('object')
        expect(typeof wf.createdAt).toBe('number')
        expect(typeof wf.updatedAt).toBe('number')
      }
    })

    it('all workflow IDs start with "builtin-"', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        expect(wf.id).toMatch(/^builtin-/)
      }
    })
  })

  // ── Step-level checks ────────────────────────────────────────

  describe('workflow steps', () => {
    it('all steps have valid type', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        for (const step of wf.steps) {
          expect(VALID_STEP_TYPES).toContain(step.type)
        }
      }
    })

    it('all steps have id and label', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        for (const step of wf.steps) {
          expect(typeof step.id).toBe('string')
          expect(step.id.length).toBeGreaterThan(0)
          expect(typeof step.label).toBe('string')
          expect(step.label.length).toBeGreaterThan(0)
        }
      }
    })

    it('all step IDs are unique within a workflow', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const stepIds = wf.steps.map(s => s.id)
        expect(new Set(stepIds).size).toBe(stepIds.length)
      }
    })

    it('tool steps have toolName defined', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const toolSteps = wf.steps.filter(s => s.type === 'tool')
        for (const step of toolSteps) {
          expect(typeof step.toolName).toBe('string')
          expect(step.toolName!.length).toBeGreaterThan(0)
        }
      }
    })

    it('tool steps have toolArgTemplates with variable references', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const toolSteps = wf.steps.filter(s => s.type === 'tool')
        for (const step of toolSteps) {
          expect(step.toolArgTemplates).toBeDefined()
          const templates = Object.values(step.toolArgTemplates!)
          expect(templates.length).toBeGreaterThan(0)
          // At least one template should contain {{...}} variable reference
          const hasVariable = templates.some(t => /\{\{.+?\}\}/.test(t))
          expect(hasVariable).toBe(true)
        }
      }
    })

    it('prompt steps have prompt defined', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const promptSteps = wf.steps.filter(s => s.type === 'prompt')
        for (const step of promptSteps) {
          expect(typeof step.prompt).toBe('string')
          expect(step.prompt!.length).toBeGreaterThan(0)
        }
      }
    })

    it('prompt steps reference variables with {{...}} syntax', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const promptSteps = wf.steps.filter(s => s.type === 'prompt')
        for (const step of promptSteps) {
          expect(step.prompt).toMatch(/\{\{.+?\}\}/)
        }
      }
    })

    it('user_input steps have userInputPrompt defined', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const inputSteps = wf.steps.filter(s => s.type === 'user_input')
        for (const step of inputSteps) {
          expect(typeof step.userInputPrompt).toBe('string')
          expect(step.userInputPrompt!.length).toBeGreaterThan(0)
        }
      }
    })

    it('memory_save steps have memorySave config', () => {
      for (const wf of BUILT_IN_WORKFLOWS) {
        const saveSteps = wf.steps.filter(s => s.type === 'memory_save')
        for (const step of saveSteps) {
          expect(step.memorySave).toBeDefined()
          expect(typeof step.memorySave!.type).toBe('string')
          expect(typeof step.memorySave!.titleTemplate).toBe('string')
          expect(typeof step.memorySave!.contentTemplate).toBe('string')
        }
      }
    })
  })

  // ── Individual workflow checks ───────────────────────────────

  describe('Research Topic workflow', () => {
    const research = BUILT_IN_WORKFLOWS.find(w => w.id === 'builtin-research-topic')!

    it('exists', () => {
      expect(research).toBeDefined()
    })

    it('has 6 steps', () => {
      expect(research.steps).toHaveLength(6)
    })

    it('starts with user_input', () => {
      expect(research.steps[0].type).toBe('user_input')
    })

    it('uses web_search and web_fetch tools', () => {
      const toolNames = research.steps
        .filter(s => s.type === 'tool')
        .map(s => s.toolName)
      expect(toolNames).toContain('web_search')
      expect(toolNames).toContain('web_fetch')
    })

    it('ends with memory_save step', () => {
      const last = research.steps[research.steps.length - 1]
      expect(last.type).toBe('memory_save')
    })

    it('memory_save has research tags', () => {
      const saveStep = research.steps.find(s => s.type === 'memory_save')!
      expect(saveStep.memorySave!.tags).toContain('research')
    })
  })

  describe('Summarize URL workflow', () => {
    const summarize = BUILT_IN_WORKFLOWS.find(w => w.id === 'builtin-summarize-url')!

    it('exists', () => {
      expect(summarize).toBeDefined()
    })

    it('has 3 steps', () => {
      expect(summarize.steps).toHaveLength(3)
    })

    it('starts with user_input for URL', () => {
      expect(summarize.steps[0].type).toBe('user_input')
      expect(summarize.steps[0].userInputPrompt).toContain('URL')
    })

    it('uses web_fetch tool', () => {
      const toolNames = summarize.steps
        .filter(s => s.type === 'tool')
        .map(s => s.toolName)
      expect(toolNames).toContain('web_fetch')
    })
  })

  describe('Code Review workflow', () => {
    const review = BUILT_IN_WORKFLOWS.find(w => w.id === 'builtin-code-review')!

    it('exists', () => {
      expect(review).toBeDefined()
    })

    it('has 3 steps', () => {
      expect(review.steps).toHaveLength(3)
    })

    it('starts with user_input for file path', () => {
      expect(review.steps[0].type).toBe('user_input')
      expect(review.steps[0].userInputPrompt).toContain('file')
    })

    it('uses file_read tool', () => {
      const toolNames = review.steps
        .filter(s => s.type === 'tool')
        .map(s => s.toolName)
      expect(toolNames).toContain('file_read')
    })

    it('review prompt mentions bugs and security', () => {
      const promptStep = review.steps.find(s => s.type === 'prompt')!
      expect(promptStep.prompt!.toLowerCase()).toContain('bug')
      expect(promptStep.prompt!.toLowerCase()).toContain('security')
    })
  })
})
