/**
 * Ollama says per model whether it can call tools. Believe it.
 *
 * Found 2026-08-06 while picking models for the G matrix on DESKTOP-D1TO33K.
 * All nine installed models resolved to the `native` strategy, including one
 * that Ollama reports as `capabilities: ['completion']` with no tools at all:
 * `hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M`. It was routed
 * native purely because its name contains 'qwen3', which is in the
 * AGENT_COMPATIBLE substring list in model-compatibility.
 *
 * Cause: the provider's listModels dropped `capabilities`, so every Ollama
 * model reached resolveToolSupport with `supportsTools: undefined` and the
 * decision always fell through to the family-name heuristic. Ollama's own
 * answer was already on the wire and already parsed by getModelCapabilities in
 * api/ollama.ts, but that reader is only ever asked about 'vision'.
 *
 * Consequence: a `tools` payload goes to a model that cannot take one, the
 * request fails, and the reactive tool-capability cache only learns after
 * burning it. On the hermes path the same model works fine, so this also shows
 * up as a per-schema difference, which is what the G matrix is hunting.
 *
 * Run: npx vitest run src/api/providers/__tests__/ollama-capabilities.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { ProviderClient, ProviderConfig } from '../types'

/** The one match, or a loud failure — `find` returning undefined must not
 *  quietly satisfy a `.toBeUndefined()` assertion about a FIELD. */
function found<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`no entry matching ${what}`)
  return v
}

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../ollama-provider.ts'),
  'utf8',
)

// The three shapes that matter, taken verbatim from the /api/tags answer on
// DESKTOP-D1TO33K, 2026-08-06.
const TAGS = {
  models: [
    { name: 'qwen2.5-coder:14b', model: 'qwen2.5-coder:14b', size: 1, digest: 'a', modified_at: 'x',
      capabilities: ['completion', 'tools', 'insert'] },
    { name: 'hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M', model: 'x', size: 1, digest: 'b', modified_at: 'x',
      capabilities: ['completion'] },
    // An older Ollama omits the field entirely.
    { name: 'legacy-model:7b', model: 'legacy-model:7b', size: 1, digest: 'c', modified_at: 'x' },
  ],
}

/** The constructor shape this test resolves out of the dynamic import. */
type OllamaCtor = new (config: ProviderConfig) => ProviderClient

let provider: ProviderClient

beforeEach(async () => {
  vi.resetModules()
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async () => ({ ok: true, json: async () => TAGS })),
    localFetchStream: vi.fn(),
    ollamaUrl: (p: string) => `http://127.0.0.1:11434/api${p}`,
    isTauri: () => false,
  }))
  const mod = await import('../ollama-provider')
  const Ctor: OllamaCtor =
    mod.OllamaProvider ??
    (Object.values(mod).find(v => typeof v === 'function') as OllamaCtor)
  provider = new Ctor({ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabled: true, isLocal: true })
})

afterEach(() => { vi.doUnmock('../../backend'); vi.resetModules() })

describe('listModels carries the tool capability through', () => {
  it('a model that declares tools comes back as supportsTools true', async () => {
    const models = await provider.listModels()
    const m = found(models.find(x => x.name === 'qwen2.5-coder:14b'), 'qwen2.5-coder:14b')
    expect(m.supportsTools).toBe(true)
  })

  it('a completion-only model comes back FALSE, not undefined', async () => {
    // This is the whole finding. undefined means "nobody said", which sends the
    // decision to the family list, and the family list says yes because the
    // name contains 'qwen3'.
    const models = await provider.listModels()
    const m = found(models.find(x => x.name.includes('DevQuasar')), 'DevQuasar')
    expect(m.supportsTools).toBe(false)
    expect(m.supportsTools).not.toBeUndefined()
  })

  it('an older Ollama that omits the field stays undefined, so the heuristic still decides', async () => {
    // Deliberately not `false`: no answer must not read as a denial, or every
    // model on an older server would be pushed onto the hermes path.
    const models = await provider.listModels()
    const m = found(models.find(x => x.name === 'legacy-model:7b'), 'legacy-model:7b')
    expect(m.supportsTools).toBeUndefined()
  })
})

describe('the source states the precedence', () => {
  it('reads capabilities rather than assuming', () => {
    expect(src).toMatch(/capabilities\.includes\('tools'\)/)
  })

  it('an absent field is undefined, never a hardcoded true', () => {
    expect(src).not.toMatch(/supportsTools:\s*Array\.isArray\(m\.capabilities\).*:\s*true/)
  })
})

/**
 * The path the app really uses.
 *
 * Caught on the real build 2026-08-06, not by a unit test: after fixing
 * OllamaProvider.listModels the picker STILL showed a wrench on
 * `hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M`. Reason:
 * nothing routes Ollama through the provider class. useModels.ts:168 calls
 * `listModels()` from api/ollama.ts directly, and that one only did
 * `{ ...m, type: 'text' }`, so `capabilities` rode along under its own name and
 * `supportsTools` stayed undefined forever.
 *
 * ModelSelector.tsx:853 reads `model.supportsTools === false` for the ban
 * marker and treats anything else as tool-capable, so undefined renders a
 * wrench. That is why the badge lied.
 */
describe('api/ollama listModels, the path useModels actually calls', () => {
  it('maps capabilities to supportsTools there too', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../ollama.ts'),
      'utf8',
    )
    const fn = src.slice(src.indexOf('export async function listModels'), src.indexOf('export async function showModel'))
    expect(fn).toMatch(/supportsTools:\s*Array\.isArray\(m\.capabilities\)\s*\?\s*m\.capabilities\.includes\("tools"\)\s*:\s*undefined/)
  })

  it('useModels still reads that function and not the provider class', () => {
    // If this ever moves to the provider class the comment above goes stale,
    // and so does the fix location.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../hooks/useModels.ts'),
      'utf8',
    )
    expect(src).toMatch(/import \{ listModels[^}]*\} from '\.\.\/api\/ollama'/)
    expect(src).toMatch(/const ollamaModels = await listModels\(\)/)
  })
})

/**
 * The place it actually died: useModels rebuilds the Ollama model by hand.
 *
 * Two fixes upstream (OllamaProvider.listModels and api/ollama listModels)
 * changed nothing on the installed build, because useModels maps the provider's
 * ProviderModel into an AIModel with an object literal that lists the fields one
 * by one, and the Ollama branch stopped one field short. The branch immediately
 * below it, for every other provider, passes supportsTools through.
 *
 * The second reason both upstream fixes were invisible: once the provider loop
 * has produced Ollama models, `hasOllamaModels` is true and the api/ollama
 * fallback at useModels.ts:166 never runs at all.
 *
 * ModelSelector draws the ban marker only on `supportsTools === false`, so a
 * dropped field renders as a wrench. Only the real build showed it.
 */
describe('useModels keeps supportsTools when it rebuilds an Ollama model', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../hooks/useModels.ts'),
    'utf8',
  )
  const branch = (() => {
    const i = src.indexOf("if (pm.provider === 'ollama')")
    return src.slice(i, src.indexOf('const prefixedName', i))
  })()

  it('the ollama branch exists and is the hand-built literal', () => {
    expect(branch).toContain("providerName: 'Ollama'")
  })

  it('it carries supportsTools through', () => {
    expect(branch).toMatch(/supportsTools:\s*pm\.supportsTools/)
  })

  it('it carries contextLength through as well', () => {
    // Same class of omission, same literal.
    expect(branch).toMatch(/contextLength:\s*pm\.contextLength/)
  })
})
