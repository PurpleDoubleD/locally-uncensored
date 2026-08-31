/**
 * The picked model has to belong to a backend that is switched on.
 *
 * M4/7: nothing across modelStore and providerStore enforced that. The only
 * check that existed lives in `setModels`, and it re-validates the pick against
 * the next NON-EMPTY inventory — deliberately, so a transient fetch failure
 * cannot silently change the model. That leaves the window between switching a
 * backend off and the next successful refresh, where the composer still offers
 * a model whose provider is gone and every send fails with model-not-found.
 *
 * Run: npx vitest run src/stores/__tests__/model-provider-invariant.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/ollama', () => ({ unloadModel: vi.fn(async () => {}) }))
vi.mock('../../api/lmstudio', () => ({ unloadLmStudioModel: vi.fn(async () => {}) }))
vi.mock('../../api/engine', () => ({ activateBuiltinModel: vi.fn(async () => {}) }))

import { useModelStore, providerIdForModel } from '../modelStore'
import { useProviderStore } from '../providerStore'

describe('providerIdForModel', () => {
  it('routes a bare name to Ollama and a prefixed one to its slot', () => {
    expect(providerIdForModel('llama3:8b')).toBe('ollama')
    expect(providerIdForModel('openai::qwen3-8b')).toBe('openai')
    expect(providerIdForModel('anthropic::claude-x')).toBe('anthropic')
    expect(providerIdForModel('lu-cloud::something')).toBe('lu-cloud')
  })

  it('refuses to guess for a prefix no slot owns', () => {
    // Treating an unknown prefix as Ollama's is how a name gets sent to a
    // backend that has never heard of it.
    expect(providerIdForModel('sdxl::checkpoint.safetensors')).toBeNull()
    expect(providerIdForModel(null)).toBeNull()
    expect(providerIdForModel('')).toBeNull()
  })
})

describe('switching a backend off clears a pick it was serving', () => {
  beforeEach(() => {
    useModelStore.setState({ activeModel: null, models: [] })
    useProviderStore.getState().resetProvidersToDefaults()
  })

  it('drops the active model when its provider is disabled', async () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useModelStore.setState({ activeModel: 'llama3:8b' })

    useProviderStore.getState().setProviderConfig('ollama', { enabled: false })
    await new Promise((r) => setTimeout(r, 0)) // the modelStore import is lazy

    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('leaves a pick served by a different provider alone', async () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useProviderStore.getState().setProviderConfig('anthropic', { enabled: true })
    useModelStore.setState({ activeModel: 'anthropic::claude-x' })

    useProviderStore.getState().setProviderConfig('ollama', { enabled: false })
    await new Promise((r) => setTimeout(r, 0))

    expect(useModelStore.getState().activeModel).toBe('anthropic::claude-x')
  })

  it('an edit that does not switch the slot off changes nothing', async () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useModelStore.setState({ activeModel: 'llama3:8b' })

    useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://localhost:11500' })
    await new Promise((r) => setTimeout(r, 0))

    expect(useModelStore.getState().activeModel).toBe('llama3:8b')
  })

  it('dropActiveModelIfServedBy only fires for the matching slot', () => {
    useModelStore.setState({ activeModel: 'openai::qwen3-8b' })
    useModelStore.getState().dropActiveModelIfServedBy('anthropic')
    expect(useModelStore.getState().activeModel).toBe('openai::qwen3-8b')

    useModelStore.getState().dropActiveModelIfServedBy('openai')
    expect(useModelStore.getState().activeModel).toBeNull()
  })
})
