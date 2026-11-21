/**
 * Ollama says per model whether it can see pictures. Believe it.
 *
 * A Gemma 4 finetune imported under its own name ("creative-wordsmith:31b")
 * with its f16 projector got "This model can't see the picture" in the
 * composer, because LU decided vision for Ollama models from the NAME alone
 * (VISION_COMPATIBLE in model-compatibility) and the name holds no family.
 * Ollama already says `vision` in /api/tags when the projector was loaded.
 * Same road as the tools answer (ollama-capabilities.test.ts), same three
 * places it has to survive: the provider class, api/ollama, and the literal
 * in useModels.
 *
 * Run: npx vitest run src/api/providers/__tests__/ollama-vision-capability.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { ProviderClient, ProviderConfig } from '../types'
import { declaredVision, isVisionCompatible } from '../../../lib/model-compatibility'

const TAGS = {
  models: [
    // Custom name, projector loaded: no family in the name, Ollama says vision.
    { name: 'creative-wordsmith:31b', model: 'creative-wordsmith:31b', size: 1, digest: 'a', modified_at: 'x',
      capabilities: ['completion', 'vision', 'tools', 'thinking'] },
    // Vision-family name imported WITHOUT its projector.
    { name: 'gemma4-31b-textonly:latest', model: 'x', size: 1, digest: 'b', modified_at: 'x',
      capabilities: ['completion', 'tools'] },
    // An older Ollama omits the field entirely.
    { name: 'gemma4:31b', model: 'gemma4:31b', size: 1, digest: 'c', modified_at: 'x' },
  ],
}

type OllamaCtor = new (config: ProviderConfig) => ProviderClient
const here = dirname(fileURLToPath(import.meta.url))

function backendMock() {
  return {
    localFetch: vi.fn(async () => ({ ok: true, json: async () => TAGS })),
    localFetchStream: vi.fn(),
    ollamaUrl: (p: string) => `http://127.0.0.1:11434/api${p}`,
    isTauri: () => false,
  }
}

afterEach(() => { vi.doUnmock('../../backend'); vi.resetModules() })

describe('OllamaProvider.listModels carries the vision capability', () => {
  let provider: ProviderClient
  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../../backend', backendMock)
    const mod = await import('../ollama-provider')
    const Ctor: OllamaCtor = mod.OllamaProvider ?? (Object.values(mod).find(v => typeof v === 'function') as OllamaCtor)
    provider = new Ctor({ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabled: true, isLocal: true })
  })

  it('a custom-named model with its projector reads as seeing', async () => {
    const m = (await provider.listModels()).find(x => x.name === 'creative-wordsmith:31b')
    expect(m?.supportsVision).toBe(true)
    // ...which is exactly what the name heuristic got wrong.
    expect(isVisionCompatible('creative-wordsmith:31b')).toBe(false)
    expect(declaredVision(m)).toBe(true)
  })

  it('a vision-family name without its projector reads as blind', async () => {
    const m = (await provider.listModels()).find(x => x.name.startsWith('gemma4-31b-textonly'))
    expect(m?.supportsVision).toBe(false)
  })

  it('an older Ollama that says nothing leaves it undefined, so the name decides', async () => {
    const m = (await provider.listModels()).find(x => x.name === 'gemma4:31b')
    expect(m).toBeDefined()
    expect(m?.supportsVision).toBeUndefined()
  })
})

describe('api/ollama listModels, the fallback path', () => {
  beforeEach(() => { vi.resetModules(); vi.doMock('../../backend', backendMock) })

  it('maps vision the same way', async () => {
    const { listModels } = await import('../../ollama')
    const models = await listModels()
    expect(models.find(m => m.name === 'creative-wordsmith:31b')?.supportsVision).toBe(true)
    expect(models.find(m => m.name.startsWith('gemma4-31b-textonly'))?.supportsVision).toBe(false)
    expect(models.find(m => m.name === 'gemma4:31b')?.supportsVision).toBeUndefined()
  })
})

describe('useModels keeps supportsVision when it rebuilds an Ollama model', () => {
  it('the hand-built literal carries it', () => {
    const src = readFileSync(resolve(here, '../../../hooks/useModels.ts'), 'utf8')
    const i = src.indexOf("if (pm.provider === 'ollama')")
    const branch = src.slice(i, src.indexOf('const prefixedName', i))
    expect(branch).toMatch(/supportsVision:\s*pm\.supportsVision/)
  })
})
