/**
 * Built-in engine as the default backend (2.5.7) — P2.
 *
 * A fresh provider store must default to the app-managed built-in engine (in the
 * `openai` slot) instead of Ollama, so a clean install can chat with zero
 * external install. Also pins `isManagedBuiltinActive()`, which routes the
 * model list to `list_bundled_models`.
 *
 * Run: npx vitest run src/api/__tests__/builtin-default-provider.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useProviderStore } from '../../stores/providerStore'
import { isManagedBuiltinActive } from '../engine'

// Snapshot the pristine defaults before any test mutates the store.
const DEFAULTS = structuredClone(useProviderStore.getState().providers)

beforeEach(() => {
  useProviderStore.setState({ providers: structuredClone(DEFAULTS) })
})

describe('default provider = built-in engine', () => {
  it('enables the managed built-in engine in the openai slot', () => {
    const openai = useProviderStore.getState().providers.openai
    expect(openai.enabled).toBe(true)
    expect(openai.managed).toBe(true)
    expect(openai.isLocal).toBe(true)
    expect(openai.name).toBe('LU Engine')
    expect(openai.baseUrl).toBe('http://127.0.0.1:8127/v1')
    expect(openai.apiKey).toBe('')
  })

  it('disables Ollama by default (available as Advanced)', () => {
    expect(useProviderStore.getState().providers.ollama.enabled).toBe(false)
  })

  it('exposes the built-in engine as the only enabled provider', () => {
    const enabled = useProviderStore.getState().getEnabledProviders()
    expect(enabled.map(p => p.id)).toEqual(['openai'])
    expect(enabled[0].managed).toBe(true)
  })
})

describe('isManagedBuiltinActive', () => {
  it('is true for the default managed engine', () => {
    expect(isManagedBuiltinActive()).toBe(true)
  })

  it('is false once the openai slot is repointed at a user backend (LM Studio)', () => {
    useProviderStore.getState().setProviderConfig('openai', {
      name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', managed: false,
    })
    expect(isManagedBuiltinActive()).toBe(false)
  })

  it('is false when the openai slot is disabled', () => {
    useProviderStore.getState().setProviderConfig('openai', { enabled: false })
    expect(isManagedBuiltinActive()).toBe(false)
  })
})
