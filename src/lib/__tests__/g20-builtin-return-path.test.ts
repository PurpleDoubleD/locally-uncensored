/**
 * G20 leftovers (2026-08-07): an existing user whose openai slot was adopted
 * by LM Studio had no UI way back to the Built-in Engine, because "Reset AI
 * Backends" only reset settings KEYS and never touched the provider store.
 * And in Cloud mode the picker hides every local model without saying so,
 * which reads as "my local models are gone" (it cost a whole repro round).
 *
 * Run: npx vitest run src/lib/__tests__/g20-builtin-return-path.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { useProviderStore } from '../../stores/providerStore'
import { PROVIDER_PRESETS } from '../../api/providers/types'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

describe('resetProvidersToDefaults hands the slot back to the Built-in Engine', () => {
  beforeEach(() => {
    // The G20 shape: LM Studio adopted the openai slot, a key sits on
    // anthropic, the account has cloud enabled.
    useProviderStore.getState().setProviderConfig('openai', {
      enabled: true, name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', managed: false,
    })
    useProviderStore.getState().setProviderConfig('anthropic', { apiKey: 'obfuscated-key' })
    useProviderStore.getState().setProviderConfig('lu-cloud', { enabled: true })
  })

  it('restores the shipped Built-in slot', () => {
    useProviderStore.getState().resetProvidersToDefaults()
    const openai = useProviderStore.getState().providers.openai
    expect(openai.name).toBe('LU Engine')
    expect(openai.managed).toBe(true)
    expect(openai.enabled).toBe(true)
    expect(openai.baseUrl).toBe('http://127.0.0.1:8127/v1')
  })

  it('NEGATIVE CONTROL: stored API keys survive the reset', () => {
    useProviderStore.getState().resetProvidersToDefaults()
    expect(useProviderStore.getState().providers.anthropic.apiKey).toBe('obfuscated-key')
  })

  it('NEGATIVE CONTROL: the LU Cloud account flag survives the reset', () => {
    useProviderStore.getState().resetProvidersToDefaults()
    expect(useProviderStore.getState().providers['lu-cloud'].enabled).toBe(true)
    // but its CONFIG is back to shipped values
    expect(useProviderStore.getState().providers['lu-cloud'].isLocal).toBe(false)
  })
})

describe('wiring and the second G20 leftover', () => {
  it('the backends tab reset actually calls the store reset', () => {
    // The two reset buttons live in lib/run-settings-reset.ts since B2.
    const page = read('../../components/settings/SettingsPage.tsx')
    expect(page).toContain('runSettingsReset(which, tab)')
    expect(read('../run-settings-reset.ts')).toContain("if (tab === 'backends') useProviderStore.getState().resetProvidersToDefaults()")
  })

  it('the Add Provider path to the Built-in Engine exists as a preset', () => {
    const builtin = PROVIDER_PRESETS.find((p) => p.id === 'builtin')
    expect(builtin?.managed).toBe(true)
    expect(builtin?.isLocal).toBe(true)
  })

  it('the picker says WHY local models are hidden in Cloud mode', () => {
    // Since the picker of 3.0.5 the sentence stands behind the count in the
    // footer of the Cloud picker ("47 cloud models"), no longer as a standing
    // band over the list. The count names the mode, the hover says the rest.
    const picker = read('../../components/models/CloudModelPicker.tsx')
    expect(picker).toContain('Cloud mode shows hosted models only. Switch the app to Local mode')
    expect(picker).toContain('title={CLOUD_MODE_LIST_NOTE}')
    expect(picker).toMatch(/\$\{rows\.length\} cloud \$\{rows\.length === 1 \? 'model' : 'models'\}/)
    expect(read('../../components/models/ModelSelector.tsx')).toContain("const cloudPicker = appMode === 'cloud'")
  })

  it('NEGATIVE CONTROL: the cloud-mode filter itself is untouched, only named', () => {
    expect(read('../../hooks/useModels.ts')).toContain(
      "appMode === 'cloud' ? m.provider === 'lu-cloud' : m.provider !== 'lu-cloud'",
    )
  })
})
