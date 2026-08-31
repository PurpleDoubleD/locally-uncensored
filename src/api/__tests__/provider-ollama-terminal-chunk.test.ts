/**
 * Ollama always ends its turn — audit finding "no terminal done-chunk on a
 * truncated NDJSON stream".
 *
 * Ollama marks the end of a turn with a `"done":true` line, and nothing
 * guarantees it arrives: a runner OOM, VRAM eviction by an image job,
 * `ollama stop`, a proxy or LAN cut all end the NDJSON mid-line. The generator
 * then simply returned, and the chat layer — which only explains a turn it was
 * handed a finishReason for — left a permanently empty assistant bubble with
 * no hint whatsoever. Ollama is the most-used local backend and every one of
 * those triggers is an ordinary Tuesday.
 *
 * The OpenAI provider has ended its stream with an explicit terminal chunk for
 * several releases; this pulls the same semantics over.
 *
 * Run: npx vitest run src/api/__tests__/provider-ollama-terminal-chunk.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk } from '../providers/types'

vi.mock('../backend', () => ({
  isTauri: () => false,
  localFetch: vi.fn(),
  localFetchStream: vi.fn(),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
}))

import { OllamaProvider } from '../providers/ollama-provider'
import { localFetchStream } from '../backend'
import { STREAM_IDLE_TIMEOUT_MS } from '../stream-idle'

const mockStream = localFetchStream as ReturnType<typeof vi.fn>

const config: ProviderConfig = {
  id: 'ollama', name: 'Ollama', enabled: true,
  baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
}

/** NDJSON that stops mid-turn without ever closing — a dropped LAN link. */
function stalling(lines: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)) },
  }), { status: 200 })
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe('OllamaProvider.chatStream — the turn always ends', () => {
  it('a truncated stream ends terminally instead of leaving an empty bubble', async () => {
    // Two content lines, then the connection dies. No done:true ever arrives.
    mockStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"Once upon"},"done":false}\n' +
      '{"message":{"content":" a ti',
      { status: 200 },
    ))

    const chunks = await drain(new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }]))

    const terminal = chunks.filter(c => c.done)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].finishReason).toBe('disconnect')
    // The partial text the model DID produce is still delivered.
    expect(chunks.map(c => c.content).join('')).toBe('Once upon')
  })

  it('an empty truncated stream still says why, rather than nothing at all', async () => {
    mockStream.mockResolvedValueOnce(new Response('', { status: 200 }))

    const chunks = await drain(new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }]))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ done: true, finishReason: 'disconnect' })
  })

  it('does not add a second terminal chunk to a healthy turn', async () => {
    mockStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"hello"},"done":false}\n' +
      '{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":3}\n',
      { status: 200 },
    ))

    const chunks = await drain(new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }]))

    const terminal = chunks.filter(c => c.done)
    expect(terminal).toHaveLength(1)
    expect(terminal[0].finishReason).toBe('stop')
    expect(terminal[0].evalCount).toBe(3)
  })

  it('a user Stop is not a disconnect and gets no terminal chunk', async () => {
    const abort = new AbortController()
    mockStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"a"},"done":false}\n' +
      '{"message":{"content":"b"},"done":false}\n',
      { status: 200 },
    ))

    const chunks: ChatStreamChunk[] = []
    for await (const c of new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }], { signal: abort.signal })) {
      chunks.push(c)
      abort.abort()
    }
    expect(chunks.every(c => !c.done)).toBe(true)
  })

  it('a mid-stream error line still throws — silence is not the failure mode there', async () => {
    mockStream.mockResolvedValueOnce(new Response(
      '{"error":"llama runner process has terminated: signal: killed"}\n',
      { status: 200 },
    ))
    await expect(drain(new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }])))
      .rejects.toThrow(/llama runner process has terminated/)
  })
})

describe('OllamaProvider.chatStream — the idle watchdog reaches this path too', () => {
  it('a stream that goes silent ends as a disconnect, not as a dead spinner', async () => {
    vi.useFakeTimers()
    mockStream.mockResolvedValueOnce(stalling(['{"message":{"content":"Hi"},"done":false}\n']))

    const stream = new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }])

    expect((await stream.next()).value).toMatchObject({ content: 'Hi', done: false })

    const pending = stream.next()
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect((await pending).value).toMatchObject({ done: true, finishReason: 'disconnect' })
    expect((await stream.next()).done).toBe(true)
  })

  it('passes the guard signal, not the raw one, so the watchdog can abort', async () => {
    mockStream.mockResolvedValueOnce(stalling(['{"message":{"content":"Hi"},"done":false}\n']))
    const abort = new AbortController()
    const stream = new OllamaProvider(config)
      .chatStream('llama3', [{ role: 'user', content: 'hi' }], { signal: abort.signal })
    await stream.next()

    const sent: AbortSignal = mockStream.mock.calls[0][1].signal
    expect(sent).toBeInstanceOf(AbortSignal)
    // A provider is only ever handed a signal, so the watchdog needs its own
    // controller — and Stop must still reach through it while the stream lives.
    expect(sent).not.toBe(abort.signal)
    abort.abort()
    expect(sent.aborted).toBe(true)
  })
})
