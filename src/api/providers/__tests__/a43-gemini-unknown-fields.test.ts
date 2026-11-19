/**
 * A43 (Discord, 19.11.2026): Gemini's OpenAI compatible endpoint gave a fixed
 * 400 on every model. Measured the same day against
 * generativelanguage.googleapis.com/v1beta/openai/chat/completions: the body
 * is checked before the key, and every field Google does not know is refused,
 * "Unknown name "top_k": Cannot find field." LU sends top_k on every request.
 * Now the fields an endpoint names are dropped, the request goes again, and
 * the endpoint is not sent them any more.
 *
 * Run: npx vitest run src/api/providers/__tests__/a43-gemini-unknown-fields.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk } from '../types'
import type { FetchArgs } from '../../__tests__/provider-test-support'
import { unknownFieldsIn } from '../unknown-fields'

const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
/** Google's answer, word for word as measured (one line per refused field). */
const GOOGLE_400 = JSON.stringify([{ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "top_k": Cannot find field.\nInvalid JSON payload received. Unknown name "frequency_penalty": Cannot find field.', status: 'INVALID_ARGUMENT' } }])
const REFUSED = new Set(['top_k', 'frequency_penalty', 'seed', 'chat_template_kwargs', 'thinking_budget_tokens', 'ttl', 'continue_final_message'])

let sent: Record<string, unknown>[]

/** A fake Gemini: refuses any field it does not know, by name, like Google. */
function gemini(init: { body?: string }) {
  const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
  sent.push(body)
  const bad = Object.keys(body).filter((k) => REFUSED.has(k))
  if (bad.length) {
    const message = bad.map((k) => `Invalid JSON payload received. Unknown name "${k}": Cannot find field.`).join('\n')
    return new Response(JSON.stringify([{ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }]), { status: 400 })
  }
  if (body.stream) return new Response(streamBody, { status: 200 })
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
}

async function makeProvider(config: ProviderConfig) {
  vi.resetModules()
  sent = []
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async (_u: string, init: { body?: string }) => gemini(init)),
    localFetchStream: vi.fn(async (_u: string, init: { body?: string }) => gemini(init)),
    backendCall: vi.fn(),
    isPrivateOrLanHost: () => false,
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

const GEMINI: ProviderConfig = {
  id: 'openai', name: 'Gemini', apiKey: 'AIza-test', enabled: true,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', isLocal: false,
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>) {
  let text = ''
  for await (const c of gen) text += c.content ?? ''
  return text
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: FetchArgs[0], init: FetchArgs[1]) =>
    gemini({ body: typeof init?.body === 'string' ? init.body : undefined }))
})
afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('reading the refused fields', () => {
  it('Google, OpenAI and pydantic servers', () => {
    expect(unknownFieldsIn(GOOGLE_400)).toEqual(['top_k', 'frequency_penalty'])
    expect(unknownFieldsIn('{"error":{"message":"Unrecognized request argument supplied: top_k"}}')).toEqual(['top_k'])
    expect(unknownFieldsIn('{"detail":[{"type":"extra_forbidden","loc":["body","min_p"],"msg":"Extra inputs are not permitted"}]}')).toEqual(['min_p'])
  })
  it('never the fields a request needs, and nothing from an unrelated 400', () => {
    expect(unknownFieldsIn('Unknown name "messages": Cannot find field.')).toEqual([])
    expect(unknownFieldsIn('{"error":{"message":"This model maximum context length is 8192 tokens"}}')).toEqual([])
    expect(unknownFieldsIn('Please pass a valid API key')).toEqual([])
  })
})

describe('chat with a Gemini key', () => {
  it('THE REPORT: the answer arrives although top_k and friends were in the first request', async () => {
    const p = await makeProvider(GEMINI)
    const text = await drain(p.chatStream('gemini-2.5-flash', [{ role: 'user', content: 'hi' }], { topK: 40, frequencyPenalty: 0.2, temperature: 0.7 }))
    expect(text).toBe('hi')
    expect(sent[0].top_k).toBe(40)
    const last = sent.at(-1)!
    expect('top_k' in last).toBe(false)
    expect('frequency_penalty' in last).toBe(false)
    expect(last.temperature).toBe(0.7)
  })

  it('the next request leaves them out from the start, no second refusal', async () => {
    const p = await makeProvider(GEMINI)
    await drain(p.chatStream('gemini-2.5-flash', [{ role: 'user', content: 'hi' }], { topK: 40 }))
    const before = sent.length
    await drain(p.chatStream('gemini-2.5-flash', [{ role: 'user', content: 'again' }], { topK: 40 }))
    expect(sent.length).toBe(before + 1)
    expect('top_k' in sent.at(-1)!).toBe(false)
  })

  it('the agent path (tools) gets through the same way', async () => {
    const p = await makeProvider({ ...GEMINI, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' })
    const r = await p.chatWithTools('gemini-2.5-pro', [{ role: 'user', content: 'hi' }], [], { topK: 40 })
    expect(r.content).toBe('ok')
  })
})
