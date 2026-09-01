/**
 * Zwei Formen, die nur ein PROXY schickt — und genau Proxys unterstuetzt
 * dieser Provider ausdruecklich: `messagesUrl()` raeumt fuer sie ein doppeltes
 * `/v1` weg, `useLocalProxy` schickt sie ueber den Rust-Proxy, und der
 * Cache-Kommentar nennt LiteLLM, claude-relay-server und opencode-zen beim
 * Namen. Anthropic selbst sendet beide Formen nicht; wer sie sieht, sitzt
 * hinter einer Zwischenstation, die das Protokoll nachbaut.
 *
 * 1. Ein `tool_use`-Block, dessen Events kein `index` tragen.
 *
 *    `index` ist der Schluessel, unter dem `content_block_start` den Block
 *    anlegt und `content_block_delta` seine JSON-Fragmente nachschiebt. Drei
 *    Formen kommen auf dieser Route an, und die Geschichte des Codes hat jede
 *    einzelne davon schon einmal fallen lassen:
 *
 *      (a) Start und Deltas beide MIT index — Anthropic selbst.
 *      (b) Start OHNE, Deltas MIT — `set(data.index!)` legte den Block unter
 *          `undefined` an, jedes Delta suchte unter `0` und fand nichts: der
 *          Tool-Call ging mit `{}` raus. Ein `file_read` ohne `path`, das dem
 *          Modell als "Tool hat versagt" zurueckgemeldet wurde.
 *      (c) Start und Deltas beide OHNE — lief unter `set(data.index!)`
 *          versehentlich RICHTIG, weil beide Seiten auf `undefined`
 *          schluesselten. Der erste Reparaturversuch (Event ueberspringen,
 *          wenn `index` fehlt) hat (b) geheilt und dabei (c) zerbrochen: der
 *          Tool-Call verschwand still, ohne Chunk und ohne Meldung.
 *
 *    Deshalb stehen alle drei hier mit einem eigenen Fall. Die Regel dahinter
 *    ist `keyForUnindexedBlock` in wire.ts — dieselbe, mit der der
 *    OpenAI-Akkumulator seit jeher indexlose Deltas einsortiert.
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
import type { ProviderConfig, ChatStreamChunk, ToolCall } from '../types'

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

/** Den Stream einmal durchlaufen lassen und die Chunks einsammeln. */
async function chunksOf(events: string[]): Promise<ChatStreamChunk[]> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(events)))
  return drain(new AnthropicProvider(config())
    .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))
}

async function toolCallsOf(events: string[]): Promise<ToolCall[]> {
  return (await chunksOf(events)).flatMap(c => c.toolCalls ?? [])
}

// ── Die drei Event-Formen, gleicher Inhalt, unterschiedlich indiziert ──

const START_MESSAGE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"output_tokens":0}}}\n\n'
const STOP =
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'

/** `content_block_start` fuer einen tool_use-Block, mit oder ohne `index`. */
function blockStart(id: string, name: string, index?: number): string {
  const idx = index === undefined ? '' : `"index":${index},`
  return `event: content_block_start\ndata: {"type":"content_block_start",${idx}"content_block":{"type":"tool_use","id":"${id}","name":"${name}"}}\n\n`
}

/** Ein `input_json_delta`-Fragment, mit oder ohne `index`. */
function jsonDelta(fragment: string, index?: number): string {
  const idx = index === undefined ? '' : `"index":${index},`
  return `event: content_block_delta\ndata: {"type":"content_block_delta",${idx}"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(fragment)}}}\n\n`
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a tool_use block arrives intact however the proxy numbers it', () => {
  // Alle drei Faelle tragen denselben Aufruf. Die Erwartung ist deshalb in
  // allen drei identisch — genau das ist die Aussage.
  const WANTED = { path: 'README.md' }
  const FRAGMENTS = ['{"path":', '"README.md"}']

  it('(a) start and deltas both carry an index — the shape Anthropic itself sends', async () => {
    const calls = await toolCallsOf([
      START_MESSAGE,
      blockStart('toolu_1', 'file_read', 0),
      jsonDelta(FRAGMENTS[0], 0),
      jsonDelta(FRAGMENTS[1], 0),
      STOP,
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('file_read')
    expect(calls[0].function.arguments).toEqual(WANTED)
  })

  it('(b) only the deltas carry one — the shape that used to go out with {}', async () => {
    const calls = await toolCallsOf([
      START_MESSAGE,
      blockStart('toolu_1', 'file_read'),
      jsonDelta(FRAGMENTS[0], 0),
      jsonDelta(FRAGMENTS[1], 0),
      STOP,
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('file_read')
    expect(calls[0].function.arguments).toEqual(WANTED)
  })

  it('(c) neither carries one — the shape the skip-guard silently dropped', async () => {
    const calls = await toolCallsOf([
      START_MESSAGE,
      blockStart('toolu_1', 'file_read'),
      jsonDelta(FRAGMENTS[0]),
      jsonDelta(FRAGMENTS[1]),
      STOP,
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('file_read')
    expect(calls[0].function.arguments).toEqual(WANTED)
  })

  it('never lets a tool call out with arguments the deltas could not reach', async () => {
    // Die Schadensform, unabhaengig von der Ursache: ein Aufruf mit leeren
    // Argumenten wird ausgefuehrt und scheitert am Tool, nicht am Provider.
    for (const startIndex of [0, undefined]) {
      for (const deltaIndex of [0, undefined]) {
        const calls = await toolCallsOf([
          blockStart('toolu_1', 'file_read', startIndex),
          jsonDelta('{"path":"README.md"}', deltaIndex),
          STOP,
        ])
        expect(
          calls.filter(c => Object.keys(c.function.arguments).length === 0),
          `start index ${startIndex}, delta index ${deltaIndex}`,
        ).toEqual([])
      }
    }
  })

  it('keeps two unindexed tool blocks apart by their ids', async () => {
    // Der Grund, warum die Regel den `id` liest und nicht einfach hochzaehlt:
    // ein zweiter Start oeffnet einen zweiten Slot, seine Fragmente landen
    // dort und nicht im ersten.
    const calls = await toolCallsOf([
      blockStart('toolu_1', 'file_read'),
      jsonDelta('{"path":"a.md"}'),
      blockStart('toolu_2', 'file_write'),
      jsonDelta('{"path":"b.md"}'),
      STOP,
    ])

    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.function.name)).toEqual(['file_read', 'file_write'])
    expect(calls.map(c => c.function.arguments)).toEqual([{ path: 'a.md' }, { path: 'b.md' }])
  })

  it('ends the turn cleanly and passes the rest of the stream through', async () => {
    const chunks = await chunksOf([
      START_MESSAGE,
      blockStart('toolu_1', 'file_read'),
      jsonDelta('{"path":"README.md"}', 0),
      STOP,
    ])

    const done = chunks.filter(c => c.done)
    expect(done).toHaveLength(1)
    expect(done[0].finishReason).toBe('stop')
    // Die uebrigen Felder kommen unveraendert durch — die Regel sitzt am
    // Tool-Block, nicht am Event.
    expect(done[0].promptEvalCount).toBe(11)
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
