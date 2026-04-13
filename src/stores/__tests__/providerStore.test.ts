import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the registry before importing the store
vi.mock('../../api/providers/registry', () => ({
  clearProviderCache: vi.fn(),
}))

import { useProviderStore } from '../providerStore'
import { clearProviderCache } from '../../api/providers/registry'

// ── Default state snapshot ────────────────────────────────────

const DEFAULT_PROVIDERS = {
  ollama: {
    id: 'ollama' as const,
    name: 'Ollama',
    enabled: true,
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    isLocal: true,
  },
  openai: {
    id: 'openai' as const,
    name: 'LM Studio',
    enabled: false,
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    isLocal: true,
  },
  anthropic: {
    id: 'anthropic' as const,
    name: 'Anthropic',
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    isLocal: false,
  },
}

// ═══════════════════════════════════════════════════════════════
//  providerStore
// ═══════════════════════════════════════════════════════════════

describe('providerStore', () => {
  beforeEach(() => {
    useProviderStore.setState({ providers: structuredClone(DEFAULT_PROVIDERS) })
    vi.clearAllMocks()
  })

  // ── Initial state ──────────────────────────────────────────

  describe('initial state', () => {
    it('has three default providers', () => {
      const providers = useProviderStore.getState().providers
      expect(Object.keys(providers)).toHaveLength(3)
      expect(providers.ollama).toBeDefined()
      expect(providers.openai).toBeDefined()
      expect(providers.anthropic).toBeDefined()
    })

    it('only ollama is enabled by default', () => {
      const providers = useProviderStore.getState().providers
      expect(providers.ollama.enabled).toBe(true)
      expect(providers.openai.enabled).toBe(false)
      expect(providers.anthropic.enabled).toBe(false)
    })

    it('ollama and openai are local, anthropic is not', () => {
      const providers = useProviderStore.getState().providers
      expect(providers.ollama.isLocal).toBe(true)
      expect(providers.openai.isLocal).toBe(true)
      expect(providers.anthropic.isLocal).toBe(false)
    })
  })

  // ── API key obfuscation roundtrip ──────────────────────────

  describe('API key obfuscation', () => {
    it('roundtrips a key through setProviderApiKey / getProviderApiKey', () => {
      useProviderStore.getState().setProviderApiKey('anthropic', 'sk-ant-secret-key-123')
      const retrieved = useProviderStore.getState().getProviderApiKey('anthropic')
      expect(retrieved).toBe('sk-ant-secret-key-123')
    })

    it('stores the key in obfuscated form, not plaintext', () => {
      useProviderStore.getState().setProviderApiKey('anthropic', 'my-secret')
      const rawKey = useProviderStore.getState().providers.anthropic.apiKey
      expect(rawKey).not.toBe('my-secret')
      expect(rawKey).not.toBe('')
    })

    it('handles empty key', () => {
      useProviderStore.getState().setProviderApiKey('anthropic', '')
      const retrieved = useProviderStore.getState().getProviderApiKey('anthropic')
      expect(retrieved).toBe('')
    })

    it('roundtrips special characters', () => {
      const specialKey = 'sk-abc+/=!@#$%'
      useProviderStore.getState().setProviderApiKey('openai', specialKey)
      expect(useProviderStore.getState().getProviderApiKey('openai')).toBe(specialKey)
    })

    it('calls clearProviderCache on setProviderApiKey', () => {
      useProviderStore.getState().setProviderApiKey('anthropic', 'key')
      expect(clearProviderCache).toHaveBeenCalled()
    })
  })

  // ── getEnabledProviders ────────────────────────────────────

  describe('getEnabledProviders', () => {
    it('returns only enabled providers', () => {
      const enabled = useProviderStore.getState().getEnabledProviders()
      expect(enabled).toHaveLength(1)
      expect(enabled[0].id).toBe('ollama')
    })

    it('returns multiple when several are enabled', () => {
      useProviderStore.getState().setProviderConfig('openai', { enabled: true })
      useProviderStore.getState().setProviderConfig('anthropic', { enabled: true })
      const enabled = useProviderStore.getState().getEnabledProviders()
      expect(enabled).toHaveLength(3)
    })

    it('returns empty array when none are enabled', () => {
      useProviderStore.getState().setProviderConfig('ollama', { enabled: false })
      const enabled = useProviderStore.getState().getEnabledProviders()
      expect(enabled).toHaveLength(0)
    })

    it('deobfuscates API keys in the returned configs', () => {
      useProviderStore.getState().setProviderApiKey('anthropic', 'my-key-here')
      useProviderStore.getState().setProviderConfig('anthropic', { enabled: true })
      const enabled = useProviderStore.getState().getEnabledProviders()
      const anthropic = enabled.find(p => p.id === 'anthropic')
      expect(anthropic).toBeDefined()
      expect(anthropic!.apiKey).toBe('my-key-here')
    })

    it('returns empty apiKey string when no key is set', () => {
      const enabled = useProviderStore.getState().getEnabledProviders()
      expect(enabled[0].apiKey).toBe('')
    })
  })

  // ── setProviderConfig ──────────────────────────────────────

  describe('setProviderConfig', () => {
    it('performs partial updates without overwriting other fields', () => {
      useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://remote:11434' })
      const ollama = useProviderStore.getState().providers.ollama
      expect(ollama.baseUrl).toBe('http://remote:11434')
      expect(ollama.name).toBe('Ollama')
      expect(ollama.enabled).toBe(true)
    })

    it('can update enabled state', () => {
      useProviderStore.getState().setProviderConfig('openai', { enabled: true })
      expect(useProviderStore.getState().providers.openai.enabled).toBe(true)
    })

    it('can update name', () => {
      useProviderStore.getState().setProviderConfig('openai', { name: 'vLLM' })
      expect(useProviderStore.getState().providers.openai.name).toBe('vLLM')
    })

    it('does not affect other providers', () => {
      useProviderStore.getState().setProviderConfig('openai', { enabled: true, name: 'Changed' })
      expect(useProviderStore.getState().providers.ollama.name).toBe('Ollama')
      expect(useProviderStore.getState().providers.anthropic.name).toBe('Anthropic')
    })

    it('calls clearProviderCache', () => {
      useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://new:11434' })
      expect(clearProviderCache).toHaveBeenCalled()
    })
  })

  // ── resetProvider ──────────────────────────────────────────

  describe('resetProvider', () => {
    it('reverts a provider to its default config', () => {
      useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://custom:9999', name: 'Custom' })
      useProviderStore.getState().setProviderApiKey('ollama', 'some-key')
      useProviderStore.getState().resetProvider('ollama')
      const ollama = useProviderStore.getState().providers.ollama
      expect(ollama.baseUrl).toBe('http://localhost:11434')
      expect(ollama.name).toBe('Ollama')
      expect(ollama.apiKey).toBe('')
    })

    it('does not affect other providers', () => {
      useProviderStore.getState().setProviderConfig('openai', { enabled: true })
      useProviderStore.getState().resetProvider('ollama')
      expect(useProviderStore.getState().providers.openai.enabled).toBe(true)
    })

    it('calls clearProviderCache', () => {
      useProviderStore.getState().resetProvider('anthropic')
      expect(clearProviderCache).toHaveBeenCalled()
    })

    it('restores anthropic defaults including isLocal=false', () => {
      useProviderStore.getState().setProviderConfig('anthropic', { enabled: true, baseUrl: 'https://custom.api' })
      useProviderStore.getState().resetProvider('anthropic')
      const anthropic = useProviderStore.getState().providers.anthropic
      expect(anthropic.enabled).toBe(false)
      expect(anthropic.baseUrl).toBe('https://api.anthropic.com')
      expect(anthropic.isLocal).toBe(false)
    })
  })

  // ── Multiple providers interaction ─────────────────────────

  describe('multi-provider scenarios', () => {
    it('enables all three providers independently', () => {
      useProviderStore.getState().setProviderConfig('openai', { enabled: true })
      useProviderStore.getState().setProviderConfig('anthropic', { enabled: true })
      const enabled = useProviderStore.getState().getEnabledProviders()
      expect(enabled).toHaveLength(3)
      const ids = enabled.map(p => p.id)
      expect(ids).toContain('ollama')
      expect(ids).toContain('openai')
      expect(ids).toContain('anthropic')
    })

    it('each provider keeps its own key', () => {
      useProviderStore.getState().setProviderApiKey('openai', 'openai-key')
      useProviderStore.getState().setProviderApiKey('anthropic', 'anthropic-key')
      expect(useProviderStore.getState().getProviderApiKey('openai')).toBe('openai-key')
      expect(useProviderStore.getState().getProviderApiKey('anthropic')).toBe('anthropic-key')
      expect(useProviderStore.getState().getProviderApiKey('ollama')).toBe('')
    })
  })
})
