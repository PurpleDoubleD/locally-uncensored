/**
 * Jaeger B, B2: "Reset all settings" left the AI Backends as they were,
 * while "Reset AI Backends to defaults" restored them. "Everything" has to
 * cover at least what every section reset covers, and still keep content.
 *
 * Run: npx vitest run src/lib/__tests__/reset-all-covers-every-section.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useMCPStore } from '../../stores/mcpStore'
import { DEFAULT_SETTINGS } from '../constants'

const { runSettingsReset } = await import('../run-settings-reset')

const ollama = () => useProviderStore.getState().providers.ollama

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useProviderStore.getState().resetProvidersToDefaults()
  usePermissionStore.getState().resetToDefaults()
  useVoiceStore.getState().resetVoiceDefaults()
})

/** A state that differs from the shipped one in every store a reset owns. */
function dirty() {
  useSettingsStore.getState().updateSettings({ temperature: 1.9, agentMaxToolCalls: 3, remotePageTitle: 'mine' })
  useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://127.0.0.1:18903' })
  usePermissionStore.getState().setToolOverride('shell_execute', 'blocked')
  useVoiceStore.setState({ ttsRate: 1.7 })
}

/** What each store looks like, for comparing one reset with the other. */
const snapshot = () => JSON.stringify({
  settings: useSettingsStore.getState().settings,
  providers: useProviderStore.getState().providers,
  permissions: usePermissionStore.getState().perToolOverrides,
  voice: useVoiceStore.getState().ttsRate,
})

describe('Reset all settings', () => {
  it('restores the AI Backends like the backends section reset does', () => {
    dirty()
    runSettingsReset('section', 'backends')
    const afterSection = ollama().baseUrl

    dirty()
    runSettingsReset('all', 'general')
    expect(ollama().baseUrl).toBe(afterSection)
    expect(ollama().baseUrl).toBe('http://localhost:11434')
    expect(useSettingsStore.getState().settings.temperature).toBe(DEFAULT_SETTINGS.temperature)
  })

  it('restores at least what every section reset restores, from any tab', () => {
    const tabs = ['general', 'backends', 'agent', 'voice-remote'] as const
    dirty()
    for (const t of tabs) runSettingsReset('section', t)
    const allSections = snapshot()
    for (const pressedOn of tabs) {
      dirty()
      runSettingsReset('all', pressedOn)
      expect(snapshot(), `Reset all on ${pressedOn}`).toBe(allSections)
    }
  })

  it('keeps content: personas and MCP servers', () => {
    useSettingsStore.setState({ personas: [{ id: 'p1', name: 'Mine', icon: 'x', systemPrompt: 's', isCustom: true }] } as never)
    useMCPStore.setState({ servers: [{ id: 'm1', name: 'fs', command: 'npx', args: [], enabled: true }] })
    runSettingsReset('all', 'agent')
    expect(useSettingsStore.getState().personas.map((p) => p.id)).toContain('p1')
    expect(useMCPStore.getState().servers.map((s) => s.id)).toEqual(['m1'])
  })
})
