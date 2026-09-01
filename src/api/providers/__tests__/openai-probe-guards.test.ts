/**
 * The context probe is an optimisation, not a gate — audit finding
 * "probeContextFromServer without signal and timeout".
 *
 * applyMaxTokens runs on EVERY send, and on a LAN backend without a catalogue
 * entry it reaches two HTTP probes. Both went out with neither an AbortSignal
 * nor a timeout, so a backend that accepts the TCP connection and then says
 * nothing — a wedged LM Studio, a half-suspended NAS — held the user's message
 * for the proxy's full default, twice over, with Stop unable to cut in. All the
 * probe buys is a better `max_tokens` estimate; the cascade already has a
 * heuristic for when it fails.
 *
 * Run: npx vitest run src/api/providers/__tests__/openai-probe-guards.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const localFetch = vi.fn()
const localFetchStream = vi.fn()

vi.mock('../../backend', async () => {
  const actual = await vi.importActual<typeof import('../../backend')>('../../backend')
  return {
    ...actual,
    isTauri: () => false,
    localFetch: (...a: Parameters<typeof import('../../backend').localFetch>) => localFetch(...a),
    localFetchStream: (...a: Parameters<typeof import('../../backend').localFetchStream>) => localFetchStream(...a),
    ensureProxyAllowsHost: async () => {},
  }
})

import { OpenAIProvider } from '../openai-provider'
import type { ProviderConfig, ChatStreamChunk } from '../types'

function lanConfig(port: number): ProviderConfig {
  return {
    id: 'openai', name: 'LM Studio', enabled: true,
    baseUrl: `http://192.168.1.44:${port}/v1`, apiKey: '', isLocal: true,
  }
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
})

describe('the side probes on the send path are bounded and cancellable', () => {
  it('every probe carries a timeout and the request signal', async () => {
    // A distinct port keeps this out of the module-level probe cache.
    const provider = new OpenAIProvider(lanConfig(1301))
    localFetch.mockResolvedValue(new Response('{}', { status: 404 }))
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))
    const abort = new AbortController()

    await drain(provider.chatStream(
      'some-unknown-local-model-a',
      [{ role: 'user', content: 'hi' }],
      { signal: abort.signal },
    ))

    expect(localFetch.mock.calls.length).toBeGreaterThan(0)
    for (const [url, init] of localFetch.mock.calls) {
      expect(typeof init?.timeoutMs, `${url} has no timeout`).toBe('number')
      expect(init.timeoutMs).toBeGreaterThan(0)
      expect(init.timeoutMs).toBeLessThanOrEqual(10_000)
      // Stop has to be able to cut the probe short; the guard signal chained
      // onto the caller's is what the request carries.
      expect(init.signal, `${url} runs without a signal`).toBeInstanceOf(AbortSignal)
    }
  })

  it('a probe that times out just falls back — the message still goes out', async () => {
    const provider = new OpenAIProvider(lanConfig(1302))
    // localFetch rejects the way an aborted timeout does.
    localFetch.mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    localFetchStream.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',
      { status: 200 },
    ))

    const chunks = await drain(provider.chatStream(
      'some-unknown-local-model-b',
      [{ role: 'user', content: 'hi' }],
    ))

    expect(chunks.map(c => c.content).join('')).toBe('Hi')
    // The heuristic still produced a usable budget instead of nothing.
    const body = JSON.parse(String(localFetchStream.mock.calls[0][1].body))
    expect(body.max_tokens).toBeGreaterThan(0)
  })

  it('a probed window still wins over the name heuristic', async () => {
    const provider = new OpenAIProvider(lanConfig(1303))
    localFetch.mockResolvedValue(
      new Response(JSON.stringify({ max_context_length: 32768 }), { status: 200 }),
    )
    expect(await provider.getContextLength('some-unknown-local-model-c')).toBe(32768)
  })
})
