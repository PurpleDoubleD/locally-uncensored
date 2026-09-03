/**
 * Idle watchdog — Zeitbombe 4.
 *
 * Before this, the only bound on a chat stream was the Rust proxy's 7200 s
 * TOTAL timeout, and the direct-fetch paths (cloud providers, macOS/Linux,
 * browser dev mode) had none at all. A laptop that sleeps or Wi-Fi that drops
 * without a FIN leaves the socket half-open: `reader.read()` never settles and
 * the spinner runs until the user presses Stop.
 *
 * What is asserted here:
 *  - silence past the budget ends the read, and aborts the request first
 *  - the FIRST chunk gets a much longer grace (a cold model load is silent and
 *    healthy) — a 60 s cap there would abort every large local model
 *  - the budget is opt-in for NDJSON, because `ollama pull` is legitimately
 *    silent for minutes while it verifies a blob
 *  - both SSE providers turn the timeout into ONE terminal 'disconnect' chunk
 *  - and exactly one, also when the stream is closed from the other side
 *    (which is what the Rust-side idle timeout in proxy.rs looks like from
 *    here) — the two must not each contribute a terminal chunk
 *
 * Run: npx vitest run src/api/__tests__/stream-idle-watchdog.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  readChunks, StreamIdleTimeoutError, isStreamIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS, idleAbortGuard,
} from '../stream-idle'
import { OpenAIProvider } from '../providers/openai-provider'
import { AnthropicProvider } from '../providers/anthropic-provider'
import type { ProviderConfig } from '../providers/types'

/** A body that delivers `chunks` and then goes silent WITHOUT closing — the
 *  half-open connection a sleeping laptop leaves behind. */
function stalling(chunks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)) },
    // deliberately never close()
  }))
}

/** A body that delivers `chunks` and then closes cleanly — what a proxy-side
 *  idle timeout (or any tidy upstream cut) looks like to this side. */
function cleanCut(chunks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  }))
}

/** Watch a promise without consuming it, so "has not settled yet" is testable. */
function watch<T>(p: Promise<T>): () => boolean {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  return () => done
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('readChunks — the watchdog itself', () => {
  it('ends the read after the budget and aborts the request first', async () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const gen = readChunks(stalling(['hello']), { idleMs: 1000, firstChunkMs: 1000, onIdle })

    expect(new TextDecoder().decode((await gen.next()).value)).toBe('hello')

    const pending = gen.next()
    const settled = watch(pending)
    await vi.advanceTimersByTimeAsync(999)
    expect(settled()).toBe(false)

    await vi.advanceTimersByTimeAsync(2)
    await expect(pending).rejects.toBeInstanceOf(StreamIdleTimeoutError)
    // The abort has to happen BEFORE the throw: only that stops the upstream
    // (and, on the Tauri path, fires cancel_proxy_stream).
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('gives the first chunk a much longer grace than the stream', async () => {
    vi.useFakeTimers()
    const gen = readChunks(stalling([]), { idleMs: STREAM_IDLE_TIMEOUT_MS })

    const pending = gen.next()
    const settled = watch(pending)
    // A cold 30 GB model loading into VRAM is silent and perfectly healthy.
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000)
    expect(settled()).toBe(false)

    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS)
    await expect(pending).rejects.toBeInstanceOf(StreamIdleTimeoutError)
  })

  it('stays off unless asked — `ollama pull` is silent for minutes on purpose', async () => {
    vi.useFakeTimers()
    const enc = new TextEncoder()
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const res = new Response(new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; c.enqueue(enc.encode('{"status":"verifying sha256"}\n')) },
    }))

    const gen = readChunks(res)
    await gen.next()

    const pending = gen.next()
    const settled = watch(pending)
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS * 2)
    expect(settled()).toBe(false)

    // Let the generator finish so it does not outlive the test suspended in a
    // read (an async generator parked on an `await` cannot be .return()ed).
    ctrl.close()
    await pending
  })

  it('tags its error so a provider can tell silence from failure', () => {
    expect(isStreamIdleTimeout(new StreamIdleTimeoutError(60_000, 'stream'))).toBe(true)
    expect(isStreamIdleTimeout(new Error('boom'))).toBe(false)
    expect(new StreamIdleTimeoutError(60_000, 'stream').message).toMatch(/60s/)
  })
})

describe('idleAbortGuard', () => {
  it('passes the caller Stop inward, so the guard signal is the only one needed', () => {
    const outer = new AbortController()
    const guard = idleAbortGuard(outer.signal)
    expect(guard.signal.aborted).toBe(false)
    outer.abort()
    expect(guard.signal.aborted).toBe(true)
    guard.release()
  })

  it('lets the watchdog abort without the caller knowing', () => {
    const outer = new AbortController()
    const guard = idleAbortGuard(outer.signal)
    guard.abort()
    expect(guard.signal.aborted).toBe(true)
    expect(outer.signal.aborted).toBe(false)
    guard.release()
  })

  it('drops its listener on release, so a long session cannot pile them up', () => {
    const outer = new AbortController()
    const remove = vi.spyOn(outer.signal, 'removeEventListener')
    const guard = idleAbortGuard(outer.signal)
    guard.release()
    expect(remove).toHaveBeenCalled()
  })

  it('is already aborted when the caller was', () => {
    const outer = new AbortController()
    outer.abort()
    expect(idleAbortGuard(outer.signal).signal.aborted).toBe(true)
  })
})

// ── Provider level: the timeout becomes a terminal chunk ───────

function openAIConfig(): ProviderConfig {
  return {
    id: 'openai', name: 'TestProvider', enabled: true,
    baseUrl: 'https://api.test.com/v1', apiKey: 'k', isLocal: false,
  }
}

function anthropicConfig(): ProviderConfig {
  return {
    id: 'anthropic', name: 'Anthropic', enabled: true,
    baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', isLocal: false,
  }
}

describe('OpenAI-compatible stream that goes silent', () => {
  it('ends with one terminal disconnect chunk instead of an endless spinner', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      stalling(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n']))

    const stream = new OpenAIProvider(openAIConfig())
      .chatStream('gpt-4o', [{ role: 'user', content: 'hi' }])

    expect((await stream.next()).value).toMatchObject({ content: 'Hi', done: false })

    const pending = stream.next()
    const settled = watch(pending)
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1)
    expect(settled()).toBe(false)

    await vi.advanceTimersByTimeAsync(2)
    expect((await pending).value).toMatchObject({ done: true, finishReason: 'disconnect' })
    // ONE terminal chunk, not two — the end-of-stream fallback must not fire
    // on top of the watchdog's.
    expect((await stream.next()).done).toBe(true)
  })

  it('still emits exactly one when the OTHER side closes the stream', async () => {
    // What the Rust-side idle timeout in proxy.rs looks like from here: a
    // clean EOF. The watchdog's timer is cleared by the read that comes back
    // done, so the two never both contribute a chunk.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      cleanCut(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n']))

    const chunks = []
    for await (const c of new OpenAIProvider(openAIConfig())
      .chatStream('gpt-4o', [{ role: 'user', content: 'hi' }])) {
      chunks.push(c)
    }
    const terminal = chunks.filter(c => c.done)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].finishReason).toBe('disconnect')
  })
})

describe('Anthropic stream that goes silent', () => {
  it('ends with one terminal disconnect chunk', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => stalling([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    ]))

    const stream = new AnthropicProvider(anthropicConfig())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }])

    expect((await stream.next()).value).toMatchObject({ content: 'Hi', done: false })

    const pending = stream.next()
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect((await pending).value).toMatchObject({ done: true, finishReason: 'disconnect' })
    expect((await stream.next()).done).toBe(true)
  })
})
