/**
 * Bug B3, round 2 (2.6.7): the strict Jinja template, everything round 1
 * missed.
 *
 * Round 1 put one system message at the front and stopped there. The
 * counter-check then ran the shipped 2.6.7 build against a real strict
 * template (mlabonne_gemma-3-4b-it-abliterated, whose Jinja calls
 * raise_exception on every rule it checks) on the built-in engine, and killed
 * it three ways:
 *
 *   1. Agent mode with tools. After the first tool result the wire carried
 *      [system, user, assistant, tool] and NO `tools` field, because the run
 *      was on the prompt transport. The template has no branch for a `tool`
 *      role. HTTP 400, the round died.
 *   2. Plain chat. The chat tools are on by default, so an ordinary question
 *      that triggered web_search produced the same four roles and the same
 *      death, with Agent mode switched off.
 *   3. Group chat. From round two the history holds two assistant messages in
 *      a row, one per speaker, and the template demands strict alternation.
 *      Both speakers died.
 *
 * The same payloads run on Hermes 3 (plain ChatML, no raise_exception), which
 * is the proof that the shape is wrong for the template, not wrong in itself.
 *
 * `gemmaGate` below is a SIMULATION of that template's guard, extended from
 * round 1's `jinjaGate` with the two rules the counter-check tripped: no
 * `tool` role, and strict user/assistant alternation behind the system
 * message. It is not a real llama-server; a real-engine proof belongs to the
 * counter-check agent.
 *
 * Run: npx vitest run src/api/providers/__tests__/template-contract.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyTemplateContract } from '../normalize-system'
import { groupHistory, groupSystemPrompt } from '../../../lib/group-chat'
import { isTemplateRefusal, explainSendRefusal } from '../../../lib/template-refusal'
import type { Message } from '../../../types/chat'

// ── The guard Gemma 3 actually contains ────────────────────────

/**
 * Raises the way the shipped template does: a system message only at index 0,
 * every later turn either user or assistant, and those two strictly
 * alternating starting with user. Wording taken from the two templates the
 * bug was reported against.
 */
function gemmaGate(messages: { role: string; content?: unknown }[]): void {
  const lead = messages[0]?.role === 'system' ? 1 : 0
  const body = messages.slice(lead)
  if (body.some((m) => m.role === 'system')) {
    throw new Error('System message must be at the beginning')
  }
  body.forEach((m, i) => {
    const expected = i % 2 === 0 ? 'user' : 'assistant'
    if (m.role !== expected) {
      throw new Error('Conversation roles must alternate user/assistant/user/assistant/...')
    }
  })
}

const STRICT = { toolRole: 'text', alternate: true } as const
const TOLERANT = { toolRole: 'native', alternate: false } as const

// Weg 1 of the counter-check, copied from logs/wire-b3-12-agent-round2.json:
// the agent's own history after one approved file_write, on the prompt
// transport, with no `tools` field in the request.
const AGENT_AFTER_A_TOOL = [
  { role: 'system', content: 'You are a function calling AI model. <tools>...</tools>' },
  { role: 'user', content: 'Create a file called notes.txt containing the word hello, then read it back.' },
  {
    role: 'assistant',
    content: "Okay, let's start!",
    tool_calls: [{ id: 'call_1', function: { name: 'file_write', arguments: { path: 'notes.txt', content: 'hello' } } }],
  },
  { role: 'tool', content: 'File saved: C:\\Users\\ddrob\\agent-workspace\\notes.txt', tool_call_id: 'call_1' },
]

// ── 1. The contract itself ─────────────────────────────────────

describe('the template contract', () => {
  it('NEGATIVE CONTROL: the payload that killed the real engine trips the guard', () => {
    // Without this the rest proves nothing.
    expect(() => gemmaGate(AGENT_AFTER_A_TOOL)).toThrow('Conversation roles must alternate')
  })

  it('carries a tool result as a user turn when the template has no tool role', () => {
    const out = applyTemplateContract(AGENT_AFTER_A_TOOL, STRICT)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(out[3].role).toBe('user')
    expect(out[3].content).toContain('<tool_response>')
    expect(out[3].content).toContain('File saved')
    expect(() => gemmaGate(out)).not.toThrow()
  })

  it('and keeps the CALL with it, so the result is not an orphan', () => {
    // The counter-check found a tool result whose call had vanished from the
    // history. A result with no question in front of it is a mutilated
    // conversation even on a template that renders it.
    const out = applyTemplateContract(AGENT_AFTER_A_TOOL, STRICT)
    expect(out[2].role).toBe('assistant')
    expect(out[2].content).toContain("Okay, let's start!")
    expect(out[2].content).toContain('<tool_call>')
    expect(out[2].content).toContain('file_write')
    expect((out[2] as { tool_calls?: unknown }).tool_calls).toBeUndefined()
  })

  it('names the tool in the result even when the result carries no id', () => {
    const idless = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'x' } } }] },
      { role: 'tool', content: 'three results' },
    ]
    const out = applyTemplateContract(idless, STRICT)
    expect(out[3].content).toContain('web_search')
  })

  it('merges two turns of the same role instead of dropping one', () => {
    // Every consecutive pair in the wild is two things somebody said: a tool
    // result and the steer that follows it, or two speakers in a group.
    const out = applyTemplateContract(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a' },
      ],
      STRICT,
    )
    expect(out.map((m) => m.content)).toEqual(['s', 'first\n\nsecond', 'a'])
    expect(() => gemmaGate(out)).not.toThrow()
  })

  it('opens on a user turn even when the history starts with an assistant', () => {
    const out = applyTemplateContract(
      [
        { role: 'system', content: 's' },
        { role: 'assistant', content: 'I was here first' },
        { role: 'user', content: 'hi' },
      ],
      STRICT,
    )
    expect(out[1].role).toBe('user')
    expect(() => gemmaGate(out)).not.toThrow()
  })

  it('separates with a minimal turn when the contents cannot be merged', () => {
    // A user turn carrying images has no string content to join, so a bridge
    // is the only way to keep both turns AND the alternation.
    const withImages = [
      { role: 'user', content: 'look at this', images: [{ data: 'AAA', mimeType: 'image/png' }] },
      { role: 'user', content: 42 as unknown as string },
    ]
    const out = applyTemplateContract(withImages, STRICT)
    expect(out).toHaveLength(3)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(() => gemmaGate(out)).not.toThrow()
  })

  it('keeps images when it merges two user turns', () => {
    const out = applyTemplateContract(
      [
        { role: 'user', content: 'one', images: [{ data: 'AAA', mimeType: 'image/png' }] },
        { role: 'user', content: 'two', images: [{ data: 'BBB', mimeType: 'image/png' }] },
      ],
      STRICT,
    )
    expect(out).toHaveLength(1)
    expect(out[0].images).toEqual([
      { data: 'AAA', mimeType: 'image/png' },
      { data: 'BBB', mimeType: 'image/png' },
    ])
  })

  it('NEGATIVE CONTROL: on the tolerant contract the native tool channel is untouched', () => {
    // A cloud endpoint implements the protocol itself and needs the ids. This
    // is what must NOT be rewritten, or DeepInfra answers 422 on every turn.
    const out = applyTemplateContract(AGENT_AFTER_A_TOOL, TOLERANT)
    expect(out).toBe(AGENT_AFTER_A_TOOL)
    expect(out[3].role).toBe('tool')
    expect(out[2].tool_calls).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: a payload that already fits is returned BY REFERENCE', () => {
    // A new array every request is a new prompt prefix every request, which is
    // a cold upstream cache and a full re-bill.
    const fine = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]
    expect(applyTemplateContract(fine, STRICT)).toBe(fine)
  })

  it('NEGATIVE CONTROL: nothing but the tool channel and the order changes', () => {
    const out = applyTemplateContract(AGENT_AFTER_A_TOOL, STRICT)
    expect(out).toHaveLength(AGENT_AFTER_A_TOOL.length)
    expect(out[0]).toBe(AGENT_AFTER_A_TOOL[0])
    expect(out[1]).toBe(AGENT_AFTER_A_TOOL[1])
  })
})

// ── 2. Which endpoint gets which contract ──────────────────────

const backendMock = (capture: (url: string, init: any) => Response, opts?: { lan?: boolean }) => ({
  isTauri: () => false,
  localFetch: vi.fn(async (url: string, init: any) => capture(url, init)),
  localFetchStream: vi.fn(async (url: string, init: any) => capture(url, init)),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  backendCall: vi.fn(),
  isPrivateOrLanHost: () => opts?.lan !== false,
  // false so a cloud endpoint also goes through localFetch and can be captured
  isDirectFetchAllowed: () => false,
  hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(),
})

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

async function sendVia(
  config: { baseUrl: string; isLocal: boolean; managed?: boolean },
  tools: any[],
  lan: boolean,
): Promise<any> {
  vi.resetModules()
  let sent: any = null
  vi.doMock('../../backend', () =>
    backendMock((url, init) => {
      if (url.includes('/chat/completions')) {
        sent = JSON.parse(init.body)
        return okJson({ choices: [{ message: { content: 'ok' } }] })
      }
      return new Response('{}', { status: 404 })
    }, { lan }),
  )
  vi.doMock('../../builtin-ensure', () => ({
    ensureBuiltinEngineAlive: vi.fn(),
    explainDeadEngine: (e: unknown) => e,
    isManagedBuiltinSlot: () => config.managed === true,
  }))
  const { OpenAIProvider } = await import('../openai-provider')
  const p = new OpenAIProvider({
    id: 'openai', name: 'test', enabled: true, apiKey: '', ...config,
  } as any)
  await p.chatWithTools('m', AGENT_AFTER_A_TOOL as any, tools as any)
  return sent
}

afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.resetModules()
})

describe('the body that leaves for each kind of endpoint', () => {
  it('the built-in engine on the prompt transport gets the tolerant sequence', async () => {
    const sent = await sendVia(
      { baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true }, [], true,
    )
    expect(sent.tools).toBeUndefined()
    expect(sent.messages.some((m: any) => m.role === 'tool')).toBe(false)
    expect(() => gemmaGate(sent.messages)).not.toThrow()
  })

  it('LM Studio on the prompt transport gets it too', async () => {
    const sent = await sendVia(
      { baseUrl: 'http://localhost:1234/v1', isLocal: true }, [], true,
    )
    expect(sent.messages.some((m: any) => m.role === 'tool')).toBe(false)
    expect(() => gemmaGate(sent.messages)).not.toThrow()
  })

  it('a local engine that DID get a native tools payload keeps the tool role', async () => {
    // The strategy resolution only sends `tools` after this same server said
    // its template understands them (/props chat_template_caps, or the LM
    // Studio per-model listing). Rewriting then would throw away a working
    // channel for nothing.
    const sent = await sendVia(
      { baseUrl: 'http://localhost:1234/v1', isLocal: true },
      [{ type: 'function', function: { name: 'file_write', description: '', parameters: { type: 'object', properties: {}, required: [] } } }],
      true,
    )
    expect(sent.tools).toHaveLength(1)
    expect(sent.messages.some((m: any) => m.role === 'tool')).toBe(true)
    expect(sent.messages[2].tool_calls).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: a cloud endpoint is never rewritten', async () => {
    // DeepInfra (LU Cloud) validates the OpenAI tool shape strictly: the
    // assistant tool_calls and the matching tool_call_id must both survive.
    const sent = await sendVia(
      { baseUrl: 'https://api.example-cloud.com/v1', isLocal: false }, [], false,
    )
    expect(sent.messages.some((m: any) => m.role === 'tool')).toBe(true)
    expect(sent.messages[3].tool_call_id).toBe('call_1')
    expect(sent.messages[2].tool_calls[0].id).toBe('call_1')
  })

  it('Ollama chatStream, which never carries tools, gets the tolerant sequence', async () => {
    vi.resetModules()
    let sent: any = null
    vi.doMock('../../backend', () =>
      backendMock((_url, init) => {
        sent = JSON.parse(init.body)
        return new Response('{"message":{"content":"ok"},"done":true}\n')
      }),
    )
    const { OllamaProvider } = await import('../ollama-provider')
    const p = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
    })
    for await (const chunk of p.chatStream('gemma3:4b', AGENT_AFTER_A_TOOL as any)) { void chunk }
    expect(sent.messages.some((m: any) => m.role === 'tool')).toBe(false)
    expect(() => gemmaGate(sent.messages)).not.toThrow()
  })

  it('Ollama chatWithTools with a real tools payload keeps the tool role', async () => {
    vi.resetModules()
    let sent: any = null
    vi.doMock('../../backend', () =>
      backendMock((_url, init) => {
        sent = JSON.parse(init.body)
        return okJson({ message: { content: 'ok' } })
      }),
    )
    const { OllamaProvider } = await import('../ollama-provider')
    const p = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
    })
    await p.chatWithTools('qwen3:8b', AGENT_AFTER_A_TOOL as any, [
      { type: 'function', function: { name: 'file_write', description: '', parameters: { type: 'object', properties: {}, required: [] } } },
    ] as any)
    expect(sent.messages.some((m: any) => m.role === 'tool')).toBe(true)
  })
})

// ── 3. Group chat ──────────────────────────────────────────────

describe('a group round reaches every speaker as a legal conversation', () => {
  const msg = (o: Partial<Message>): Message => ({
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user', content: 'x', timestamp: 1, ...o,
  })

  // Round 2 of the counter-check's two-model group, from
  // logs/wire-b3-18-group.json.
  const history: Message[] = [
    msg({ role: 'user', content: 'Runde 1' }),
    msg({ role: 'assistant', content: 'round1', modelId: 'hermes' }),
    msg({ role: 'assistant', content: "I didn't return a visible answer that time.", modelId: 'gemma' }),
    msg({ role: 'user', content: 'Runde 2' }),
  ]

  const payloadFor = (model: string) => [
    { role: 'system', content: groupSystemPrompt(model, ['hermes', 'gemma'], '') },
    ...groupHistory(history, model),
  ]

  it('NEGATIVE CONTROL: two assistant turns in a row are what the template refuses', () => {
    expect(() =>
      gemmaGate([
        { role: 'system', content: 's' },
        { role: 'user', content: 'Runde 1' },
        { role: 'assistant', content: 'round1' },
        { role: 'assistant', content: '[gemma] ...' },
        { role: 'user', content: 'Runde 2' },
      ]),
    ).toThrow('Conversation roles must alternate')
  })

  it('the other speakers arrive as tagged user turns, own turns stay assistant', () => {
    const out = groupHistory(history, 'hermes')
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(out[1].content).toBe('round1')
    expect(out[2].content).toBe("[gemma] I didn't return a visible answer that time.")
  })

  it('and the whole round 2 payload passes the guard, for BOTH speakers', () => {
    for (const model of ['hermes', 'gemma']) {
      const out = applyTemplateContract(payloadFor(model), STRICT)
      expect(() => gemmaGate(out)).not.toThrow()
    }
  })

  it('round 1 no longer ends the second speaker prompt on a foreign assistant turn', () => {
    // The counter-check saw the second speaker asked to carry on straight
    // after another model's turn, and it answered with nothing at all.
    const roundOne = [history[0], history[1]]
    const out = applyTemplateContract(
      [
        { role: 'system', content: groupSystemPrompt('gemma', ['hermes', 'gemma'], '') },
        ...groupHistory(roundOne, 'gemma'),
      ],
      STRICT,
    )
    expect(out[out.length - 1].role).toBe('user')
    expect(() => gemmaGate(out)).not.toThrow()
  })

  it('the system prompt tells the model where the other voices are', () => {
    const p = groupSystemPrompt('hermes', ['hermes', 'gemma'], '')
    expect(p).toContain('user messages that start with a [model-name] tag')
  })
})

// ── 4. The tool_call that vanished from the history ────────────

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

describe('a stored tool call survives the rebuild of the history', () => {
  // The store persists tool_calls and tool_call_id (types/chat.ts says so, and
  // says why). Both payload builders rebuilt the history without them, so from
  // the second user message on, the model saw a tool result with no call in
  // front of it. Guarded at the source: the rebuild lives inside a hook with
  // no test harness, and what matters is the field list.
  it('the agent payload builder carries both fields through', () => {
    const agent = src('hooks/useAgentChat.ts')
    expect(agent).toContain("...(m.tool_calls?.length ? { tool_calls: m.tool_calls as unknown as ChatMessage['tool_calls'] } : {}),")
    expect(agent).toContain('...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),')
  })

  it('the plain chat payload builder carries both fields through', () => {
    const chat = src('hooks/useChat.ts')
    expect(chat).toContain('...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),')
    expect(chat).toContain('...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),')
  })

  it('the prompt-transport send no longer strips the message down to role and content', () => {
    const agent = src('hooks/useAgentChat.ts')
    expect(agent).not.toContain('sendMessages.map(m => ({ role: m.role, content: m.content }))')
  })

  it('the coding agent writes it for the transport too', () => {
    const codex = src('hooks/useCodex.ts')
    const transport = codex.indexOf("if (strategy === 'hermes_xml') {")
    const byProvider = codex.indexOf("} else if (providerId === 'openai' || providerId === 'anthropic' || providerId === 'lu-cloud') {")
    expect(transport).toBeGreaterThan(-1)
    expect(byProvider).toBeGreaterThan(-1)
    expect(transport).toBeLessThan(byProvider)
  })

  it('the tool result is written for the TRANSPORT, not for the provider name', () => {
    // The built-in engine and LM Studio are providerId 'openai', so the
    // provider-first branch wrote native `tool` messages for a run that was
    // driving the model by prompt. That is the payload the engine died on.
    const agent = src('hooks/useAgentChat.ts')
    const transport = agent.indexOf("if (strategy === 'hermes_xml') {")
    const byProvider = agent.indexOf("} else if (providerId === 'openai' || providerId === 'anthropic' || providerId === 'lu-cloud') {")
    expect(transport).toBeGreaterThan(-1)
    expect(byProvider).toBeGreaterThan(-1)
    expect(transport).toBeLessThan(byProvider)
  })
})

// ── 5. What the user reads when a template refuses anyway ──────

describe('a template refusal says what happened, in English', () => {
  const gemmaError = Object.assign(
    new Error(
      'Unable to generate parser for this template. Automatic parser generation failed: ' +
      'While executing CallExpression at line 19, column 27 in source: ... ' +
      'Error: Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/...',
    ),
    { status: 400 },
  )

  it('recognises the template wordings', () => {
    expect(isTemplateRefusal(gemmaError)).toBe(true)
    expect(isTemplateRefusal(new Error('System message must be at the beginning'))).toBe(true)
  })

  it('NEGATIVE CONTROL: an ordinary failure is not dressed up as a template problem', () => {
    expect(isTemplateRefusal(new Error('Connection failed'))).toBe(false)
    expect(explainSendRefusal(new Error('Connection failed'))).toBeNull()
    expect(explainSendRefusal(Object.assign(new Error('too many requests'), { status: 429 }))).toBeNull()
  })

  it('the sentence is ours and the raw text is kept underneath it', () => {
    const out = explainSendRefusal(gemmaError)!
    expect(out).toContain("chat template refused the conversation")
    expect(out).toContain('Jinja Exception')
    expect(out.startsWith('Unable to generate parser')).toBe(false)
  })

  it('a bare 400 gets its own sentence rather than the raw body', () => {
    const out = explainSendRefusal(Object.assign(new Error('invalid request'), { status: 400 }))!
    expect(out).toContain('refused the request before generating anything')
  })

  it('no dashes anywhere in the user-facing text', () => {
    const text = readFileSync(join(process.cwd(), 'src/lib/template-refusal.ts'), 'utf8')
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })

  it('the agent judges it BEFORE it falls back to "Agent error"', () => {
    // Plain chat routes its tool turns through the agent executor, so the
    // template's Jinja trace used to reach a user who never touched Agent
    // mode under the heading "Agent error".
    const agent = src('hooks/useAgentChat.ts')
    const branch = agent.indexOf('} else if (sendRefusal) {')
    const generic = agent.indexOf("'\\n\\nAgent error: ' + errorMsg")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(generic)
  })

  it('plain chat and the group round say it too', () => {
    const chat = src('hooks/useChat.ts')
    expect(chat).toContain('} else if (sendRefusal) {')
    expect(chat).toContain('refusal ?? `Error from ${model}:')
  })
})
