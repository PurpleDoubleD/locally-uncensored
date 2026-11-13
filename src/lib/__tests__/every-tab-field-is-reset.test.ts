/**
 * Jaeger B, B10: "Reset General to defaults" left Think budget standing and
 * "Reset Agent to defaults" left the sub-agent limits, although both fields
 * sit in those tabs. Every field a tab writes has to be in that tab's reset.
 *
 * Run: npx vitest run src/lib/__tests__/every-tab-field-is-reset.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../constants'
import { SETTINGS_TAB_RESET_KEYS, type SettingsTab } from '../settings-reset'

const { runSettingsReset } = await import('../run-settings-reset')

const page = readFileSync(join(__dirname, '../../components/settings/SettingsPage.tsx'), 'utf8')

/** The settings keys a stretch of SettingsPage.tsx writes. */
function writtenKeys(from: string, to: string): string[] {
  const start = page.indexOf(from)
  const end = page.indexOf(to, start + from.length)
  expect(start, from).toBeGreaterThan(-1)
  expect(end, to).toBeGreaterThan(start)
  return [...page.slice(start, end).matchAll(/updateSettings\(\{\s*(\w+)\s*:/g)].map((m) => m[1])
}

// The AI Backends and Voice tabs write through their own components and
// stores, the section-reset tests cover those.
const TABS: Partial<Record<SettingsTab, string[]>> = {
  general: writtenKeys("{tab === 'general' && (<>", "{tab === 'backends' && (<>"),
  agent: [
    ...writtenKeys("{tab === 'agent' && (<>", "{tab === 'voice-remote' && (<>"),
    // Rendered inside the Agent tab.
    ...writtenKeys('function CodexAgentSettings()', '\n}\n'),
  ],
}

beforeEach(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } }))

describe('B10: a tab reset covers every field of that tab', () => {
  for (const [tab, keys] of Object.entries(TABS)) {
    it(`${tab}: every field written in the tab is reset`, () => {
      expect(keys.length).toBeGreaterThan(0)
      const owned = SETTINGS_TAB_RESET_KEYS[tab as SettingsTab] as string[]
      expect(keys.filter((k) => !owned.includes(k))).toEqual([])
    })
  }

  it('Reset General restores Think budget', () => {
    useSettingsStore.getState().updateSettings({ thinkingBudget: 2048, maxTokens: 999 })
    runSettingsReset('section', 'general')
    expect(useSettingsStore.getState().settings.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget)
    expect(useSettingsStore.getState().settings.maxTokens).toBe(DEFAULT_SETTINGS.maxTokens)
  })

  it('Reset Agent restores the sub-agent limits and the /loop passes', () => {
    useSettingsStore.getState().updateSettings({ subAgentMaxToolCalls: 50, subAgentMaxIterations: 20, loopMaxPasses: 7 })
    runSettingsReset('section', 'agent')
    const s = useSettingsStore.getState().settings
    expect([s.subAgentMaxToolCalls, s.subAgentMaxIterations, s.loopMaxPasses])
      .toEqual([DEFAULT_SETTINGS.subAgentMaxToolCalls, DEFAULT_SETTINGS.subAgentMaxIterations, DEFAULT_SETTINGS.loopMaxPasses])
  })
})
