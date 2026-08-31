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
 * The first version of the guard hung off `setProviderConfig` alone, i.e. off
 * the explicit toggle. Settings → "Reset AI Backends" (resetProvidersToDefaults)
 * and the per-slot reset write the shipped defaults over the map — where Ollama
 * and Anthropic are `enabled: false` — and reached the identical broken state
 * through a supported one-click path without ever asking.
 *
 * Run: npx vitest run src/stores/__tests__/model-provider-invariant.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

vi.mock('../../api/ollama', () => ({ unloadModel: vi.fn(async () => {}) }))
vi.mock('../../api/lmstudio', () => ({ unloadLmStudioModel: vi.fn(async () => {}) }))
vi.mock('../../api/engine', () => ({ activateBuiltinModel: vi.fn(async () => {}) }))

import { useModelStore } from '../modelStore'
import { useProviderStore } from '../providerStore'
import { getProviderIdFromModel } from '../../api/providers'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The lazy `import('./modelStore')` inside providerStore settles a tick later. */
const settleLazyImport = () => new Promise((r) => setTimeout(r, 0))

describe('which slot a model name routes to', () => {
  it('routes a bare name to Ollama and a prefixed one to its slot', () => {
    expect(getProviderIdFromModel('llama3:8b')).toBe('ollama')
    expect(getProviderIdFromModel('openai::qwen3-8b')).toBe('openai')
    expect(getProviderIdFromModel('anthropic::claude-x')).toBe('anthropic')
    expect(getProviderIdFromModel('lu-cloud::something')).toBe('lu-cloud')
  })

  it('is answered in exactly one place in the app', () => {
    // modelStore used to carry its own `providerIdForModel`, and the two
    // disagreed on real names: 'sdxl::checkpoint.safetensors' was null in the
    // store and 'sdxl' on the send path, 'a::b::c' was null in the store and
    // 'ollama' on the send path. Two answers to "who serves this model" is the
    // worst possible split — the guard below would decline to clear a pick
    // that getProviderForModel then routes to a backend that is switched off.
    const src = readFileSync(join(HERE, '../modelStore.ts'), 'utf8')
    expect(src).toContain('getProviderIdFromModel')
    expect(src).not.toMatch(/function\s+providerIdForModel/)
  })

  it('and the guard agrees with it on the names that used to differ', () => {
    useModelStore.setState({ activeModel: 'a::b::c' })
    // getProviderIdFromModel calls this Ollama's, so disabling Ollama has to
    // clear it. The old local copy called it nobody's and left it in place.
    expect(getProviderIdFromModel('a::b::c')).toBe('ollama')
    useModelStore.getState().dropActiveModelIfServedBy('ollama')
    expect(useModelStore.getState().activeModel).toBeNull()
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
    await settleLazyImport()

    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('leaves a pick served by a different provider alone', async () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useProviderStore.getState().setProviderConfig('anthropic', { enabled: true })
    useModelStore.setState({ activeModel: 'anthropic::claude-x' })

    useProviderStore.getState().setProviderConfig('ollama', { enabled: false })
    await settleLazyImport()

    expect(useModelStore.getState().activeModel).toBe('anthropic::claude-x')
  })

  it('an edit that does not switch the slot off changes nothing', async () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useModelStore.setState({ activeModel: 'llama3:8b' })

    useProviderStore.getState().setProviderConfig('ollama', { baseUrl: 'http://localhost:11500' })
    await settleLazyImport()

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

describe('the reset buttons close the same invariant', () => {
  beforeEach(() => {
    useModelStore.setState({ activeModel: null, models: [] })
    useProviderStore.getState().resetProvidersToDefaults()
  })

  it('"Reset AI Backends" drops a pick whose slot it switches off', async () => {
    // The regular user path: Ollama enabled, an Ollama model picked, then
    // Settings → Reset AI Backends. DEFAULT_PROVIDERS has ollama enabled:false,
    // so the model is unservable from that click on — and nothing asked.
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useModelStore.setState({ activeModel: 'llama3:8b' })

    useProviderStore.getState().resetProvidersToDefaults()
    await settleLazyImport()

    expect(useProviderStore.getState().providers.ollama.enabled).toBe(false)
    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('the reset leaves a pick on a slot it keeps switched on', async () => {
    // The built-in engine occupies the openai slot and the defaults have it
    // ON, so a pick it serves survives the reset. A guard that cleared the
    // pick on every reset would be its own bug.
    useModelStore.setState({ activeModel: 'openai::qwen3-8b' })

    useProviderStore.getState().resetProvidersToDefaults()
    await settleLazyImport()

    expect(useProviderStore.getState().providers.openai.enabled).toBe(true)
    expect(useModelStore.getState().activeModel).toBe('openai::qwen3-8b')
  })

  it('the single-slot reset drops a pick it switches off', async () => {
    useProviderStore.getState().setProviderConfig('anthropic', { enabled: true })
    useModelStore.setState({ activeModel: 'anthropic::claude-x' })

    useProviderStore.getState().resetProvider('anthropic')
    await settleLazyImport()

    expect(useModelStore.getState().activeModel).toBeNull()
  })
})
