/**
 * Ein Tool-Call traegt seine `arguments` als JSON-TEXT ueber die Leitung, und
 * geschrieben hat den Text ein Sprachmodell. `JSON.parse` liefert darum nicht
 * zwingend ein Objekt: `"null"`, `"42"` und `"[1,2]"` sind alle gueltiges JSON
 * und alle drei kein `Record<string, …>`.
 *
 * Vor 0e740f60 prueften beide Provider das nur im REPARATURZWEIG. Der
 * Erfolgszweig gab zurueck, was `JSON.parse` produziert hatte, unter einer
 * `Record<string, any>`-Annotation:
 *
 *   openai-provider.safeParseArgs     `try { return JSON.parse(args) }`
 *   anthropic-provider.flushToolUseBlocks  `try { args = JSON.parse(…) }`
 *
 * `null` ging damit an jedes nachgelagerte `args.foo` (TypeError im
 * Tool-Dispatcher, nicht im Provider — also weit weg von der Ursache), und
 * `42` an einen Aufruf, der Schluessel erwartet.
 *
 * Beide Faelle werden hier ueber einen ECHTEN Provider-Aufruf mit gemocktem
 * `fetch` gefahren, nicht ueber die private Methode: was der Provider nach
 * aussen gibt, ist das, was der Tool-Loop bekommt.
 *
 * Run: npx vitest run src/api/providers/__tests__/tool-arguments-stay-objects.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import { AnthropicProvider } from '../anthropic-provider'
import type { ProviderConfig, ChatStreamChunk, ToolCall } from '../types'

// api.openai.com und api.anthropic.com stehen beide auf der gepinnten
// CSP-Liste, also nimmt der Provider den direkten `fetch` — genau den, den
// `vi.stubGlobal` hier ersetzt. Ein Fantasie-Host wuerde ueber localFetch
// laufen und das Setup vom `window`-Stub abhaengig machen.
function openAIConfig(): ProviderConfig {
  return {
    id: 'openai', name: 'OpenAI', enabled: true,
    baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', isLocal: false,
  }
}

function anthropicConfig(): ProviderConfig {
  return {
    id: 'anthropic', name: 'Anthropic', enabled: true,
    baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', isLocal: false,
  }
}

/** Eine nicht-streamende OpenAI-Antwort mit genau einem Tool-Call. */
function openAIToolCallResponse(args: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: '',
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'file_read', arguments: args },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }), { status: 200 })
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

/** Der eine Tool-Call, oder ein lautes Scheitern — `[0]` auf einer leeren
 *  Liste wuerde die Assertion sonst in `undefined` aufloesen. */
function onlyCall(calls: ToolCall[]): ToolCall {
  if (calls.length !== 1) {
    throw new Error(`erwartet: genau ein Tool-Call, bekommen: ${calls.length}`)
  }
  return calls[0]
}

/**
 * Die Behauptung, die der alte Erfolgszweig gebrochen hat: was rauskommt, ist
 * indizierbar. `Object.keys(null)` wirft, `Object.keys(42)` nicht — deshalb
 * steht die Typpruefung daneben und nicht nur der `toEqual`-Vergleich.
 */
function expectPlainObject(args: Record<string, unknown>): void {
  expect(args).not.toBeNull()
  expect(typeof args).toBe('object')
  expect(Array.isArray(args)).toBe(false)
  expect(() => Object.keys(args)).not.toThrow()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('openai-provider hands on an object even when the model sent none', () => {
  it('turns a "null" arguments payload into an empty object, not into null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIToolCallResponse('null')))

    const result = await new OpenAIProvider(openAIConfig())
      .chatWithTools('gpt-4o', [{ role: 'user', content: 'read it' }], [])

    const args = onlyCall(result.toolCalls).function.arguments
    expectPlainObject(args)
    expect(args).toEqual({})
  })

  it('turns a "42" arguments payload into an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIToolCallResponse('42')))

    const result = await new OpenAIProvider(openAIConfig())
      .chatWithTools('gpt-4o', [{ role: 'user', content: 'read it' }], [])

    const args = onlyCall(result.toolCalls).function.arguments
    expectPlainObject(args)
    expect(args).toEqual({})
  })

  // `typeof [] === 'object'`: der erste Anlauf des Fixes pruefte genau das und
  // liess ein Array durch — der Fall, den sein eigener Kommentar als abgedeckt
  // benannte. `isRecord` weist Arrays und `null` ab.
  it('turns a "[1,2]" arguments payload into an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openAIToolCallResponse('[1,2]')))

    const result = await new OpenAIProvider(openAIConfig())
      .chatWithTools('gpt-4o', [{ role: 'user', content: 'read it' }], [])

    const args = onlyCall(result.toolCalls).function.arguments
    expectPlainObject(args)
    expect(args).toEqual({})
  })

  it('still passes a real object through untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openAIToolCallResponse('{"path":"README.md"}'),
    ))

    const result = await new OpenAIProvider(openAIConfig())
      .chatWithTools('gpt-4o', [{ role: 'user', content: 'read it' }], [])

    expect(onlyCall(result.toolCalls).function.arguments).toEqual({ path: 'README.md' })
  })

  // Der Streaming-Pfad sammelt `arguments` erst aus Fragmenten zusammen und
  // schickt das Ergebnis durch dieselbe Methode — dieselbe Pruefung muss dort
  // greifen, sonst haengt sie an der zufaellig gewaehlten Transportart.
  it('applies the same check to the streamed tool-call accumulator', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"file_read","arguments":"nu"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ll"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200 })))

    const chunks = await drain(new OpenAIProvider(openAIConfig())
      .chatStream('gpt-4o', [{ role: 'user', content: 'read it' }], {
        tools: [{
          type: 'function',
          function: {
            name: 'file_read', description: 'read',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        }],
      }))

    const args = onlyCall(chunks.flatMap(c => c.toolCalls ?? [])).function.arguments
    expectPlainObject(args)
    expect(args).toEqual({})
  })
})

describe('anthropic-provider hands on an object even when the model sent none', () => {
  // `input_json_delta` kommt in Fragmenten. Hier buchstabieren die Fragmente
  // zusammen `null` — gueltiges JSON, aber kein Objekt.
  it('turns tool input that decodes to null into an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"file_read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"nu"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ll"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])))

    const chunks = await drain(new AnthropicProvider(anthropicConfig())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))

    const call = onlyCall(chunks.flatMap(c => c.toolCalls ?? []))
    expect(call.function.name).toBe('file_read')
    expectPlainObject(call.function.arguments)
    expect(call.function.arguments).toEqual({})
  })

  it('turns tool input that decodes to a number into an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"file_read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"42"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])))

    const chunks = await drain(new AnthropicProvider(anthropicConfig())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))

    const args = onlyCall(chunks.flatMap(c => c.toolCalls ?? [])).function.arguments
    expectPlainObject(args)
    expect(args).toEqual({})
  })

  it('turns tool input that decodes to an array into an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"file_read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"[1,2]"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])))

    const chunks = await drain(new AnthropicProvider(anthropicConfig())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))

    const args = onlyCall(chunks.flatMap(c => c.toolCalls ?? [])).function.arguments
    expectPlainObject(args)
    expect(args).toEqual({})
  })

  it('still assembles a real object out of its fragments', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"file_read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"README.md\\"}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])))

    const chunks = await drain(new AnthropicProvider(anthropicConfig())
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'read it' }]))

    expect(onlyCall(chunks.flatMap(c => c.toolCalls ?? [])).function.arguments)
      .toEqual({ path: 'README.md' })
  })
})
