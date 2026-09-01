/**
 * Zwei Formen, die nur ein PROXY schickt — und genau Proxys unterstuetzt
 * dieser Provider ausdruecklich: `messagesUrl()` raeumt fuer sie ein doppeltes
 * `/v1` weg, `useLocalProxy` schickt sie ueber den Rust-Proxy, und der
 * Cache-Kommentar nennt LiteLLM, claude-relay-server und opencode-zen beim
 * Namen. Anthropic selbst sendet beide Formen nicht; wer sie sieht, sitzt
 * hinter einer Zwischenstation, die das Protokoll nachbaut.
 *
 * 1. `content_block_start` OHNE `index`.
 *    Vor 0e740f60 stand dort `toolUseBlocks.set(data.index!, …)`. Die
 *    Non-null-Assertion galt auf einem Feld, das dieselbe Datei als optional
 *    deklariert hatte: der Block landete unter dem Schluessel `undefined`,
 *    jedes `content_block_delta` suchte ihn unter seiner echten Zahl und fand
 *    nichts — und am Ende ging der Tool-Call mit `{}` raus. Ein `file_read`
 *    ohne `path`, an das Modell zurueckgemeldet als "Tool hat versagt", statt
 *    als das, was es war.
 *
 * 2. Eine 200er-Antwort OHNE `content`.
 *    `const data: AnthropicResponse = await res.json()` behauptete das Feld
 *    und die Schleife darunter iterierte es sofort. Ein Proxy, der einen
 *    Fehler als HTTP 200 mit Fehler-Body durchreicht, brach damit als nackter
 *    `TypeError` aus dem Provider — ohne Provider-Namen, ohne Status, ohne
 *    irgendetwas, woran der Chat-Layer eine Erklaerung haette aufhaengen
 *    koennen.
 *
 * Run: npx vitest run src/api/providers/__tests__/anthropic-proxy-shapes.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicProvider } from '../anthropic-provider'
import type { ProviderConfig, ChatStreamChunk } from '../types'

// api.anthropic.com steht auf der gepinnten CSP-Liste, nimmt also den
// direkten `fetch` — den, den `vi.stubGlobal` hier ersetzt. Die Form der
// ANTWORT ist das Proxy-Verhalten, das dieser Test beschreibt; ueber welchen
// Transport sie kommt, ist dafuer unerheblich.
function config(): ProviderConfig {
  return {
    id: 'anthropic', name: 'Anthropic', enabled: true,
    baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', isLocal: false,
  }
}

function sse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a proxy that opens a tool_use block without an index', () => {
  // Der Mitschnitt-Fall: `content_block_start` ohne `index`, die
  // `input_json_delta`-Fragmente danach MIT `index`. Genau diese Mischung
  // liess den Tool-Call mit leeren Argumenten rausgehen.
  const PROXY_STREAM = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"file_read"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]

  it('never emits a tool call whose arguments the deltas could not reach', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(PROXY_STREAM)))

    const chunks = await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))

    const calls = chunks.flatMap(c => c.toolCalls ?? [])
    // Der Schaden war nicht "ein Tool-Call fehlt", sondern "ein Tool-Call mit
    // leeren Argumenten geht raus und wird ausgefuehrt". Beides wird hier
    // benannt, damit ein spaeterer Umbau, der die Argumente wirklich
    // einsammelt, diesen Test nicht falsch-positiv rot macht.
    for (const call of calls) {
      expect(Object.keys(call.function.arguments).length).toBeGreaterThan(0)
    }
    expect(calls.filter(c => Object.keys(c.function.arguments).length === 0)).toEqual([])
  })

  it('still ends the turn cleanly instead of hanging on the orphaned block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(PROXY_STREAM)))

    const chunks = await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))

    const done = chunks.filter(c => c.done)
    expect(done).toHaveLength(1)
    expect(done[0].finishReason).toBe('stop')
    // Die uebrigen Felder des Streams kommen unveraendert durch — der Guard
    // sitzt am Tool-Block, nicht am Event.
    expect(done[0].promptEvalCount).toBe(11)
  })

  it('leaves the well-formed case alone — an indexed block still carries its arguments', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"file_read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])))

    const calls = (await drain(new AnthropicProvider(config())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }])))
      .flatMap(c => c.toolCalls ?? [])

    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('file_read')
    expect(calls[0].function.arguments).toEqual({ path: 'README.md' })
  })
})

describe('a 200 response whose body carries no content array', () => {
  it('yields an empty turn instead of throwing a bare TypeError', async () => {
    // Die Form, die ein Relay durchreicht, wenn es upstream einen Fehler
    // bekommt, aber selbst schon mit 200 geantwortet hat.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream said no' } }),
      { status: 200 },
    )))

    const result = await new AnthropicProvider(config()).chatWithTools(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      [],
    )

    expect(result.content).toBe('')
    expect(result.toolCalls).toEqual([])
  })

  it('does the same for a body that is not an object at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })))

    const result = await new AnthropicProvider(config()).chatWithTools(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      [],
    )

    expect(result.content).toBe('')
    expect(result.toolCalls).toEqual([])
  })

  it('a body WITH content is still read the way it always was', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: { path: 'README.md' } },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    }), { status: 200 })))

    const result = await new AnthropicProvider(config()).chatWithTools(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      [],
    )

    expect(result.content).toBe('here you go')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function).toEqual({
      name: 'file_read', arguments: { path: 'README.md' },
    })
    expect(result.promptEvalCount).toBe(7)
  })
})
