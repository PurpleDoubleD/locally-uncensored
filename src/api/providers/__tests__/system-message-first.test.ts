/**
 * Bug B3 (2.6.7): "System message must be at the beginning".
 *
 * Discord #bug-reports, 2026-08-21. helpslowlydying diagnosed it: "the system
 * instructions or tools are being injected in the wrong order, causing the
 * Jinja template engine to crash with System message must be at the
 * beginning". platorius, who was hitting it: "the problem is only in LU",
 * with the same model and the same prompts working in other frontends.
 *
 * The local engines (bundled llama-server, LM Studio, llama.cpp, Ollama)
 * render the model's OWN Jinja chat template, and the strict ones raise on a
 * system message anywhere but index 0, and several also raise on a second
 * system message. The request dies before the model sees it, so the turn
 * produces nothing at all.
 *
 * 2.6.6 fixed one producer (the compaction trim notice, proven in
 * lib/__tests__/compaction-system-position.test.ts). This file covers the
 * central guarantee instead of one producer: whatever the dozen builders in
 * the app hand over, the array that reaches the wire has at most one system
 * message and it is first.
 *
 * `jinjaGate` below is a SIMULATION of the template guard, not a real
 * llama-server. It reproduces the two conditions the shipped Qwen, Mistral and
 * ChatML templates check, so a payload that passes it here is a payload those
 * templates render. A real-engine proof belongs to the counter-check agent.
 *
 * Run: npx vitest run src/api/providers/__tests__/system-message-first.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeSystemMessages } from '../normalize-system'
import { groupHistory } from '../../../lib/group-chat'
import type { Message } from '../../../types/chat'
import type { ChatMessage } from '../types'
import type { OpenAIChatRequest } from '../openai-provider'
import type { OllamaChatRequest } from '../ollama-provider'

/** The init shape both backend helpers are called with in this file. */
type CapturedInit = { method?: string; headers?: Record<string, string>; body?: string }

/** Read a captured body as the request type the provider builds, so a renamed
 *  field breaks these assertions instead of turning them into undefined. */
function captured<T>(init: CapturedInit): T {
  if (typeof init.body !== 'string') throw new Error('capture had no JSON body')
  return JSON.parse(init.body) as T
}

// ── The guard the shipped chat templates actually contain ──────

/** Throws the template's own wording when the payload breaks its contract. */
function jinjaGate(messages: { role: string }[]): void {
  const systems = messages.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0)
  if (systems.length > 1 || (systems.length === 1 && systems[0] !== 0)) {
    throw new Error('System message must be at the beginning')
  }
}

// The history the reporter had: an agent turn with tools, and a second system
// block injected behind the first user message. This is what dies today.
const CRASHING_HISTORY: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful agent.' },
  { role: 'user', content: 'List the files in my project.' },
  { role: 'system', content: 'Available tools: file_list, file_read.' },
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_list', arguments: {} } }] },
  { role: 'tool', content: 'src, docs, README.md' },
  { role: 'user', content: 'And now read the README.' },
]

// ── Unit: the normalizer itself ────────────────────────────────

describe('normalizeSystemMessages', () => {
  it('pulls a mid-conversation system block to the front and merges it', () => {
    const out = normalizeSystemMessages(CRASHING_HISTORY)
    expect(out.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(out[0].role).toBe('system')
    expect(() => jinjaGate(out)).not.toThrow()
  })

  it('keeps every instruction, in the order the builders put them', () => {
    const out = normalizeSystemMessages(CRASHING_HISTORY)
    expect(out[0].content).toBe(
      'You are a helpful agent.\n\nAvailable tools: file_list, file_read.',
    )
  })

  it('drops nothing else and moves nothing else', () => {
    const out = normalizeSystemMessages(CRASHING_HISTORY)
    expect(out.slice(1)).toEqual(CRASHING_HISTORY.filter((m) => m.role !== 'system'))
  })

  it('two system messages at the front become one', () => {
    const out = normalizeSystemMessages([
      { role: 'system', content: 'tool catalog' },
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
    ])
    expect(out).toEqual([
      { role: 'system', content: 'tool catalog\n\npersona' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('an empty stray system message is removed, not merged as blank text', () => {
    const out = normalizeSystemMessages([
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: '   ' },
    ])
    expect(out).toEqual([
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('a payload whose ONLY system parts are empty loses the system message entirely', () => {
    const out = normalizeSystemMessages([
      { role: 'user', content: 'hi' },
      { role: 'system', content: '' },
    ])
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('fields other than content survive the merge', () => {
    const out = normalizeSystemMessages([
      { role: 'system', content: 'a', marker: 1 } as { role: string; content: string; marker: number },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'b' } as { role: string; content: string; marker?: number },
    ])
    expect(out[0]).toEqual({ role: 'system', content: 'a\n\nb', marker: 1 })
  })

  it('NEGATIVE CONTROL: a correct payload is returned BY REFERENCE, untouched', () => {
    // A new array on every request would be a new prompt prefix on every
    // request, which is a cold upstream cache and a full re-bill.
    const fine = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(normalizeSystemMessages(fine)).toBe(fine)
  })

  it('NEGATIVE CONTROL: a payload with no system message at all is returned by reference', () => {
    const none = [{ role: 'user', content: 'hi' }]
    expect(normalizeSystemMessages(none)).toBe(none)
  })

  it('NEGATIVE CONTROL: the raw history trips the template guard', () => {
    // Without this the tests above prove nothing: they would pass on a payload
    // that was never broken in the first place.
    expect(() => jinjaGate(CRASHING_HISTORY)).toThrow('System message must be at the beginning')
  })
})

// ── The wire: what the local engines actually receive ──────────

const backendMock = (capture: (url: string, init: CapturedInit) => Response) => ({
  isTauri: () => false,
  localFetch: vi.fn(async (url: string, init: CapturedInit) => capture(url, init)),
  localFetchStream: vi.fn(async (url: string, init: CapturedInit) => capture(url, init)),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  backendCall: vi.fn(),
  isPrivateOrLanHost: () => true,
  isDirectFetchAllowed: () => true,
  hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(),
})

afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.resetModules()
})

describe('the body that leaves for a local engine', () => {
  it('Ollama chatStream sends one system message, first', async () => {
    vi.resetModules()
    // An array, not a `let`: a push keeps the captured body's real type
    // instead of letting control-flow analysis collapse it to `never`.
    const captures: OllamaChatRequest[] = []
    vi.doMock('../../backend', () =>
      backendMock((_url, init) => {
        captures.push(captured<OllamaChatRequest>(init))
        return new Response('{"message":{"content":"ok"},"done":true}\n')
      }),
    )
    const { OllamaProvider } = await import('../ollama-provider')
    const p = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
    })
    for await (const chunk of p.chatStream('qwen3:8b', CRASHING_HISTORY)) { void chunk }
    expect(captures).toHaveLength(1)
    const sent = captures[0]
    expect(sent.messages.filter(m => m.role === 'system')).toHaveLength(1)
    expect(sent.messages[0].role).toBe('system')
    expect(() => jinjaGate(sent.messages)).not.toThrow()
  })

  it('Ollama chatWithTools sends one system message, first', async () => {
    vi.resetModules()
    const captures: OllamaChatRequest[] = []
    vi.doMock('../../backend', () =>
      backendMock((_url, init) => {
        captures.push(captured<OllamaChatRequest>(init))
        return new Response(JSON.stringify({ message: { content: 'ok' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    const { OllamaProvider } = await import('../ollama-provider')
    const p = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
    })
    await p.chatWithTools('qwen3:8b', CRASHING_HISTORY, [])
    expect(captures).toHaveLength(1)
    const sent = captures[0]
    expect(() => jinjaGate(sent.messages)).not.toThrow()
    expect(sent.messages[0].content).toContain('Available tools: file_list, file_read.')
  })

  it('the built-in engine (OpenAI-compatible) gets one system message, first', async () => {
    vi.resetModules()
    const captures: OpenAIChatRequest[] = []
    vi.doMock('../../backend', () =>
      backendMock((url, init) => {
        if (url.includes('/chat/completions')) {
          captures.push(captured<OpenAIChatRequest>(init))
          return new Response(
            JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
            { headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('{}', { status: 404 })
      }),
    )
    vi.doMock('../../builtin-ensure', () => ({
      ensureBuiltinEngineAlive: vi.fn(),
      explainDeadEngine: (e: unknown) => e,
      isManagedBuiltinSlot: () => true,
    }))
    const { OpenAIProvider } = await import('../openai-provider')
    const p = new OpenAIProvider({
      id: 'openai', name: 'Built-in Engine', enabled: true,
      baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true,
    })
    await p.chatWithTools('qwen3-8b', CRASHING_HISTORY, [])
    expect(captures).toHaveLength(1)
    const sent = captures[0]
    expect(sent.messages.filter(m => m.role === 'system')).toHaveLength(1)
    expect(sent.messages[0].role).toBe('system')
    expect(() => jinjaGate(sent.messages)).not.toThrow()
  })
})

// ── The producer this fix also closes at the source ────────────

describe('a stored app notice never becomes a chat turn', () => {
  const stored = [
    { id: '1', role: 'user', content: 'hi', timestamp: 1 },
    { id: '2', role: 'assistant', content: 'hello', timestamp: 2 },
    // What staged-apply.ts writes into the conversation. MessageList hides it,
    // useCodex and useAgentChat drop it, and plain chat used to send it.
    { id: '3', role: 'system', content: 'Applied staged change: src/a.ts', timestamp: 3, notice: 'info' },
    { id: '4', role: 'user', content: 'and now?', timestamp: 4 },
  ] as unknown as Message[]

  it('groupHistory drops it instead of putting it mid conversation', () => {
    const out = groupHistory(stored, 'qwen3:8b')
    expect(out.some((m) => m.role === 'system')).toBe(false)
    expect(out.map((m) => m.content)).toEqual(['hi', 'hello', 'and now?'])
  })

  it('and the group payload as a whole passes the template guard', () => {
    const payload = [
      { role: 'system', content: 'group prompt' },
      ...groupHistory(stored, 'qwen3:8b'),
    ]
    expect(() => jinjaGate(payload)).not.toThrow()
  })
})
