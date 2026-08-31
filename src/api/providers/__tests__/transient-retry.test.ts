/**
 * Retry on 429/503 — the Sanierungspfad item.
 *
 * A throttle or a gateway hiccup says nothing about the request, and it used
 * to reach the user as the raw status line. The rules this has to keep while
 * fixing that are the interesting part, and each one has a test below:
 *
 *  - only transient statuses; a deterministic 4xx surfaces at once
 *  - `Retry-After` beats the local ladder, because a fixed-window limiter
 *    refuses again for the whole window
 *  - an empty wallet also answers 429 and no wait fixes it (credits_exhausted)
 *  - abortable: Stop must not queue behind a backoff
 *  - a small number of attempts, and never around a stream already running
 *
 * Run: npx vitest run src/api/providers/__tests__/transient-retry.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  sendWithTransientRetry, MAX_TRANSIENT_ATTEMPTS, MAX_SILENT_RETRY_WAIT_MS,
} from '../retry'
import { OpenAIProvider } from '../openai-provider'
import type { ProviderConfig, ChatStreamChunk } from '../types'

/** Records every backoff instead of sleeping it. */
function recorder() {
  const waited: number[] = []
  return {
    waited,
    wait: async (ms: number) => { waited.push(ms) },
  }
}

function res(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sendWithTransientRetry', () => {
  it('retries a 429 with a growing backoff and returns the first good answer', async () => {
    const clock = recorder()
    const send = vi.fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200, 'ok'))

    const out = await sendWithTransientRetry(send, { wait: clock.wait })

    expect(out.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
    expect(clock.waited).toEqual([500])
  })

  it('backs off exponentially across attempts', async () => {
    const clock = recorder()
    const send = vi.fn().mockResolvedValue(res(503))

    const out = await sendWithTransientRetry(send, { wait: clock.wait })

    expect(out.status).toBe(503)
    expect(send).toHaveBeenCalledTimes(MAX_TRANSIENT_ATTEMPTS)
    expect(clock.waited).toEqual([500, 1000])
  })

  it('honours Retry-After over its own ladder', async () => {
    const clock = recorder()
    const send = vi.fn()
      .mockResolvedValueOnce(res(429, '', { 'retry-after': '3' }))
      .mockResolvedValueOnce(res(200, 'ok'))

    await sendWithTransientRetry(send, { wait: clock.wait })

    expect(clock.waited).toEqual([3000])
  })

  it('does not sit out a wait it cannot announce', async () => {
    // A minute of frozen composer is worse than the honest rate-limit error;
    // the agent loop has its own ANNOUNCED ladder for windows that long.
    const clock = recorder()
    const send = vi.fn().mockResolvedValue(res(429, '', { 'retry-after': '120' }))

    const out = await sendWithTransientRetry(send, { wait: clock.wait })

    expect(out.status).toBe(429)
    expect(send).toHaveBeenCalledTimes(1)
    expect(clock.waited).toEqual([])
    expect(MAX_SILENT_RETRY_WAIT_MS).toBeLessThan(120_000)
  })

  it('leaves a deterministic 4xx alone', async () => {
    const clock = recorder()
    for (const status of [400, 401, 403, 404, 422]) {
      const send = vi.fn().mockResolvedValue(res(status))
      const out = await sendWithTransientRetry(send, { wait: clock.wait })
      expect(out.status).toBe(status)
      expect(send).toHaveBeenCalledTimes(1)
    }
    expect(clock.waited).toEqual([])
  })

  it('does not retry an empty wallet, which answers 429 too', async () => {
    const clock = recorder()
    const send = vi.fn().mockResolvedValue(
      res(429, JSON.stringify({ error: { code: 'credits_exhausted', message: 'no credits' } })),
    )

    const out = await sendWithTransientRetry(send, { wait: clock.wait })

    expect(send).toHaveBeenCalledTimes(1)
    expect(clock.waited).toEqual([])
    // The body the caller still has to read must be untouched by the peek.
    expect(await out.text()).toContain('credits_exhausted')
  })

  it('stops on abort instead of queueing Stop behind a backoff', async () => {
    const abort = new AbortController()
    const send = vi.fn().mockResolvedValue(res(503))
    const wait = vi.fn(async () => { abort.abort() })

    const out = await sendWithTransientRetry(send, { signal: abort.signal, wait })

    expect(out.status).toBe(503)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not start at all once the caller has already aborted', async () => {
    const abort = new AbortController()
    abort.abort()
    const clock = recorder()
    const send = vi.fn().mockResolvedValue(res(429))

    await sendWithTransientRetry(send, { signal: abort.signal, wait: clock.wait })

    expect(send).toHaveBeenCalledTimes(1)
    expect(clock.waited).toEqual([])
  })

  it('really sleeps when no clock is injected, and the sleep is abortable', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const send = vi.fn().mockResolvedValue(res(503))

    const running = sendWithTransientRetry(send, { signal: abort.signal })
    await vi.advanceTimersByTimeAsync(10)
    expect(send).toHaveBeenCalledTimes(1)

    abort.abort()
    await vi.advanceTimersByTimeAsync(1)
    expect((await running).status).toBe(503)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

// ── Through the provider, on the real send path ───────────────

function openAIConfig(): ProviderConfig {
  return {
    id: 'openai', name: 'TestProvider', enabled: true,
    baseUrl: 'https://api.test.com/v1', apiKey: 'k', isLocal: false,
  }
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('the chat send path retries a throttle', () => {
  it('a 429 followed by a good answer produces the answer, not the error', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(429, JSON.stringify({ error: { message: 'slow down' } })))
      .mockResolvedValueOnce(new Response(
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ))
    vi.stubGlobal('fetch', fetchMock)

    const running = drain(new OpenAIProvider(openAIConfig())
      .chatStream('gpt-4o', [{ role: 'user', content: 'hi' }]))
    await vi.advanceTimersByTimeAsync(1000)
    const chunks = await running

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(chunks.map(c => c.content).join('')).toBe('Hi')
  })

  it('a throttle that never lifts still ends as the honest rate-limit error', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(async () =>
      res(429, JSON.stringify({ error: { message: 'slow down' } })))
    vi.stubGlobal('fetch', fetchMock)

    const running = drain(new OpenAIProvider(openAIConfig())
      .chatStream('gpt-4o', [{ role: 'user', content: 'hi' }])).then(() => null, (e: any) => e)
    await vi.advanceTimersByTimeAsync(5000)
    const err = await running

    expect(fetchMock).toHaveBeenCalledTimes(MAX_TRANSIENT_ATTEMPTS)
    expect(err.code).toBe('rate_limit')
  })

  it('never retries once the stream has started — a cut mid-answer is terminal', async () => {
    // The body is already partly delivered, so a re-post would replay half an
    // answer. The truncated stream ends with its terminal chunk instead.
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const chunks = await drain(new OpenAIProvider(openAIConfig())
      .chatStream('gpt-4o', [{ role: 'user', content: 'hi' }]))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(chunks[chunks.length - 1]).toMatchObject({ done: true, finishReason: 'disconnect' })
  })
})
