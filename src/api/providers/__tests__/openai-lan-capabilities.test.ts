/**
 * G32 (R20-Mac, 2026-08-07): LM Studio says per model whether it can call
 * tools. Believe it — the same rule the Ollama provider learned in G26.
 *
 * Wire proof on the Mac: a tap on 127.0.0.1:1234 with --strip-tools removed
 * 'tool_use' from every /api/v0/models capability answer, and the app STILL
 * sent a native `tools` payload. Cause: the standard /v1/models listing has
 * no tool field, so the LAN branch fell to `supports_tools ?? true` for every
 * model, and the layered resolution downstream had nothing to downgrade on.
 *
 * The LAN branch now reads LM Studio's enhanced listing (/api/v0/models,
 * `capabilities: ['tool_use', ...]`) once per listModels and derives
 * supportsTools per model. Backends without the enhanced API keep the
 * optimistic default, and cloud endpoints never pay the extra request.
 *
 * Run: npx vitest run src/api/providers/__tests__/openai-lan-capabilities.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig } from '../types'

// Answer shapes taken from a real LM Studio 0.3.x on the Mac, 2026-08-07.
const STANDARD = {
  data: [
    { id: 'qwen2.5-0.5b-instruct', object: 'model' },
    { id: 'tinystories-33m', object: 'model' },
    { id: 'legacy-model', object: 'model' },
  ],
}
const ENHANCED = {
  data: [
    { id: 'qwen2.5-0.5b-instruct', capabilities: ['tool_use'] },
    // Exactly what --strip-tools produced at the wire: a capability answer
    // that a tool-less model would give.
    { id: 'tinystories-33m', capabilities: [] },
    // An entry WITHOUT the field must not land in the map at all.
    { id: 'legacy-model' },
  ],
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' }

let requested: string[]
let enhancedAvailable: boolean
// G37: what GET /props answers. null = 404 (vLLM and friends), an object =
// llama.cpp's real shape with chat_template_caps.
let propsAnswer: Record<string, unknown> | null

async function makeProvider(config: ProviderConfig) {
  vi.resetModules()
  requested = []
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async (url: string) => {
      requested.push(url)
      if (url.endsWith('/api/v0/models')) return enhancedAvailable ? ok(ENHANCED) : notFound
      if (url.endsWith('/props')) return propsAnswer ? ok(propsAnswer) : notFound
      if (url.endsWith('/v1/models')) return ok(STANDARD)
      return notFound
    }),
    localFetchStream: vi.fn(),
    backendCall: vi.fn(),
    isPrivateOrLanHost: (host: string) => host === 'localhost' || host === '127.0.0.1',
    isDirectFetchAllowed: () => true,
    hostnameOf: (url: string) => new URL(url).hostname,
    ensureProxyAllowsHost: vi.fn(),
    isTauri: () => false,
  }))
  vi.doMock('../../builtin-ensure', () => ({
    ensureBuiltinEngineAlive: vi.fn(),
    explainDeadEngine: (e: unknown) => e,
  }))
  const mod = await import('../openai-provider')
  return new mod.OpenAIProvider(config)
}

beforeEach(() => { enhancedAvailable = true; propsAnswer = null })
afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the LAN branch derives supportsTools from the enhanced listing', () => {
  it('a model declaring tool_use comes back true', async () => {
    const p = await makeProvider({ id: 'openai', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    expect(models.find(m => m.id === 'qwen2.5-0.5b-instruct')!.supportsTools).toBe(true)
  })

  it('a model WITHOUT tool_use comes back FALSE, not the optimistic default', async () => {
    // This is the whole finding: `?? true` made every local model
    // tool-capable, so the run built a `tools` payload the server had
    // already disclaimed.
    const p = await makeProvider({ id: 'openai', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    expect(models.find(m => m.id === 'tinystories-33m')!.supportsTools).toBe(false)
  })

  it('an entry without a capabilities array falls back to the old default', async () => {
    // No answer must not read as a denial (same rule as the Ollama G26 fix).
    const p = await makeProvider({ id: 'openai', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    expect(models.find(m => m.id === 'legacy-model')!.supportsTools).toBe(true)
  })

  it('NEGATIVE CONTROL: a backend without enhanced API or /props stays optimistic', async () => {
    // vLLM 404s on /api/v0/models AND /props; nothing may downgrade.
    enhancedAvailable = false
    const p = await makeProvider({ id: 'openai', name: 'vLLM', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    for (const m of models) expect(m.supportsTools).toBe(true)
  })
})

describe('G37: llama.cpp /props decides when the enhanced listing says nothing', () => {
  // The R21c wire proof: the bundled engine (llama-server on 8127) took the
  // native `tools` payload without complaint, the model never saw a tool
  // contract, and the "run" was a narrated fiction with zero calls on the
  // wire. The same server states the truth on /props:
  // chat_template_caps.supports_tools = false.
  const LLAMA_PROPS_NO_TOOLS = { chat_template_caps: { supports_tools: false, supports_tool_calls: false } }
  const LLAMA_PROPS_TOOLS = { chat_template_caps: { supports_tools: true, supports_tool_calls: true } }

  it('supports_tools false on /props downgrades every model of that server', async () => {
    enhancedAvailable = false
    propsAnswer = LLAMA_PROPS_NO_TOOLS
    const p = await makeProvider({ id: 'openai', name: 'Built-in Engine', baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    for (const m of models) expect(m.supportsTools).toBe(false)
  })

  it('supports_tools true on /props keeps native (llama.cpp with a tool template)', async () => {
    enhancedAvailable = false
    propsAnswer = LLAMA_PROPS_TOOLS
    const p = await makeProvider({ id: 'openai', name: 'Built-in Engine', baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    for (const m of models) expect(m.supportsTools).toBe(true)
  })

  it('a props answer without the field means nobody said: optimistic default', async () => {
    enhancedAvailable = false
    propsAnswer = { build_info: 'b1', model_path: '/x.gguf' }
    const p = await makeProvider({ id: 'openai', name: 'Built-in Engine', baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    for (const m of models) expect(m.supportsTools).toBe(true)
  })

  it('NEGATIVE CONTROL: the enhanced listing wins, /props is not even asked', async () => {
    // LM Studio answers per model; a server-wide flag must not override that,
    // and the extra request must not fire when the listing already spoke.
    propsAnswer = LLAMA_PROPS_NO_TOOLS
    const p = await makeProvider({ id: 'openai', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, isLocal: true })
    const models = await p.listModels()
    expect(models.find(m => m.id === 'qwen2.5-0.5b-instruct')!.supportsTools).toBe(true)
    expect(requested.some(u => u.endsWith('/props'))).toBe(false)
  })
})

describe('G37b: serverToolSupport answers the same question at send time', () => {
  // The listing probe never runs for the managed built-in engine (useModels
  // synthesizes its picker rows), so the strategy resolution asks the
  // provider directly before the first request of a run.
  it('llama.cpp /props false answers false, and the cache pays one request for the whole run', async () => {
    enhancedAvailable = false
    propsAnswer = { chat_template_caps: { supports_tools: false } }
    const p = await makeProvider({ id: 'openai', name: 'Built-in Engine', baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', enabled: true, isLocal: true })
    expect(await p.serverToolSupport('any-gguf')).toBe(false)
    expect(await p.serverToolSupport('another-gguf')).toBe(false)
    expect(requested.filter(u => u.endsWith('/props')).length).toBe(1)
  })

  it('the LM Studio enhanced listing answers per model, /props stays unasked', async () => {
    propsAnswer = { chat_template_caps: { supports_tools: false } }
    const p = await makeProvider({ id: 'openai', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, isLocal: true })
    expect(await p.serverToolSupport('qwen2.5-0.5b-instruct')).toBe(true)
    expect(await p.serverToolSupport('tinystories-33m')).toBe(false)
    // A model the enhanced listing does not know: nobody said.
    expect(await p.serverToolSupport('just-loaded-model')).toBeUndefined()
    expect(requested.some(u => u.endsWith('/props'))).toBe(false)
  })

  it('NEGATIVE CONTROL: a backend with neither source answers undefined', async () => {
    enhancedAvailable = false
    propsAnswer = null
    const p = await makeProvider({ id: 'openai', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', apiKey: '', enabled: true, isLocal: true })
    expect(await p.serverToolSupport('some-model')).toBeUndefined()
  })

  it('NEGATIVE CONTROL: a cloud endpoint answers undefined without a single request', async () => {
    const p = await makeProvider({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', enabled: true, isLocal: false })
    expect(await p.serverToolSupport('gpt-4o')).toBeUndefined()
    expect(requested.length).toBe(0)
  })

  it('listModels and serverToolSupport share the cache: one /props total', async () => {
    enhancedAvailable = false
    propsAnswer = { chat_template_caps: { supports_tools: false } }
    const p = await makeProvider({ id: 'openai', name: 'Built-in Engine', baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', enabled: true, isLocal: true })
    await p.listModels()
    expect(await p.serverToolSupport('any-gguf')).toBe(false)
    expect(requested.filter(u => u.endsWith('/props')).length).toBe(1)
  })
})

describe('NEGATIVE CONTROL: cloud endpoints are untouched', () => {
  it('no /api/v0 probe fires, and a declared supports_tools is still believed', async () => {
    const p = await makeProvider({ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', enabled: true, isLocal: false })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(String(url))
      return ok({ data: [
        { id: 'gpt-4o', object: 'model' },
        { id: 'roleplay-model', object: 'model', supports_tools: false },
      ] })
    }))
    const models = await p.listModels()
    expect(models.find(m => m.id === 'gpt-4o')!.supportsTools).toBe(true)
    expect(models.find(m => m.id === 'roleplay-model')!.supportsTools).toBe(false)
    expect(requested.some(u => u.includes('/api/v0'))).toBe(false)
  })
})
