/**
 * Three Anthropic audit findings that all end the same way — a turn that
 * cannot work, or a failure the user never gets told about.
 *
 * 1. Extended Thinking could only ever produce a 400. `budget_tokens: 5000`
 *    was sent against the `max_tokens: 4096` default (the API carves the
 *    budget OUT of max_tokens, so it must be strictly smaller), and
 *    temperature/top_p/top_k rode along, which the API forbids together with
 *    thinking. The 400-retry then dropped `thinking` and succeeded — which is
 *    exactly why nobody noticed: Extended Thinking has never once run, and
 *    every Anthropic turn quietly paid for a whole extra request first.
 *    (useChat injects a `<think>` prompt for non-Ollama models, so a thinking
 *    block still appeared in the UI.)
 *
 * 2. An `error` event on an HTTP-200 stream — overloaded_error, api_error —
 *    hit a switch with no arm for it and was dropped. The stream then ended
 *    without message_stop, so Anthropic's own outage reached the user as an
 *    empty bubble blaming their network.
 *
 * 3. The custom/relay baseUrl this provider goes out of its way to support
 *    (see messagesUrl) was issued as a raw webview fetch, which the pinned CSP
 *    kills in the packaged app before it reaches the network.
 *
 * Run: npx vitest run src/api/providers/__tests__/anthropic-thinking-and-errors.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const localFetch = vi.fn()
const localFetchStream = vi.fn()
const ensureProxyAllowsHost = vi.fn(async () => {})

vi.mock('../../backend', async () => {
  const actual = await vi.importActual<typeof import('../../backend')>('../../backend')
  return {
    ...actual,
    isTauri: () => false,
    localFetch: (...a: any[]) => localFetch(...a),
    localFetchStream: (...a: any[]) => localFetchStream(...a),
    ensureProxyAllowsHost: (...a: any[]) => ensureProxyAllowsHost(...(a as [])),
  }
})

import { AnthropicProvider } from '../anthropic-provider'
import { ProviderError } from '../types'
import type { ProviderConfig, ChatStreamChunk } from '../types'

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic', name: 'Anthropic', enabled: true,
    baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', isLocal: false,
    ...overrides,
  }
}

function sse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })
}

const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

function sentBody(mock: { mock: { calls: any[][] } }, call = 0): any {
  return JSON.parse(String(mock.mock.calls[call]?.[1]?.body ?? '{}'))
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
  localFetch.mockReset()
  localFetchStream.mockReset()
  ensureProxyAllowsHost.mockReset()
})

describe('Extended Thinking sends a body the API can accept', () => {
  it('keeps max_tokens strictly above budget_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([STOP]))
    vi.stubGlobal('fetch', fetchMock)

    await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], { thinking: true }))

    const body = sentBody(fetchMock)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: expect.any(Number) })
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens)
    // The API's own floor for a reasoning budget.
    expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024)
  })

  it('drops temperature / top_p / top_k, which thinking forbids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([STOP]))
    vi.stubGlobal('fetch', fetchMock)

    await drain(new AnthropicProvider(config()).chatStream(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      { thinking: true, temperature: 0.7, topP: 0.9, topK: 40 },
    ))

    const body = sentBody(fetchMock)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('top_k')
  })

  it('never needs the drop-thinking retry any more — one request, not two', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([STOP]))
    vi.stubGlobal('fetch', fetchMock)

    await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], { thinking: true }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still leaves the sampling knobs alone when thinking is off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([STOP]))
    vi.stubGlobal('fetch', fetchMock)

    await drain(new AnthropicProvider(config()).chatStream(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.7, topP: 0.9 },
    ))

    const body = sentBody(fetchMock)
    expect(body.temperature).toBe(0.7)
    expect(body.top_p).toBe(0.9)
    expect(body).not.toHaveProperty('thinking')
  })

  it('respects a lowered Max Tokens instead of eating it whole', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([STOP]))
    vi.stubGlobal('fetch', fetchMock)

    await drain(new AnthropicProvider(config()).chatStream(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      { thinking: true, maxTokens: 20000 },
    ))

    const body = sentBody(fetchMock)
    expect(body.max_tokens).toBe(20000)
    expect(body.thinking.budget_tokens).toBeLessThanOrEqual(10000)
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens)
  })

  it('applies to the non-streaming tool path as well', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await new AnthropicProvider(config()).chatWithTools(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      [],
      { thinking: true, temperature: 0.5 },
    )

    const body = sentBody(fetchMock)
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens)
    expect(body).not.toHaveProperty('temperature')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a mid-stream error event is no longer swallowed', () => {
  it('raises the overload instead of an empty disconnect bubble', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ])))

    const err = await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))
      .then(() => null, (e: unknown) => e as ProviderError)

    expect(err).toBeInstanceOf(ProviderError)
    expect(err!.message).toBe('Overloaded')
    expect(err!.code).toBe('overloaded')
    expect(err!.status).toBe(529)
  })

  it('maps a mid-stream rate limit onto a retryable status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}\n\n',
    ])))

    const err = await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))
      .then(() => null, (e: unknown) => e as ProviderError)

    expect(err!.code).toBe('rate_limit')
    expect(err!.status).toBe(429)
  })

  it('names an api_error even when the payload carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n',
    ])))

    const err = await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))
      .then(() => null, (e: unknown) => e as ProviderError)

    expect(err!.message).toMatch(/api_error/)
    expect(err!.provider).toBe('anthropic')
  })

  it('a healthy stream is untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      STOP,
    ])))

    const chunks = await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))

    expect(chunks.map(c => c.content).join('')).toBe('Hi')
    expect(chunks.filter(c => c.done)).toHaveLength(1)
    expect(chunks[chunks.length - 1].finishReason).toBe('stop')
  })
})

describe('a custom relay baseUrl reaches the network at all', () => {
  it('takes the Rust proxy, because the pinned CSP would kill a direct fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    localFetchStream.mockResolvedValue(sse([STOP]))

    await drain(new AnthropicProvider(config({ baseUrl: 'https://claude-relay.example.com/v1' }))
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))

    expect(localFetchStream).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    // …and the host is registered with the proxy allow-list first, or the
    // proxy would refuse to forward to it.
    expect(ensureProxyAllowsHost).toHaveBeenCalledWith('https://claude-relay.example.com/v1')
    // The /v1 de-duplication survives the transport change.
    expect(localFetchStream.mock.calls[0][0]).toBe('https://claude-relay.example.com/v1/messages')
    // The API key still travels — the proxy path forwards caller headers.
    expect(localFetchStream.mock.calls[0][1].headers['x-api-key']).toBe('sk-ant-test')
  })

  it('a LAN relay takes the proxy too', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    localFetchStream.mockResolvedValue(sse([STOP]))

    await drain(new AnthropicProvider(config({ baseUrl: 'http://192.168.1.50:8082' }))
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))

    expect(localFetchStream).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('api.anthropic.com keeps its direct fetch — the CSP names it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([STOP]))
    vi.stubGlobal('fetch', fetchMock)

    await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }]))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localFetchStream).not.toHaveBeenCalled()
  })

  it('the non-streaming path routes the same way', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    localFetch.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }),
    )

    const out = await new AnthropicProvider(config({ baseUrl: 'https://relay.example.com' }))
      .chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])

    expect(out.content).toBe('ok')
    expect(localFetch).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
