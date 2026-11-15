/**
 * GH #235 (Ducky-94): "free VRAM without restarting", an idle timer that
 * unloads the chat model. LU had it for the LU Engine only (engine_idle.rs).
 * The same setting now reaches Ollama as `keep_alive` and LM Studio as its
 * own idle TTL (`lms load --ttl`, `ttl` on a request), and it sits in a
 * section of its own under AI Backends, not inside the LU Engine section that
 * an Ollama user never sees. Unload all was already there.
 *
 * Run: npx vitest run src/api/providers/__tests__/idle-unload-on-every-backend.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProviderConfig, ChatStreamChunk } from '../types'
import type { OpenAIChatRequest } from '../openai-provider'

const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
type Init = { body?: string }
let sent: { url: string; body: OpenAIChatRequest }[]
let gets: string[]
let facts: Record<string, unknown>

function answer(url: string, init: Init | undefined): Response {
  if (typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as OpenAIChatRequest
    sent.push({ url, body })
    if (body.stream) return new Response(streamBody, { status: 200 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }
  gets.push(url)
  const hit = Object.keys(facts).sort((a, b) => b.length - a.length).find((suffix) => url.endsWith(suffix))
  return hit ? new Response(JSON.stringify(facts[hit]), { status: 200 }) : new Response('not found', { status: 404 })
}

async function setup(config: ProviderConfig, minutes: number, serverFacts: Record<string, unknown> = {}) {
  vi.resetModules()
  sent = []
  gets = []
  facts = serverFacts
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async (url: string, init?: Init) => answer(url, init)),
    localFetchStream: vi.fn(async (url: string, init?: Init) => answer(url, init)),
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
    explainEngineTransportMessage: (m: string) => m,
    isManagedBuiltinSlot: () => false,
  }))
  const { useSettingsStore } = await import('../../../stores/settingsStore')
  useSettingsStore.getState().updateSettings({ engineIdleUnloadMinutes: minutes })
  const mod = await import('../openai-provider')
  return new mod.OpenAIProvider(config)
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>) {
  for await (const _ of gen) { /* the fetch fires on the first next() */ }
}
const chatBody = () => sent.filter((s) => s.url.endsWith('/chat/completions')).map((s) => s.body)[0]

const local = (name: string, port: number): ProviderConfig => ({
  id: 'openai', name, apiKey: '', enabled: true, baseUrl: `http://localhost:${port}/v1`, isLocal: true,
})
const LM_STUDIO = local('LM Studio', 1234)
const KOBOLD = local('KoboldCpp', 5001)
const ENGINE: ProviderConfig = { ...local('LU Engine', 8127), baseUrl: 'http://127.0.0.1:8127/v1', managed: true }
const LMS_FACTS = { '/api/v1/models': { models: [{ type: 'llm', key: 'qwen3-8b' }] } }
const KOBOLD_FACTS = { '/api/extra/version': { result: 'KoboldCpp', version: '1.123' } }

afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('LM Studio gets the idle time as its own TTL', () => {
  it('on a chat request, in seconds', async () => {
    const p = await setup(LM_STUDIO, 15, LMS_FACTS)
    await drain(p.chatStream('qwen3-8b', [{ role: 'user', content: 'hi' }]))
    expect(chatBody().ttl).toBe(900)
  })

  it('on a tool call too', async () => {
    const p = await setup(LM_STUDIO, 60, LMS_FACTS)
    await p.chatWithTools('qwen3-8b', [{ role: 'user', content: 'hi' }], [])
    expect(chatBody().ttl).toBe(3600)
  })

  it('NEGATIVE CONTROL: with Never, no ttl and no extra question to the server', async () => {
    const p = await setup(LM_STUDIO, 0, LMS_FACTS)
    await drain(p.chatStream('qwen3-8b', [{ role: 'user', content: 'hi' }]))
    expect(chatBody()).not.toHaveProperty('ttl')
    expect(gets.filter((u) => u.endsWith('/api/v1/models'))).toEqual([])
  })

  it('NEGATIVE CONTROL: KoboldCpp and the LU Engine never see the field', async () => {
    let p = await setup(KOBOLD, 15, KOBOLD_FACTS)
    await drain(p.chatStream('m', [{ role: 'user', content: 'hi' }]))
    expect(chatBody()).not.toHaveProperty('ttl')
    p = await setup(ENGINE, 15)
    await drain(p.chatStream('m', [{ role: 'user', content: 'hi' }]))
    expect(chatBody()).not.toHaveProperty('ttl')
  })
})

describe('the values each backend gets', () => {
  it('Ollama: the minutes as keep_alive, and with Never what the call always sent', async () => {
    vi.resetModules()
    const { useSettingsStore } = await import('../../../stores/settingsStore')
    const { ollamaKeepAlive, lmStudioTtlSeconds, lmsTtlArg } = await import('../../../lib/idle-unload')
    useSettingsStore.getState().updateSettings({ engineIdleUnloadMinutes: 10 })
    expect(ollamaKeepAlive('30m')).toBe('10m')
    expect(lmStudioTtlSeconds()).toBe(600)
    expect(lmsTtlArg()).toEqual({ ttlSeconds: 600 })
    useSettingsStore.getState().updateSettings({ engineIdleUnloadMinutes: 0 })
    expect(ollamaKeepAlive('30m')).toBe('30m')
    expect(ollamaKeepAlive('10m')).toBe('10m')
    expect(lmStudioTtlSeconds()).toBeUndefined()
    expect(lmsTtlArg()).toEqual({})
  })
})

describe('every place that keeps a model loaded asks the setting', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')

  it('no Ollama request keeps a model warm with a fixed time any more', () => {
    for (const f of ['api/providers/ollama-provider.ts', 'lib/ollama-stream-tools.ts', 'api/ollama.ts']) {
      const text = src(f)
      expect(text, f).not.toMatch(/keep_alive:\s*['"]\d+m['"]/)
      expect(text, f).toMatch(/keep_alive:\s*ollamaKeepAlive\(/)
    }
    // The unload stays an unload.
    expect(src('api/ollama.ts')).toMatch(/keep_alive: 0 \}/)
  })

  it('every LM Studio load carries the TTL', () => {
    for (const f of ['api/lmstudio.ts', 'api/vram-handoff.ts']) {
      const calls = src(f).split("backendCall('lmstudio_load_model', {").slice(1).map((rest) => rest.slice(0, rest.indexOf('\n        })')))
      expect(calls.length, f).toBeGreaterThan(0)
      for (const c of calls) expect(c, f).toMatch(/\.\.\.lmsTtlArg\(\)/)
    }
  })

  it('the setting is in its own section under AI Backends, no longer only in the LU Engine one', () => {
    const page = src('components/settings/SettingsPage.tsx')
    expect(page).toMatch(/<Section title="Unused models">\s*<IdleUnloadSetting \/>/)
    expect(src('components/settings/BuiltinEngineSettings.tsx')).not.toMatch(/engine-idle-unload/)
  })
})
