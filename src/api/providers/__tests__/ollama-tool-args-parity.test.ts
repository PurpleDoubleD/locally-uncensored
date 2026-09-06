/**
 * Ollamas zwei Tool-Pfade muessen aus derselben Antwort dasselbe machen.
 *
 * `chatWithTools` (nicht streamend) schickt `tc.function.arguments` seit
 * jeher durch `repairToolCallArgs`. `chatStream` tat das nicht: es reichte
 * den Wert roh durch, unter der Annotation `Record<string, any>`. Auf dieser
 * Route antwortet aber nicht nur Ollama selbst — llama.cpp-basierte und
 * vorgeschaltete Server schicken `arguments` als JSON-STRING, und ein Modell
 * schickt auch mal ein Objekt mit Schleppkomma. Der eine Pfad reparierte das,
 * der andere gab die Zeichenkette an den Tool-Dispatcher weiter.
 *
 * Deshalb ist das hier EIN Paritaetstest und nicht zwei Einzeltests: die
 * Aussage ist nicht "chatStream repariert", sondern "welchen der beiden Wege
 * ein Turn nimmt, darf am Ergebnis nichts aendern". Die Erwartung wird nicht
 * hingeschrieben, sondern aus dem etablierten Pfad GEHOLT und mit dem anderen
 * verglichen — waere `repairToolCallArgs` eines Tages etwas anderes, zoege der
 * Test mit, ohne die Paritaet aufzugeben.
 *
 * Run: npx vitest run src/api/providers/__tests__/ollama-tool-args-parity.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderConfig, ToolCall, ToolDefinition } from '../types'

vi.mock('../../backend', () => ({
  isTauri: () => false,
  localFetch: vi.fn(),
  localFetchStream: vi.fn(),
  ollamaUrl: (path: string) => `/api${path}`,
}))

import { OllamaProvider } from '../ollama-provider'
import { localFetch, localFetchStream } from '../../backend'

const mockLocalFetch = localFetch as ReturnType<typeof vi.fn>
const mockLocalFetchStream = localFetchStream as ReturnType<typeof vi.fn>

const config: ProviderConfig = {
  id: 'ollama', name: 'Ollama', enabled: true,
  baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
}

const TOOLS: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'file_read',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] },
  },
}]

/** Der eine Tool-Call, oder ein lautes Scheitern statt eines `undefined`,
 *  das sich anschliessend mit einem zweiten `undefined` vergleichen liesse. */
function onlyCall(calls: ToolCall[], path: string): ToolCall {
  if (calls.length !== 1) {
    throw new Error(`${path}: erwartet genau ein Tool-Call, bekommen ${calls.length}`)
  }
  return calls[0]
}

/** Was der STREAMENDE Pfad aus diesem `arguments`-Wert macht. */
async function throughChatStream(rawArguments: unknown): Promise<ToolCall> {
  mockLocalFetchStream.mockResolvedValueOnce(new Response(
    JSON.stringify({
      message: { content: '', tool_calls: [{ function: { name: 'file_read', arguments: rawArguments } }] },
      done: false,
    }) + '\n' +
    JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }) + '\n',
    { status: 200 },
  ))

  const calls: ToolCall[] = []
  for await (const chunk of new OllamaProvider(config)
    .chatStream('qwen2.5-coder:14b', [{ role: 'user', content: 'read it' }])) {
    if (chunk.toolCalls) calls.push(...chunk.toolCalls)
  }
  return onlyCall(calls, 'chatStream')
}

/** Was der NICHT-streamende Pfad aus demselben Wert macht. */
async function throughChatWithTools(rawArguments: unknown): Promise<ToolCall> {
  mockLocalFetch.mockResolvedValueOnce(new Response(JSON.stringify({
    message: { content: '', tool_calls: [{ function: { name: 'file_read', arguments: rawArguments } }] },
    done: true,
  }), { status: 200 }))

  const result = await new OllamaProvider(config)
    .chatWithTools('qwen2.5-coder:14b', [{ role: 'user', content: 'read it' }], TOOLS)
  return onlyCall(result.toolCalls, 'chatWithTools')
}

/**
 * Die eigentliche Aussage: ein und derselbe Wert, beide Pfade, ein Ergebnis.
 * Der Vergleich laeuft ueber `toEqual`, damit ein String und ein Objekt mit
 * demselben Text NICHT als gleich durchgehen.
 */
async function bothPathsAgree(rawArguments: unknown): Promise<Record<string, unknown>> {
  const streamed = await throughChatStream(rawArguments)
  const direct = await throughChatWithTools(rawArguments)

  expect(streamed.function.name).toBe(direct.function.name)
  expect(streamed.function.arguments).toEqual(direct.function.arguments)
  return direct.function.arguments
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the streaming and the non-streaming Ollama tool path agree', () => {
  it('agrees on arguments that arrived as a JSON string instead of an object', async () => {
    const args = await bothPathsAgree('{"path":"notes.md"}')
    // Und zwar auf dem geparsten Objekt — nicht darauf, dass beide dieselbe
    // Zeichenkette durchreichen. Ohne diese Zeile bestuende der Test auch,
    // wenn BEIDE Pfade kaputt waeren.
    expect(args).toEqual({ path: 'notes.md' })
  })

  it('agrees on a JSON string a small model left a trailing comma in', async () => {
    const args = await bothPathsAgree('{"path": "notes.md",}')
    expect(args).toEqual({ path: 'notes.md' })
  })

  it('agrees on a single-quoted blob, the other shape repairJson exists for', async () => {
    const args = await bothPathsAgree("{'path': 'notes.md'}")
    expect(args).toEqual({ path: 'notes.md' })
  })

  it('agrees on a string that is not repairable at all', async () => {
    const args = await bothPathsAgree('not-json-at-all')
    expect(args).toEqual({})
  })

  it('agrees on a proper object, and leaves it untouched on both paths', async () => {
    const args = await bothPathsAgree({ path: 'notes.md' })
    expect(args).toEqual({ path: 'notes.md' })
  })
})
