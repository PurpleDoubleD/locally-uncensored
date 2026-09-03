/**
 * Die NDJSON-Grenze von `/api/chat` ist eine Grenze, keine Zusage.
 *
 * `parseNDJSONStream<T>` macht aus jedem `JSON.parse` ein `T` — per
 * Typzusicherung, ohne irgendetwas zu pruefen. Der Streaming-Pfad des
 * Ollama-Providers benannte dort eine handgeschriebene `OllamaChatChunk`-Form
 * und las danach `chunk.message?.tool_calls?.map(...)`. Auf dieser Route
 * antwortet aber nicht nur Ollama: llama.cpp-basierte Server, LiteLLM und
 * jeder selbstgebaute Proxy bedienen sie auch. Schickt einer davon
 * `tool_calls` als Objekt statt als Liste, ist `.map` keine Funktion und die
 * ganze Stream-Schleife reisst mit einem `TypeError` ab — mitten im Turn, mit
 * einer Meldung, die weder den Provider noch den Grund nennt.
 *
 * `parseOllamaChatChunk` in wire.ts gab es zu dem Zeitpunkt schon; es wurde
 * nur nirgends aufgerufen. Jetzt schon.
 *
 * Run: npx vitest run src/api/providers/__tests__/ollama-ndjson-boundary.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk } from '../types'

vi.mock('../../backend', () => ({
  isTauri: () => false,
  localFetch: vi.fn(),
  localFetchStream: vi.fn(),
  ollamaUrl: (path: string) => `/api${path}`,
}))

import { OllamaProvider } from '../ollama-provider'
import { localFetchStream } from '../../backend'

const mockLocalFetchStream = localFetchStream as ReturnType<typeof vi.fn>

const config: ProviderConfig = {
  id: 'ollama', name: 'Ollama', enabled: true,
  baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
}

/** Die NDJSON-Zeilen einmal durch den Provider laufen lassen. */
async function stream(lines: string[]): Promise<ChatStreamChunk[]> {
  mockLocalFetchStream.mockResolvedValueOnce(new Response(lines.join('\n') + '\n', { status: 200 }))
  const out: ChatStreamChunk[] = []
  for await (const c of new OllamaProvider(config)
    .chatStream('qwen2.5-coder:14b', [{ role: 'user', content: 'hi' }])) {
    out.push(c)
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a foreign /api/chat body cannot tear down the stream loop', () => {
  it('survives a tool_calls field that is not an array', async () => {
    const chunks = await stream([
      '{"message":{"content":"one moment","tool_calls":{"function":{"name":"file_read"}}},"done":false}',
      '{"message":{"content":""},"done":true,"done_reason":"stop"}',
    ])

    // Der Inhalt kommt an, der Turn endet sauber, und aus der unbrauchbaren
    // Form wird kein Tool-Call erfunden.
    expect(chunks.map(c => c.content).join('')).toBe('one moment')
    expect(chunks.flatMap(c => c.toolCalls ?? [])).toEqual([])
    expect(chunks.filter(c => c.done)).toHaveLength(1)
  })

  it('survives a message that is not an object', async () => {
    const chunks = await stream([
      '{"message":"just a string","done":false}',
      '{"message":{"content":"ok"},"done":true,"done_reason":"stop"}',
    ])

    expect(chunks.map(c => c.content).join('')).toBe('ok')
    expect(chunks.filter(c => c.done)).toHaveLength(1)
  })

  it('reports done as a real boolean, whatever the server put there', async () => {
    const chunks = await stream([
      '{"message":{"content":"hi"},"done":"true"}',
    ])

    // Frueher ging der String `"true"` als `done` durch den ChatStreamChunk —
    // typisiert als `boolean`, und jede `=== true`-Pruefung weiter oben las
    // ihn falsch. Ein Feld, das nicht das ist, was es zu sein behauptet,
    // beendet den Turn jetzt nicht mehr; der Abbruch faellt als
    // 'disconnect' auf, statt still als sauberes Ende durchzugehen.
    for (const c of chunks) expect(typeof c.done).toBe('boolean')
    expect(chunks[chunks.length - 1].finishReason).toBe('disconnect')
  })

  it('reports the server metrics as numbers, not as whatever arrived', async () => {
    const chunks = await stream([
      '{"message":{"content":"hi"},"done":true,"eval_count":"12","prompt_eval_count":7}',
    ])

    const last = chunks[chunks.length - 1]
    expect(last.evalCount).toBeUndefined()
    expect(last.promptEvalCount).toBe(7)
  })

  it('leaves a well-formed stream exactly as it was', async () => {
    const chunks = await stream([
      '{"message":{"content":"hel","thinking":"hm"},"done":false}',
      '{"message":{"content":"lo"},"done":false}',
      '{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":3,"prompt_eval_count":9,"eval_duration":2000000}',
    ])

    expect(chunks.map(c => c.content).join('')).toBe('hello')
    expect(chunks.find(c => c.thinking)?.thinking).toBe('hm')
    const last = chunks[chunks.length - 1]
    expect(last.done).toBe(true)
    expect(last.finishReason).toBe('stop')
    expect(last.evalCount).toBe(3)
    expect(last.promptEvalCount).toBe(9)
    expect(last.evalDurationMs).toBe(2)
  })
})
