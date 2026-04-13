import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from '../settingsStore'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../../lib/constants'
import type { Persona } from '../../types/settings'

function makePersona(id: string, overrides: Partial<Persona> = {}): Persona {
  return {
    id,
    name: `Persona ${id}`,
    icon: 'Zap',
    systemPrompt: `Prompt for ${id}`,
    isBuiltIn: false,
    ...overrides,
  }
}

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      personas: [...BUILT_IN_PERSONAS],
      activePersonaId: 'unrestricted',
    })
  })

  // ── updateSettings ─────────────────────────────────────────

  describe('updateSettings', () => {
    it('shallow-merges partial settings', () => {
      useSettingsStore.getState().updateSettings({ temperature: 0.5 })
      expect(useSettingsStore.getState().settings.temperature).toBe(0.5)
      // Other fields unchanged
      expect(useSettingsStore.getState().settings.topP).toBe(DEFAULT_SETTINGS.topP)
    })

    it('can update multiple fields at once', () => {
      useSettingsStore.getState().updateSettings({ temperature: 0.3, topK: 10, theme: 'light' })
      const s = useSettingsStore.getState().settings
      expect(s.temperature).toBe(0.3)
      expect(s.topK).toBe(10)
      expect(s.theme).toBe('light')
    })

    it('does not affect non-updated fields', () => {
      useSettingsStore.getState().updateSettings({ maxTokens: 2048 })
      expect(useSettingsStore.getState().settings.apiEndpoint).toBe(DEFAULT_SETTINGS.apiEndpoint)
      expect(useSettingsStore.getState().settings.onboardingDone).toBe(DEFAULT_SETTINGS.onboardingDone)
    })

    it('can update boolean fields', () => {
      useSettingsStore.getState().updateSettings({ thinkingEnabled: false })
      expect(useSettingsStore.getState().settings.thinkingEnabled).toBe(false)
    })
  })

  // ── resetSettings ──────────────────────────────────────────

  describe('resetSettings', () => {
    it('reverts all settings to defaults', () => {
      useSettingsStore.getState().updateSettings({ temperature: 0.1, theme: 'light', maxTokens: 9999 })
      useSettingsStore.getState().resetSettings()
      expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS)
    })

    it('does not affect personas or activePersonaId', () => {
      const custom = makePersona('custom-1')
      useSettingsStore.getState().addPersona(custom)
      useSettingsStore.getState().setActivePersona('custom-1')
      useSettingsStore.getState().resetSettings()
      expect(useSettingsStore.getState().activePersonaId).toBe('custom-1')
      expect(useSettingsStore.getState().personas.length).toBe(BUILT_IN_PERSONAS.length + 1)
    })
  })

  // ── addPersona ─────────────────────────────────────────────

  describe('addPersona', () => {
    it('appends a persona to the list', () => {
      const custom = makePersona('custom-1')
      useSettingsStore.getState().addPersona(custom)
      const personas = useSettingsStore.getState().personas
      expect(personas[personas.length - 1].id).toBe('custom-1')
      expect(personas.length).toBe(BUILT_IN_PERSONAS.length + 1)
    })

    it('preserves existing personas', () => {
      useSettingsStore.getState().addPersona(makePersona('c1'))
      useSettingsStore.getState().addPersona(makePersona('c2'))
      expect(useSettingsStore.getState().personas.length).toBe(BUILT_IN_PERSONAS.length + 2)
    })
  })

  // ── removePersona ──────────────────────────────────────────

  describe('removePersona', () => {
    it('removes the persona by id', () => {
      useSettingsStore.getState().addPersona(makePersona('custom-1'))
      useSettingsStore.getState().removePersona('custom-1')
      expect(useSettingsStore.getState().personas.find(p => p.id === 'custom-1')).toBeUndefined()
    })

    it('resets activePersonaId to unrestricted if removed persona was active', () => {
      useSettingsStore.getState().addPersona(makePersona('custom-1'))
      useSettingsStore.getState().setActivePersona('custom-1')
      useSettingsStore.getState().removePersona('custom-1')
      expect(useSettingsStore.getState().activePersonaId).toBe('unrestricted')
    })

    it('does not reset activePersonaId if a different persona is removed', () => {
      useSettingsStore.getState().addPersona(makePersona('c1'))
      useSettingsStore.getState().addPersona(makePersona('c2'))
      useSettingsStore.getState().setActivePersona('c2')
      useSettingsStore.getState().removePersona('c1')
      expect(useSettingsStore.getState().activePersonaId).toBe('c2')
    })

    it('is a no-op for non-existent id', () => {
      const before = useSettingsStore.getState().personas.length
      useSettingsStore.getState().removePersona('nonexistent')
      expect(useSettingsStore.getState().personas.length).toBe(before)
    })
  })

  // ── updatePersona ──────────────────────────────────────────

  describe('updatePersona', () => {
    it('merges partial updates into the persona', () => {
      useSettingsStore.getState().addPersona(makePersona('custom-1'))
      useSettingsStore.getState().updatePersona('custom-1', { name: 'Updated Name' })
      const updated = useSettingsStore.getState().personas.find(p => p.id === 'custom-1')!
      expect(updated.name).toBe('Updated Name')
      expect(updated.systemPrompt).toBe('Prompt for custom-1') // unchanged
    })

    it('can update systemPrompt', () => {
      useSettingsStore.getState().addPersona(makePersona('custom-1'))
      useSettingsStore.getState().updatePersona('custom-1', { systemPrompt: 'New prompt' })
      expect(useSettingsStore.getState().personas.find(p => p.id === 'custom-1')!.systemPrompt).toBe('New prompt')
    })

    it('does not affect other personas', () => {
      useSettingsStore.getState().addPersona(makePersona('c1'))
      useSettingsStore.getState().addPersona(makePersona('c2'))
      useSettingsStore.getState().updatePersona('c1', { name: 'Changed' })
      expect(useSettingsStore.getState().personas.find(p => p.id === 'c2')!.name).toBe('Persona c2')
    })
  })

  // ── getActivePersona ───────────────────────────────────────

  describe('getActivePersona', () => {
    it('returns the persona matching activePersonaId', () => {
      const persona = useSettingsStore.getState().getActivePersona()
      expect(persona).toBeDefined()
      expect(persona!.id).toBe('unrestricted')
    })

    it('returns a custom persona when it is active', () => {
      useSettingsStore.getState().addPersona(makePersona('custom-1'))
      useSettingsStore.getState().setActivePersona('custom-1')
      const active = useSettingsStore.getState().getActivePersona()
      expect(active!.id).toBe('custom-1')
    })

    it('returns undefined if activePersonaId matches no persona', () => {
      useSettingsStore.setState({ activePersonaId: 'nonexistent' })
      expect(useSettingsStore.getState().getActivePersona()).toBeUndefined()
    })
  })

  // ── setActivePersona ───────────────────────────────────────

  describe('setActivePersona', () => {
    it('sets the activePersonaId', () => {
      useSettingsStore.getState().setActivePersona('coder')
      expect(useSettingsStore.getState().activePersonaId).toBe('coder')
    })

    it('can switch between built-in personas', () => {
      useSettingsStore.getState().setActivePersona('coder')
      useSettingsStore.getState().setActivePersona('writer')
      expect(useSettingsStore.getState().activePersonaId).toBe('writer')
    })
  })
})
