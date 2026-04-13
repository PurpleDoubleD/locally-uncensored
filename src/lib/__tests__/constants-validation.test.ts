/**
 * Constants Validation Tests
 *
 * Tests data integrity of exported constants from constants.ts:
 * - DEFAULT_SETTINGS — required fields + valid types
 * - BUILT_IN_PERSONAS — structure, uniqueness
 * - ONBOARDING_MODELS — structure, URLs, uniqueness
 * - CAVEMAN_PROMPTS — all levels present
 * - CAVEMAN_REMINDERS — all levels present
 * - FEATURE_FLAGS — valid booleans
 *
 * Run: npx vitest run src/lib/__tests__/constants-validation.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  BUILT_IN_PERSONAS,
  ONBOARDING_MODELS,
  CAVEMAN_PROMPTS,
  CAVEMAN_REMINDERS,
  FEATURE_FLAGS,
} from '../constants'

describe('constants-validation', () => {
  // ── DEFAULT_SETTINGS ─────────────────────────────────────────

  describe('DEFAULT_SETTINGS', () => {
    it('has apiEndpoint as a string', () => {
      expect(typeof DEFAULT_SETTINGS.apiEndpoint).toBe('string')
      expect(DEFAULT_SETTINGS.apiEndpoint.length).toBeGreaterThan(0)
    })

    it('has temperature as a number between 0 and 2', () => {
      expect(typeof DEFAULT_SETTINGS.temperature).toBe('number')
      expect(DEFAULT_SETTINGS.temperature).toBeGreaterThanOrEqual(0)
      expect(DEFAULT_SETTINGS.temperature).toBeLessThanOrEqual(2)
    })

    it('has topP as a number between 0 and 1', () => {
      expect(typeof DEFAULT_SETTINGS.topP).toBe('number')
      expect(DEFAULT_SETTINGS.topP).toBeGreaterThanOrEqual(0)
      expect(DEFAULT_SETTINGS.topP).toBeLessThanOrEqual(1)
    })

    it('has topK as a positive number', () => {
      expect(typeof DEFAULT_SETTINGS.topK).toBe('number')
      expect(DEFAULT_SETTINGS.topK).toBeGreaterThan(0)
    })

    it('has maxTokens as a number', () => {
      expect(typeof DEFAULT_SETTINGS.maxTokens).toBe('number')
    })

    it('has theme as light or dark', () => {
      expect(['light', 'dark']).toContain(DEFAULT_SETTINGS.theme)
    })

    it('has onboardingDone as boolean', () => {
      expect(typeof DEFAULT_SETTINGS.onboardingDone).toBe('boolean')
    })

    it('has thinkingEnabled as boolean', () => {
      expect(typeof DEFAULT_SETTINGS.thinkingEnabled).toBe('boolean')
    })

    it('has cavemanMode as a valid level', () => {
      expect(['off', 'lite', 'full', 'ultra']).toContain(DEFAULT_SETTINGS.cavemanMode)
    })

    it('has searchProvider as a valid value', () => {
      expect(['auto', 'brave', 'tavily']).toContain(DEFAULT_SETTINGS.searchProvider)
    })

    it('has braveApiKey as string', () => {
      expect(typeof DEFAULT_SETTINGS.braveApiKey).toBe('string')
    })

    it('has tavilyApiKey as string', () => {
      expect(typeof DEFAULT_SETTINGS.tavilyApiKey).toBe('string')
    })

    it('has Claude Code fields', () => {
      expect(typeof DEFAULT_SETTINGS.claudeCodeModel).toBe('string')
      expect(typeof DEFAULT_SETTINGS.claudeCodeAutoApprove).toBe('boolean')
      expect(typeof DEFAULT_SETTINGS.claudeCodePath).toBe('string')
    })
  })

  // ── BUILT_IN_PERSONAS ────────────────────────────────────────

  describe('BUILT_IN_PERSONAS', () => {
    it('has at least 5 personas', () => {
      expect(BUILT_IN_PERSONAS.length).toBeGreaterThanOrEqual(5)
    })

    it('all personas have required fields', () => {
      for (const persona of BUILT_IN_PERSONAS) {
        expect(typeof persona.id).toBe('string')
        expect(persona.id.length).toBeGreaterThan(0)
        expect(typeof persona.name).toBe('string')
        expect(persona.name.length).toBeGreaterThan(0)
        expect(typeof persona.icon).toBe('string')
        expect(persona.icon.length).toBeGreaterThan(0)
        expect(typeof persona.systemPrompt).toBe('string')
        expect(persona.isBuiltIn).toBe(true)
      }
    })

    it('all persona IDs are unique', () => {
      const ids = BUILT_IN_PERSONAS.map(p => p.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })

    it('contains the "assistant" default persona', () => {
      const assistant = BUILT_IN_PERSONAS.find(p => p.id === 'assistant')
      expect(assistant).toBeDefined()
      expect(assistant!.systemPrompt.length).toBeGreaterThan(0)
    })

    it('contains the "coder" persona', () => {
      const coder = BUILT_IN_PERSONAS.find(p => p.id === 'coder')
      expect(coder).toBeDefined()
    })

    it('contains the "unrestricted" persona with empty system prompt', () => {
      const unrestricted = BUILT_IN_PERSONAS.find(p => p.id === 'unrestricted')
      expect(unrestricted).toBeDefined()
      expect(unrestricted!.systemPrompt).toBe('')
    })

    it('all persona names are unique', () => {
      const names = BUILT_IN_PERSONAS.map(p => p.name)
      const uniqueNames = new Set(names)
      expect(uniqueNames.size).toBe(names.length)
    })
  })

  // ── ONBOARDING_MODELS ────────────────────────────────────────

  describe('ONBOARDING_MODELS', () => {
    it('has at least 10 models', () => {
      expect(ONBOARDING_MODELS.length).toBeGreaterThanOrEqual(10)
    })

    it('all models have required fields', () => {
      for (const model of ONBOARDING_MODELS) {
        expect(typeof model.name).toBe('string')
        expect(model.name.length).toBeGreaterThan(0)
        expect(typeof model.label).toBe('string')
        expect(model.label.length).toBeGreaterThan(0)
        expect(typeof model.description).toBe('string')
        expect(model.description.length).toBeGreaterThan(0)
        expect(typeof model.size).toBe('string')
        expect(typeof model.vram).toBe('string')
        expect(typeof model.vramGB).toBe('number')
        expect(model.vramGB).toBeGreaterThan(0)
      }
    })

    it('all models have valid download URLs', () => {
      for (const model of ONBOARDING_MODELS) {
        expect(typeof model.downloadUrl).toBe('string')
        expect(model.downloadUrl).toContain('huggingface.co')
        expect(model.downloadUrl).toContain('/resolve/main/')
      }
    })

    it('all models have valid filenames ending in .gguf', () => {
      for (const model of ONBOARDING_MODELS) {
        expect(typeof model.filename).toBe('string')
        expect(model.filename.toLowerCase()).toMatch(/\.gguf$/)
      }
    })

    it('all models have sizeGB > 0', () => {
      for (const model of ONBOARDING_MODELS) {
        expect(typeof model.sizeGB).toBe('number')
        expect(model.sizeGB).toBeGreaterThan(0)
      }
    })

    it('all model names are unique', () => {
      const names = ONBOARDING_MODELS.map(m => m.name)
      const uniqueNames = new Set(names)
      expect(uniqueNames.size).toBe(names.length)
    })

    it('has both uncensored and mainstream models', () => {
      const uncensored = ONBOARDING_MODELS.filter(m => m.uncensored === true)
      const mainstream = ONBOARDING_MODELS.filter(m => !m.uncensored)
      expect(uncensored.length).toBeGreaterThan(0)
      expect(mainstream.length).toBeGreaterThan(0)
    })

    it('has at least one recommended model', () => {
      const recommended = ONBOARDING_MODELS.filter(m => m.recommended === true)
      expect(recommended.length).toBeGreaterThan(0)
    })

    it('has at least one agent-capable model', () => {
      const agents = ONBOARDING_MODELS.filter(m => m.agent === true)
      expect(agents.length).toBeGreaterThan(0)
    })

    it('downloadUrl contains the filename', () => {
      for (const model of ONBOARDING_MODELS) {
        expect(model.downloadUrl).toContain(model.filename)
      }
    })
  })

  // ── CAVEMAN_PROMPTS ──────────────────────────────────────────

  describe('CAVEMAN_PROMPTS', () => {
    it('has all 3 levels: lite, full, ultra', () => {
      expect(CAVEMAN_PROMPTS).toHaveProperty('lite')
      expect(CAVEMAN_PROMPTS).toHaveProperty('full')
      expect(CAVEMAN_PROMPTS).toHaveProperty('ultra')
    })

    it('all prompts are non-empty strings', () => {
      expect(typeof CAVEMAN_PROMPTS.lite).toBe('string')
      expect(CAVEMAN_PROMPTS.lite.length).toBeGreaterThan(0)
      expect(typeof CAVEMAN_PROMPTS.full).toBe('string')
      expect(CAVEMAN_PROMPTS.full.length).toBeGreaterThan(0)
      expect(typeof CAVEMAN_PROMPTS.ultra).toBe('string')
      expect(CAVEMAN_PROMPTS.ultra.length).toBeGreaterThan(0)
    })

    it('ultra is the most restrictive (contains brevity keywords)', () => {
      expect(CAVEMAN_PROMPTS.ultra.toLowerCase()).toContain('brevity')
    })

    it('lite preserves grammar (mentions grammar or articles)', () => {
      const lite = CAVEMAN_PROMPTS.lite.toLowerCase()
      expect(lite).toContain('grammar')
    })

    it('all levels contain "ACTIVE EVERY RESPONSE" or style enforcement', () => {
      // All prompts should have some enforcement mechanism
      for (const level of ['lite', 'full', 'ultra'] as const) {
        const prompt = CAVEMAN_PROMPTS[level].toLowerCase()
        const hasEnforcement = prompt.includes('every response') || prompt.includes('active')
        expect(hasEnforcement).toBe(true)
      }
    })
  })

  // ── CAVEMAN_REMINDERS ────────────────────────────────────────

  describe('CAVEMAN_REMINDERS', () => {
    it('has all 3 levels: lite, full, ultra', () => {
      expect(CAVEMAN_REMINDERS).toHaveProperty('lite')
      expect(CAVEMAN_REMINDERS).toHaveProperty('full')
      expect(CAVEMAN_REMINDERS).toHaveProperty('ultra')
    })

    it('all reminders are non-empty strings', () => {
      expect(typeof CAVEMAN_REMINDERS.lite).toBe('string')
      expect(CAVEMAN_REMINDERS.lite.length).toBeGreaterThan(0)
      expect(typeof CAVEMAN_REMINDERS.full).toBe('string')
      expect(CAVEMAN_REMINDERS.full.length).toBeGreaterThan(0)
      expect(typeof CAVEMAN_REMINDERS.ultra).toBe('string')
      expect(CAVEMAN_REMINDERS.ultra.length).toBeGreaterThan(0)
    })

    it('all reminders are wrapped in square brackets', () => {
      for (const level of ['lite', 'full', 'ultra'] as const) {
        expect(CAVEMAN_REMINDERS[level]).toMatch(/^\[.*\]$/)
      }
    })

    it('reminders are shorter than prompts', () => {
      for (const level of ['lite', 'full', 'ultra'] as const) {
        expect(CAVEMAN_REMINDERS[level].length).toBeLessThan(CAVEMAN_PROMPTS[level].length)
      }
    })
  })

  // ── FEATURE_FLAGS ────────────────────────────────────────────

  describe('FEATURE_FLAGS', () => {
    it('has AGENT_MODE as boolean', () => {
      expect(typeof FEATURE_FLAGS.AGENT_MODE).toBe('boolean')
    })

    it('has AGENT_WORKFLOWS as boolean', () => {
      expect(typeof FEATURE_FLAGS.AGENT_WORKFLOWS).toBe('boolean')
    })

    it('all flags are booleans', () => {
      for (const [key, value] of Object.entries(FEATURE_FLAGS)) {
        expect(typeof value).toBe('boolean')
      }
    })
  })
})
