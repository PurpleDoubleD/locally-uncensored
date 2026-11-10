/**
 * 3.0.11: a chat template with rungs of its own (bug report on 3.0.10).
 *
 * Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ2_M on the LU Engine: every
 * message died with
 *
 *   Jinja Exception: Unexpected reasoning effort high. Supported types are
 *   xhigh (default), medium, and low.
 *
 * LU offers Low, Medium and High for every engine model, and b11960 (pin
 * since 3.0.9) hands the template both `chat_template_kwargs` and a top-level
 * `reasoning_effort`. The fix reads the rungs the template renders from
 * /props (`chat_template_caps.reasoning_effort_levels`, llama.cpp
 * common/jinja/caps.cpp) and fits every rung onto them before the send.
 *
 * The fake engine below behaves like that template: it renders low, medium
 * and xhigh, defaults to xhigh, and answers anything else with the exact
 * error from the report.
 *
 * Run: npx vitest run src/api/providers/__tests__/template-effort-levels.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk } from '../types'
import type { OpenAIChatRequest } from '../openai-provider'
import { fitRungToTemplate, templateEffortLevels } from '../../../lib/local-effort'

const REPORTED_ERROR =
  'While executing CallExpression at line 49, column 28 in source:\n' +
  "...raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.')\n" +
  'Error: Jinja Exception: Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.'

/** The part of the template that matters here, as the model ships it. */
const QWEN_TEMPLATE =
  "{%- if reasoning_effort is not defined %}{%- set reasoning_effort = 'xhigh' %}{%- endif %}" +
  "{%- if reasoning_effort not in ['xhigh', 'medium', 'low'] %}" +
  "{{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}" +
  '{%- endif %}'

/** What b11960 reports in /props for that template. */
const QWEN_PROPS = {
  chat_template: QWEN_TEMPLATE,
  chat_template_caps: { supports_reasoning_effort: true, reasoning_effort_levels: ['low', 'medium', 'xhigh'] },
}

const SUPPORTED = ['low', 'medium', 'xhigh']
const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

type Init = { body?: string }
let sent: OpenAIChatRequest[]
let props: unknown

/** The rung b11960 hands the template: top-level wins over the kwargs
 *  (tools/server/server-common.cpp), absent means the template default. */
function templateRung(body: OpenAIChatRequest): string | undefined {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none') return body.reasoning_effort
  const kw = body.chat_template_kwargs?.reasoning_effort
  return typeof kw === 'string' ? kw : undefined
}

function answer(url: string, init: Init | undefined): Response {
  if (typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as OpenAIChatRequest
    sent.push(body)
    const rung = templateRung(body)
    if (rung !== undefined && !SUPPORTED.includes(rung)) {
      const msg = REPORTED_ERROR.replace(/effort high\./, `effort ${rung}.`)
      return new Response(JSON.stringify({ error: { code: 500, message: msg, type: 'server_error' } }), { status: 500 })
    }
    if (body.stream) return new Response(streamBody, { status: 200 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }
  if (url.endsWith('/props') && props !== undefined) return new Response(JSON.stringify(props), { status: 200 })
  return new Response('not found', { status: 404 })
}

async function makeOpenAI(config: ProviderConfig, serverProps: unknown) {
  vi.resetModules()
  sent = []
  props = serverProps
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(async (url: string, init?: Init) => answer(url, init)),
    localFetchStream: vi.fn(async (url: string, init?: Init) => answer(url, init)),
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
  return new mod.OpenAIProvider(config)
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>) {
  for await (const _ of gen) { /* the fetch fires on the first next() */ }
}

const ENGINE: ProviderConfig = {
  id: 'openai', name: 'LU Engine', apiKey: '', enabled: true,
  baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true,
}
const LLAMACPP: ProviderConfig = {
  id: 'openai', name: 'llama.cpp', apiKey: '', enabled: true, baseUrl: 'http://localhost:8080/v1', isLocal: true,
}
const MODEL = 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ2_M.gguf'
const ENGINE_LEVELS = ['low', 'medium', 'high']
const hi = [{ role: 'user' as const, content: 'hi' }]

afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('templateEffortLevels: the rungs b11960 reports in /props', () => {
  it('reads chat_template_caps.reasoning_effort_levels', () => {
    expect(templateEffortLevels(QWEN_PROPS)).toEqual(['low', 'medium', 'xhigh'])
  })

  it('an older server without the list, or an empty one, says nothing', () => {
    expect(templateEffortLevels({ chat_template: QWEN_TEMPLATE })).toBeUndefined()
    expect(templateEffortLevels({ chat_template_caps: { reasoning_effort_levels: [] } })).toBeUndefined()
    expect(templateEffortLevels(undefined)).toBeUndefined()
  })
})

describe('fitRungToTemplate', () => {
  const qwen = ['low', 'medium', 'xhigh']

  it('a listed rung stays', () => {
    expect(fitRungToTemplate('low', qwen)).toBe('low')
    expect(fitRungToTemplate('medium', qwen)).toBe('medium')
    expect(fitRungToTemplate('xhigh', qwen)).toBe('xhigh')
  })

  it('high on the reported template becomes xhigh, the next rung it has', () => {
    expect(fitRungToTemplate('high', qwen)).toBe('xhigh')
  })

  it('a rung above everything the template has is dropped: the template default', () => {
    expect(fitRungToTemplate('max', qwen)).toBeUndefined()
    expect(fitRungToTemplate('high', ['low', 'medium'])).toBeUndefined()
  })

  it('an alias listed under its higher name is found', () => {
    expect(fitRungToTemplate('high', ['low', 'medium', 'max'])).toBe('max')
  })

  it('below the cheapest rung goes up to it, never to minimal', () => {
    expect(fitRungToTemplate('low', ['medium', 'high'])).toBe('medium')
    expect(fitRungToTemplate('low', ['minimal', 'high'])).toBe('high')
  })

  it('no list keeps the rung, a word llama.cpp never tries is dropped', () => {
    expect(fitRungToTemplate('high', undefined)).toBe('high')
    expect(fitRungToTemplate('high', [])).toBe('high')
    expect(fitRungToTemplate('turbo', qwen)).toBeUndefined()
  })

  it('gpt-oss keeps all three rungs it lists', () => {
    for (const r of ['low', 'medium', 'high']) expect(fitRungToTemplate(r, ['low', 'medium', 'high'])).toBe(r)
  })
})

describe('LU Engine with the reported template', () => {
  it('High picked: the template gets xhigh instead of high and the message goes through', async () => {
    const p = await makeOpenAI(ENGINE, QWEN_PROPS)
    await drain(p.chatStream(MODEL, hi, {
      thinking: true, reasoningEffort: 'high', localEffortChosen: true, effortLevels: ENGINE_LEVELS,
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0].chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: 'xhigh' })
    expect('reasoning_effort' in sent[0]).toBe(false)
  })

  it('Max picked: the high applyLocalEffort chose becomes xhigh too', async () => {
    const p = await makeOpenAI(ENGINE, QWEN_PROPS)
    await drain(p.chatStream(MODEL, hi, {
      thinking: true, reasoningEffort: 'max', localEffortChosen: true, effortLevels: [...ENGINE_LEVELS, 'max'],
    }))
    expect(sent[0].chat_template_kwargs?.reasoning_effort).toBe('xhigh')
  })

  it('Low and Medium are rungs the template has and stay', async () => {
    const p = await makeOpenAI(ENGINE, QWEN_PROPS)
    await drain(p.chatStream(MODEL, hi, {
      thinking: true, reasoningEffort: 'medium', localEffortChosen: true, effortLevels: ENGINE_LEVELS,
    }))
    expect(sent[0].chat_template_kwargs?.reasoning_effort).toBe('medium')
  })

  it('the tool turn is fitted the same way', async () => {
    const p = await makeOpenAI(ENGINE, QWEN_PROPS)
    await p.chatWithTools(MODEL, hi, [], {
      thinking: true, reasoningEffort: 'high', localEffortChosen: true, effortLevels: ENGINE_LEVELS,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].chat_template_kwargs?.reasoning_effort).toBe('xhigh')
  })

  it('no rung picked: the request stays the one from before, nothing in the template', async () => {
    const p = await makeOpenAI(ENGINE, QWEN_PROPS)
    await drain(p.chatStream(MODEL, hi, { thinking: true, effortLevels: ENGINE_LEVELS }))
    expect(sent).toHaveLength(1)
    expect(sent[0].chat_template_kwargs).toEqual({ enable_thinking: true })
    expect('reasoning_effort' in sent[0]).toBe(false)
  })

  it('without the fix this template refuses high with the reported error (fake engine check)', async () => {
    // The same request with an engine that reports no levels, which is what
    // LU saw before: the rung goes out as high and the template raises.
    const p = await makeOpenAI(ENGINE, { chat_template: QWEN_TEMPLATE })
    let err: unknown
    try {
      await drain(p.chatStream(MODEL, hi, {
        thinking: true, reasoningEffort: 'high', localEffortChosen: true, effortLevels: ENGINE_LEVELS,
      }))
    } catch (e) { err = e }
    expect(String((err as Error)?.message ?? err)).toMatch(/Unexpected reasoning effort high\. Supported types are xhigh \(default\), medium, and low\./)
    expect(sent[0].chat_template_kwargs?.reasoning_effort).toBe('high')
  })
})

describe('self-hosted llama.cpp with the reported template', () => {
  it('the top-level high every Think-on request carries is fitted as well', async () => {
    const p = await makeOpenAI(LLAMACPP, QWEN_PROPS)
    await drain(p.chatStream(MODEL, hi, { thinking: true }))
    expect(sent).toHaveLength(1)
    expect(sent[0].reasoning_effort).toBe('xhigh')
  })

  it('Think off keeps its none, that is the off switch and not a rung', async () => {
    const p = await makeOpenAI(LLAMACPP, QWEN_PROPS)
    await drain(p.chatStream(MODEL, hi, { thinking: false }))
    expect(sent[0].reasoning_effort).toBe('none')
  })
})
