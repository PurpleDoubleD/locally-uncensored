/**
 * GH #198: custom sampling rows reach the request where the backend reads
 * samplers, as typed, and never twice.
 *
 *  - OpenAI compatible (bundled engine, own server, remote endpoint): top
 *    level of the body, under the name typed.
 *  - Ollama: inside `options`.
 *  - LU Cloud and Anthropic: none.
 *  - A key LU sets from its own field (temperature, top_p, num_ctx ...) never
 *    comes from a row, so the body holds it once, with the field's value.
 *
 * The values are the examples from the issue.
 *
 * Run: npx vitest run src/api/providers/__tests__/custom-params-reach-the-body.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk, ChatOptions } from '../types'
import type { FetchArgs } from '../../__tests__/provider-test-support'

const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

type CapturedInit = { body?: string }
type Body = Record<string, unknown>

let sent: { url: string; body: Body }[]

function answer(url: string, init: CapturedInit) {
  if (typeof init.body !== 'string') throw new Error('request had no JSON body')
  const body = JSON.parse(init.body) as Body
  sent.push({ url, body })
  if (body.stream) return new Response(streamBody, { status: 200 })
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
}

async function makeOpenAI(config: ProviderConfig) {
  vi.resetModules()
  sent = []
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async (url: string, init: CapturedInit) => answer(url, init)),
    localFetchStream: vi.fn(async (url: string, init: CapturedInit) => answer(url, init)),
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
  const mod = await import('../openai-provider')
  return new mod.OpenAIProvider(config)
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>) {
  for await (const _ of gen) { /* the fetch only fires on the first next() */ }
}

const chatBody = () => {
  const hit = sent.find((s) => s.url.endsWith('/chat/completions'))
  if (!hit) throw new Error('no chat request was sent')
  return hit.body
}

const ISSUE_ROWS: Record<string, unknown> = {
  dry_base: 1.75,
  dry_allowed_length: 4,
  dry_penalty_last_n: -1,
  dry_sequence_breakers: ['\n', ':', '"', '*'],
  xtc_threshold: 0.1,
  xtc_probability: 0.5,
  banned_strings: ['ministrations', 'shivers down'],
  logit_bias: { '128': -100 },
}

const WITH_ROWS: ChatOptions = { temperature: 0.8, customParams: { ...ISSUE_ROWS, temperature: 1.4, top_p: 0.1, num_ctx: 999, model: 'other', messages: [] } }

const ENGINE: ProviderConfig = {
  id: 'openai', name: 'LU Engine', apiKey: '', enabled: true,
  baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true,
}
const LM_STUDIO: ProviderConfig = {
  id: 'openai', name: 'LM Studio', apiKey: '', enabled: true,
  baseUrl: 'http://localhost:1234/v1', isLocal: true,
}
const REMOTE: ProviderConfig = {
  id: 'openai', name: 'OpenAI', apiKey: 'sk-test', enabled: true,
  baseUrl: 'https://api.openai.com/v1', isLocal: false,
}
const HOSTED: ProviderConfig = {
  id: 'lu-cloud', name: 'Hosted', apiKey: 'tok', enabled: true,
  baseUrl: 'https://lu-labs.ai/api/inference/v1', isLocal: false,
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: FetchArgs[0], init: FetchArgs[1]) =>
      answer(String(url), { body: typeof init?.body === 'string' ? init.body : undefined }),
  )
})
afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('OpenAI compatible', () => {
  for (const [name, config] of [['bundled engine', ENGINE], ['own server', LM_STUDIO], ['remote endpoint', REMOTE]] as const) {
    it(`${name}: every row at the top level, as typed`, async () => {
      const p = await makeOpenAI(config)
      await drain(p.chatStream('m', [{ role: 'user', content: 'hi' }], WITH_ROWS))
      const body = chatBody()
      for (const [key, value] of Object.entries(ISSUE_ROWS)) expect(body[key], key).toEqual(value)
    })
  }

  it('a fixed field is never taken from a row: the field wins, once', async () => {
    const p = await makeOpenAI(LM_STUDIO)
    await drain(p.chatStream('m', [{ role: 'user', content: 'hi' }], WITH_ROWS))
    const raw = JSON.stringify(chatBody())
    const body = chatBody()
    expect(body.temperature).toBe(0.8)
    expect(raw.match(/"temperature"/g)).toHaveLength(1)
    expect('top_p' in body).toBe(false)
    expect('num_ctx' in body).toBe(true) // not an OpenAI field LU writes: it goes as typed
    expect(body.model).toBe('m')
    expect(Array.isArray(body.messages) && body.messages.length).toBe(1)
  })

  it('the tool path carries them too', async () => {
    const p = await makeOpenAI(LM_STUDIO)
    await p.chatWithTools('m', [{ role: 'user', content: 'hi' }], [], WITH_ROWS)
    expect(chatBody().xtc_threshold).toBe(0.1)
  })

  it('LU Cloud gets none', async () => {
    const p = await makeOpenAI(HOSTED)
    await drain(p.chatStream('m', [{ role: 'user', content: 'hi' }], WITH_ROWS))
    const body = chatBody()
    for (const key of Object.keys(ISSUE_ROWS)) expect(key in body, key).toBe(false)
  })

  it('NEGATIVKONTROLLE: no rows, no extra fields', async () => {
    const p = await makeOpenAI(LM_STUDIO)
    await drain(p.chatStream('m', [{ role: 'user', content: 'hi' }], { temperature: 0.8 }))
    const body = chatBody()
    for (const key of Object.keys(ISSUE_ROWS)) expect(key in body, key).toBe(false)
  })
})

describe('Ollama', () => {
  it('every row inside options, never at the top level; num_ctx stays LU\'s', async () => {
    vi.resetModules()
    const bodies: Body[] = []
    const reply = (_url: string, init?: { body?: unknown }) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Body)
      return new Response(
        JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' }) + '\n',
        { status: 200 },
      )
    }
    vi.doMock('../../backend', () => ({
      isTauri: () => false,
      localFetch: vi.fn(async (url: string, init?: { body?: unknown }) => reply(url, init)),
      localFetchStream: vi.fn(async (url: string, init?: { body?: unknown }) => reply(url, init)),
      ollamaUrl: (path: string) => `/api${path}`,
    }))
    const { OllamaProvider } = await import('../ollama-provider')
    const p = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
    })
    await drain(p.chatStream('gemma3:4b', [{ role: 'user', content: 'hi' }], WITH_ROWS))
    await p.chatWithTools('gemma3:4b', [{ role: 'user', content: 'hi' }], [], WITH_ROWS)
    const chats = bodies.filter((b) => Array.isArray(b.messages))
    expect(chats).toHaveLength(2)
    for (const chat of chats) {
      const options = chat.options as Record<string, unknown>
      for (const [key, value] of Object.entries(ISSUE_ROWS)) {
        expect(options[key], key).toEqual(value)
        expect(key in chat, `${key} at the top level`).toBe(false)
      }
      expect(options.temperature).toBe(0.8)
      expect(options.top_p).toBeUndefined()
      expect(options.num_ctx).not.toBe(999)
      expect(chat.model).toBe('gemma3:4b')
    }
  })
})
