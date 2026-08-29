/**
 * The Think button has to reach the built-in engine.
 *
 * David, 2026-08-29: thinking was switched on, the model plainly did not
 * think, and no thinking block ever appeared. The audit found nothing on the
 * wire that asks for it. `reasoning_effort` is an OpenAI-API concept; a server
 * that renders the MODEL'S OWN Jinja template has no reasoning mode of its
 * own, the switch is the `enable_thinking` variable inside the template and it
 * is reached through `chat_template_kwargs`.
 *
 * Counter-check against the real bundled binary (lu-llama-server b1-049326a,
 * Mac, 2026-08-29), using a chat template that prints the branch it took and
 * llama-server's own /apply-template endpoint:
 *
 *   reasoning_effort: 'high'                       -> MARKER_THINK_OFF
 *   chat_template_kwargs: {enable_thinking:true}   -> MARKER_THINK_ON
 *   chat_template_kwargs: {enable_thinking:false}  -> MARKER_THINK_OFF
 *
 * and a /v1/chat/completions carrying reasoning_effort answered 200, so the
 * existing walk-down ladder never engaged and nothing ever complained. The
 * same kwarg against the model's OWN template (Qwen 2.5, which never reads
 * the variable) rendered a byte-identical prompt, so sending it is free where
 * it is not used.
 *
 * Run: npx vitest run src/api/providers/__tests__/openai-template-thinking.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

let sent: { url: string; body: Record<string, any> }[]
/** Status the fake server answers with, one entry per request in order. */
let statuses: number[]

function answer(url: string, init: any) {
  const body = JSON.parse(init.body as string)
  sent.push({ url, body })
  const status = statuses.shift() ?? 200
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { message: 'unknown field' } }), { status })
  }
  if (body.stream) return new Response(streamBody, { status: 200 })
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
}

async function makeProvider(config: Record<string, unknown>) {
  vi.resetModules()
  sent = []
  statuses = []
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async (url: string, init: any) => answer(url, init)),
    localFetchStream: vi.fn(async (url: string, init: any) => answer(url, init)),
    backendCall: vi.fn(),
    isPrivateOrLanHost: (host: string) => host === 'localhost' || host === '127.0.0.1',
    isDirectFetchAllowed: () => true,
    hostnameOf: (url: string) => new URL(url).hostname,
    ensureProxyAllowsHost: vi.fn(),
    isTauri: () => false,
  }))
  vi.doMock('../../builtin-ensure', () => ({
    ensureBuiltinEngineAlive: vi.fn(),
    explainDeadEngine: (e: unknown) => e,
    explainEngineTransportMessage: (m: string) => m,
    isManagedBuiltinSlot: () => false,
  }))
  const mod = await import('../openai-provider')
  return new mod.OpenAIProvider(config as any)
}

const BUILTIN = {
  id: 'openai', name: 'Built-in Engine', apiKey: '', enabled: true,
  baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true,
}
const CLOUD = {
  id: 'openai', name: 'OpenAI', apiKey: 'sk-test', enabled: true,
  baseUrl: 'https://api.openai.com/v1', isLocal: false,
}

async function drain(gen: AsyncGenerator<any>) {
  for await (const _ of gen) { /* the fetch only fires on the first next() */ }
}

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(((url: any, init: any) => answer(String(url), init)) as any) })
afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('the built-in engine is told to think', () => {
  it('Thinking ON puts enable_thinking:true on the wire', async () => {
    const p = await makeProvider(BUILTIN)
    await drain(p.chatStream('kw-on', [{ role: 'user', content: 'hi' }], { thinking: true }))
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it('Thinking OFF puts enable_thinking:false on the wire', async () => {
    const p = await makeProvider(BUILTIN)
    await drain(p.chatStream('kw-off', [{ role: 'user', content: 'hi' }], { thinking: false }))
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('the tool turn carries it too, not just plain chat', async () => {
    const p = await makeProvider(BUILTIN)
    await p.chatWithTools('kw-tools', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it('reasoning_effort still rides along, so a template-less local server keeps working', async () => {
    const p = await makeProvider(BUILTIN)
    await drain(p.chatStream('kw-both', [{ role: 'user', content: 'hi' }], { thinking: true }))
    expect(sent[0].body.reasoning_effort).toBe('high')
  })
})

describe('negative control: nobody else gets the field', () => {
  it('a model with no declared think capability sends no kwargs at all', async () => {
    const p = await makeProvider(BUILTIN)
    await drain(p.chatStream('kw-undef', [{ role: 'user', content: 'hi' }], {}))
    expect('chat_template_kwargs' in sent[0].body).toBe(false)
  })

  it('a cloud endpoint never sees it, it refuses unknown body fields', async () => {
    const p = await makeProvider(CLOUD)
    await drain(p.chatStream('kw-cloud', [{ role: 'user', content: 'hi' }], { thinking: true }))
    expect('chat_template_kwargs' in sent[0].body).toBe(false)
    expect(sent[0].body.reasoning_effort).toBe('high')
  })
})

describe('a local server that refuses the field is not mistaken for one that cannot think', () => {
  it('the field is dropped on 400 and the thinking knob survives', async () => {
    const p = await makeProvider({ ...BUILTIN, baseUrl: 'http://127.0.0.1:8129/v1' })
    statuses = [400, 200]
    await drain(p.chatStream('kw-refused', [{ role: 'user', content: 'hi' }], { thinking: true }))
    expect(sent).toHaveLength(2)
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect('chat_template_kwargs' in sent[1].body).toBe(false)
    expect(sent[1].body.reasoning_effort).toBe('high')
  })

  it('and the refusal is remembered, so the next message pays one request', async () => {
    const p = await makeProvider({ ...BUILTIN, baseUrl: 'http://127.0.0.1:8130/v1' })
    statuses = [400, 200]
    await drain(p.chatStream('kw-mem', [{ role: 'user', content: 'hi' }], { thinking: true }))
    sent = []
    await drain(p.chatStream('kw-mem', [{ role: 'user', content: 'again' }], { thinking: true }))
    expect(sent).toHaveLength(1)
    expect(sent[0].body.reasoning_effort).toBe('high')
    expect('chat_template_kwargs' in sent[0].body).toBe(false)
  })
})
