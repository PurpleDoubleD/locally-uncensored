/**
 * Provider Types & Registry Tests
 *
 * Tests provider presets, model name prefixing, and provider resolution.
 * Run: npx vitest run src/api/__tests__/provider-types.test.ts
 */
import { describe, it, expect } from 'vitest'
import { PROVIDER_PRESETS } from '../providers/types'
import { ProviderError } from '../providers/types'
import {
  getProviderIdFromModel,
  prefixModelName,
  displayModelName,
} from '../providers/registry'

// ── Provider Presets ────────────────────────────────────────────

describe('PROVIDER_PRESETS', () => {
  it('has Ollama preset', () => {
    const ollama = PROVIDER_PRESETS.find(p => p.id === 'ollama')
    expect(ollama).toBeDefined()
    expect(ollama!.isLocal).toBe(true)
    expect(ollama!.baseUrl).toBe('http://localhost:11434')
  })

  it('has all major local backends', () => {
    const localNames = ['LM Studio', 'vLLM', 'llama.cpp', 'KoboldCpp', 'text-generation-webui', 'LocalAI', 'Jan', 'TabbyAPI', 'GPT4All', 'Aphrodite', 'SGLang', 'TGI (HuggingFace)']
    for (const name of localNames) {
      const preset = PROVIDER_PRESETS.find(p => p.name === name)
      expect(preset, `Missing local preset: ${name}`).toBeDefined()
      expect(preset!.isLocal).toBe(true)
      expect(preset!.baseUrl).toMatch(/^http:\/\/localhost:\d+/)
    }
  })

  it('has all major cloud providers', () => {
    const cloudNames = ['OpenRouter', 'Groq', 'Together', 'DeepSeek', 'Mistral', 'OpenAI', 'Anthropic']
    for (const name of cloudNames) {
      const preset = PROVIDER_PRESETS.find(p => p.name === name)
      expect(preset, `Missing cloud preset: ${name}`).toBeDefined()
      expect(preset!.isLocal).toBe(false)
      expect(preset!.baseUrl).toMatch(/^https:\/\//)
    }
  })

  it('local presets have no API key placeholder', () => {
    const locals = PROVIDER_PRESETS.filter(p => p.isLocal)
    for (const p of locals) {
      expect(p.placeholder, `Local preset ${p.name} should not have placeholder`).toBeUndefined()
    }
  })

  it('cloud presets have API key placeholders', () => {
    const clouds = PROVIDER_PRESETS.filter(p => !p.isLocal && p.id !== 'custom-openai')
    for (const p of clouds) {
      expect(p.placeholder, `Cloud preset ${p.name} should have placeholder`).toBeDefined()
    }
  })

  it('each preset has unique id', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each preset has valid providerId', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(['ollama', 'openai', 'anthropic']).toContain(p.providerId)
    }
  })

  it('local backends use unique ports (mostly)', () => {
    const localPorts = PROVIDER_PRESETS
      .filter(p => p.isLocal && p.providerId === 'openai')
      .map(p => {
        const match = p.baseUrl.match(/:(\d+)/)
        return match ? `${p.name}:${match[1]}` : p.name
      })
    // At least 8 distinct ports
    const ports = localPorts.map(s => s.split(':')[1])
    expect(new Set(ports).size).toBeGreaterThanOrEqual(8)
  })
})

// ── Model Name Prefixing ────────────────────────────────────────

describe('prefixModelName', () => {
  it('Ollama models have no prefix (backward compat)', () => {
    expect(prefixModelName('ollama', 'llama3.1:8b')).toBe('llama3.1:8b')
  })

  it('OpenAI models get openai:: prefix', () => {
    expect(prefixModelName('openai', 'gpt-4o')).toBe('openai::gpt-4o')
  })

  it('Anthropic models get anthropic:: prefix', () => {
    expect(prefixModelName('anthropic', 'claude-sonnet-4-20250514')).toBe('anthropic::claude-sonnet-4-20250514')
  })
})

describe('getProviderIdFromModel', () => {
  it('returns ollama for unprefixed models', () => {
    expect(getProviderIdFromModel('llama3.1:8b')).toBe('ollama')
    expect(getProviderIdFromModel('hermes3:8b')).toBe('ollama')
    expect(getProviderIdFromModel('dolphin3:8b')).toBe('ollama')
  })

  it('returns openai for openai:: prefixed models', () => {
    expect(getProviderIdFromModel('openai::gpt-4o')).toBe('openai')
    expect(getProviderIdFromModel('openai::meta-llama/llama-3.1-8b')).toBe('openai')
  })

  it('returns anthropic for anthropic:: prefixed models', () => {
    expect(getProviderIdFromModel('anthropic::claude-sonnet-4-20250514')).toBe('anthropic')
  })
})

describe('displayModelName', () => {
  it('strips provider prefix', () => {
    expect(displayModelName('openai::gpt-4o')).toBe('gpt-4o')
    expect(displayModelName('anthropic::claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514')
  })

  it('returns Ollama names unchanged', () => {
    expect(displayModelName('llama3.1:8b')).toBe('llama3.1:8b')
    expect(displayModelName('hermes3:8b')).toBe('hermes3:8b')
  })
})

// ── ProviderError ───────────────────────────────────────────────

describe('ProviderError', () => {
  it('includes provider id and code', () => {
    const err = new ProviderError('Invalid key', 'openai', 'auth', 401)
    expect(err.message).toBe('Invalid key')
    expect(err.provider).toBe('openai')
    expect(err.code).toBe('auth')
    expect(err.status).toBe(401)
    expect(err.name).toBe('ProviderError')
  })

  it('is an instance of Error', () => {
    const err = new ProviderError('test', 'ollama')
    expect(err).toBeInstanceOf(Error)
  })
})
