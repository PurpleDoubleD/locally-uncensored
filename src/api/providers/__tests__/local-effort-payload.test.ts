/**
 * Issue 176: reasoning effort for local models, on the wire and in the listing.
 *
 * Before this the effort control existed for hosted models only. A local
 * model never had rungs, the composer drew no control, and every local
 * request with Think on carried `reasoning_effort: 'high'` and nothing more,
 * whatever the user picked. Each server below gets the form its own source
 * or documentation names (lib/local-effort.ts has the references).
 *
 * 3.0.7 follow-up: the rungs a local server gave us wait for the user's own
 * pick (settings.localEffortChosen). The global rung defaults to 'high', and
 * sending that as a real rung changed every local model nobody had touched.
 * Without a pick each server gets exactly what origin/master (3.0.6) sent.
 *
 * Run: npx vitest run src/api/providers/__tests__/local-effort-payload.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk } from '../types'
import type { OpenAIChatRequest } from '../openai-provider'

const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

type Init = { body?: string }
let sent: { url: string; body: OpenAIChatRequest }[]
/** GET answers per URL suffix, longest suffix first so /api/v1/models is
 *  not read as /v1/models; anything else is a 404. */
let facts: Record<string, unknown>

function answer(url: string, init: Init | undefined): Response {
  if (typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as OpenAIChatRequest
    sent.push({ url, body })
    if (body.stream) return new Response(streamBody, { status: 200 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }
  const hit = Object.keys(facts).sort((a, b) => b.length - a.length).find((suffix) => url.endsWith(suffix))
  return hit
    ? new Response(JSON.stringify(facts[hit]), { status: 200 })
    : new Response('not found', { status: 404 })
}

async function makeOpenAI(config: ProviderConfig, serverFacts: Record<string, unknown> = {}) {
  vi.resetModules()
  sent = []
  facts = serverFacts
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
const chatBody = () => sent.filter((s) => s.url.endsWith('/chat/completions')).map((s) => s.body)[0]

const ENGINE: ProviderConfig = {
  id: 'openai', name: 'LU Engine', apiKey: '', enabled: true,
  baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true,
}
const local = (name: string, port: number): ProviderConfig => ({
  id: 'openai', name, apiKey: '', enabled: true, baseUrl: `http://localhost:${port}/v1`, isLocal: true,
})
const LM_STUDIO = local('LM Studio', 1234)
const KOBOLD = local('KoboldCpp', 5001)
const LLAMACPP = local('llama.cpp', 8080)
const VLLM = local('vLLM', 8000)

const KOBOLD_FACTS = { '/api/extra/version': { result: 'KoboldCpp', version: '1.123' } }
const LMS_FACTS = {
  '/v1/models': { data: [{ id: 'openai/gpt-oss-20b' }, { id: 'google/gemma-4-26b-a4b' }] },
  '/api/v1/models': {
    models: [
      { type: 'llm', key: 'openai/gpt-oss-20b', capabilities: { reasoning: { allowed_options: ['low', 'medium', 'high'], default: 'medium' } } },
      { type: 'llm', key: 'google/gemma-4-26b-a4b', capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } } },
    ],
  },
}
const GPT_OSS_TEMPLATE = '{%- if reasoning_effort is not defined %}{%- set reasoning_effort = "medium" %}{%- endif %}Reasoning: {{ reasoning_effort }}'

afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('LU Engine (llama-server b9949, b11960): template variable plus budget', () => {
  const levels = ['low', 'medium', 'high']

  it('Low goes into the template and sets a 1024 token budget when the Think budget is Auto', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('qwen3-8b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'low', localEffortChosen: true, effortLevels: levels, thinkingBudget: 0,
    }))
    const body = chatBody()
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: 'low' })
    expect(body.thinking_budget_tokens).toBe(1024)
  })

  it('a Think budget of your own wins over the rung', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('qwen3-8b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'medium', localEffortChosen: true, effortLevels: levels, thinkingBudget: 2048,
    }))
    expect(chatBody().thinking_budget_tokens).toBe(2048)
    expect(chatBody().chat_template_kwargs?.reasoning_effort).toBe('medium')
  })

  it('High sets no budget, as every request did before', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('qwen3-8b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'high', localEffortChosen: true, effortLevels: levels,
    }))
    expect('thinking_budget_tokens' in chatBody()).toBe(false)
    expect(chatBody().chat_template_kwargs?.reasoning_effort).toBe('high')
  })

  it('Think off sends no rung at all', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('qwen3-8b', [{ role: 'user', content: 'hi' }], {
      thinking: false, reasoningEffort: 'low', localEffortChosen: true, effortLevels: levels,
    }))
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: false })
    expect('thinking_budget_tokens' in chatBody()).toBe(false)
  })

  it('E1: the rung never goes out top-level, b11960 would write it over the template variable', async () => {
    const p = await makeOpenAI(ENGINE)
    // Think on, no rung picked: before 3.0.7 and after, the template keeps its own default.
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], { thinking: true, effortLevels: levels }))
    expect('reasoning_effort' in chatBody()).toBe(false)
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true })
    // Max: the template gets the 'high' applyLocalEffort chose, nothing says 'max'.
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'max', localEffortChosen: true, effortLevels: levels,
    }))
    const max = sent.filter((s) => s.url.endsWith('/chat/completions')).map((s) => s.body)[1]
    expect('reasoning_effort' in max).toBe(false)
    expect(max.chat_template_kwargs?.reasoning_effort).toBe('high')
    // Think off: enable_thinking false, no 'none' beside it.
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], { thinking: false, effortLevels: levels }))
    const off = sent.filter((s) => s.url.endsWith('/chat/completions')).map((s) => s.body)[2]
    expect('reasoning_effort' in off).toBe(false)
    expect(off.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('E1: the same holds for the tool turn', async () => {
    const p = await makeOpenAI(ENGINE)
    await p.chatWithTools('qwen3-8b', [{ role: 'user', content: 'hi' }], [], {
      thinking: true, reasoningEffort: 'low', localEffortChosen: true, effortLevels: levels, thinkingBudget: 0,
    })
    expect('reasoning_effort' in chatBody()).toBe(false)
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: 'low' })
    expect(chatBody().thinking_budget_tokens).toBe(1024)
  })

  it('every engine model offers the three rungs', async () => {
    const { bundledToAIModels } = await import('../../engine')
    const [row] = bundledToAIModels([{ name: 'qwen3-8b.gguf', path: '/m/qwen3-8b.gguf', size: 1 } as never])
    expect(row.effortLevels).toEqual(['low', 'medium', 'high'])
  })
})

describe('KoboldCpp (koboldcpp.py 1.123): top-level reasoning_effort', () => {
  const levels = ['low', 'medium', 'high', 'max']

  it('lists four rungs for its models', async () => {
    const p = await makeOpenAI(KOBOLD, { ...KOBOLD_FACTS, '/v1/models': { data: [{ id: 'koboldcpp/Qwen3-8B' }] } })
    const [m] = await p.listModels()
    expect(m.effortLevels).toEqual(levels)
  })

  it('Low is sent as the word KoboldCpp maps to a quarter of the reply', async () => {
    const p = await makeOpenAI(KOBOLD, KOBOLD_FACTS)
    await drain(p.chatStream('koboldcpp/Qwen3-8B', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'low', localEffortChosen: true, effortLevels: levels,
    }))
    expect(chatBody().reasoning_effort).toBe('low')
  })

  it('Max sends no reasoning_effort, which is KoboldCpp unrestricted', async () => {
    const p = await makeOpenAI(KOBOLD, KOBOLD_FACTS)
    await drain(p.chatStream('koboldcpp/Qwen3-8B', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'max', localEffortChosen: true, effortLevels: levels,
    }))
    expect('reasoning_effort' in chatBody()).toBe(false)
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true })
  })
})

describe('LM Studio (0.4.8 and later): rungs per model from /api/v1/models', () => {
  it('a model with levels gets them, one with only on and off gets the greyed note', async () => {
    const p = await makeOpenAI(LM_STUDIO, LMS_FACTS)
    const models = await p.listModels()
    const oss = models.find((m) => m.id === 'openai/gpt-oss-20b')!
    const gemma = models.find((m) => m.id === 'google/gemma-4-26b-a4b')!
    expect(oss.effortLevels).toEqual(['low', 'medium', 'high'])
    expect(oss.effortNote).toBeUndefined()
    expect(gemma.effortLevels).toBeUndefined()
    expect(gemma.effortNote).toBe('LM Studio lists no effort levels for this model.')
  })

  it('the rung goes out as top-level reasoning_effort and nowhere else', async () => {
    const p = await makeOpenAI(LM_STUDIO, LMS_FACTS)
    await drain(p.chatStream('openai/gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'medium', localEffortChosen: true, effortLevels: ['low', 'medium', 'high'],
    }))
    expect(chatBody().reasoning_effort).toBe('medium')
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true })
    expect('thinking_budget_tokens' in chatBody()).toBe(false)
  })
})

describe('self-hosted llama.cpp: only when the template reads reasoning_effort', () => {
  it('a gpt-oss template gets the rungs and the template variable, no budget', async () => {
    const p = await makeOpenAI(LLAMACPP, {
      '/props': { chat_template: GPT_OSS_TEMPLATE },
      '/v1/models': { data: [{ id: 'gpt-oss-20b' }] },
    })
    const [m] = await p.listModels()
    expect(m.effortLevels).toEqual(['low', 'medium', 'high'])
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'low', localEffortChosen: true, effortLevels: m.effortLevels, thinkingBudget: 0,
    }))
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: 'low' })
    expect('thinking_budget_tokens' in chatBody()).toBe(false)
  })

  it('a template without it is greyed with the reason', async () => {
    const p = await makeOpenAI(LLAMACPP, {
      '/props': { chat_template: '{{ messages }}{% if enable_thinking %}<think>{% endif %}' },
      '/v1/models': { data: [{ id: 'qwen3-8b' }] },
    })
    const [m] = await p.listModels()
    expect(m.effortLevels).toBeUndefined()
    expect(m.effortNote).toBe('The chat template of this model has no effort setting.')
  })
})

describe('a backend we cannot place', () => {
  it('vLLM: no rungs, a plain note, and the request stays as before', async () => {
    const p = await makeOpenAI(VLLM, { '/v1/models': { data: [{ id: 'Qwen/Qwen3-8B' }] } })
    const [m] = await p.listModels()
    expect(m.effortLevels).toBeUndefined()
    expect(m.effortNote).toBe('This backend does not take effort levels.')
    await drain(p.chatStream('Qwen/Qwen3-8B', [{ role: 'user', content: 'hi' }], { thinking: true, reasoningEffort: 'low' }))
    expect(chatBody().reasoning_effort).toBe('high')
  })
})

/**
 * Without a pick: the request each server got before 3.0.7.
 *
 * Read from origin/master (3.0.6), openai-provider.ts: no local model had a
 * ladder, so thinkingEffort answered DEFAULT_EFFORT and chatStream put
 * `reasoning_effort: 'high'` at the top level and `chat_template_kwargs:
 * { enable_thinking: true }` beside it, and nothing else. LM Studio and
 * KoboldCpp read that top-level 'high'; the LU Engine and llama.cpp ignored it,
 * so gpt-oss ran on the Medium its template sets for itself.
 *
 * E1 (3.0.9): the LU Engine (b11960) reads that top-level field now and puts
 * it into the template, so for the engine the same result means the field
 * stays off the wire (keepEffortOffEngineTopLevel). The effect is pinned, not
 * the bytes: nothing reaches the template.
 */
describe('no rung picked for a local model yet: the request from before 3.0.7', () => {
  const PRE_307 = { reasoning_effort: 'high', chat_template_kwargs: { enable_thinking: true } }
  const ENGINE_PRE_307 = { reasoning_effort: undefined, chat_template_kwargs: { enable_thinking: true } }
  const shape = (b: OpenAIChatRequest) => ({
    reasoning_effort: b.reasoning_effort,
    chat_template_kwargs: b.chat_template_kwargs,
    budget: 'thinking_budget_tokens' in b,
  })

  it('LU Engine: nothing in the template and no budget, though the global rung says high', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'], thinkingBudget: 0,
      localEffortChosen: false,
    }))
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(shape(chatBody())).toEqual({ ...ENGINE_PRE_307, budget: false })
  })

  it('LU Engine: a caller that does not say counts as not picked, Low included', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'low', effortLevels: ['low', 'medium', 'high'], thinkingBudget: 0,
    }))
    expect(shape(chatBody())).toEqual({ ...ENGINE_PRE_307, budget: false })
  })

  it('LU Engine, the non-streaming path too', async () => {
    const p = await makeOpenAI(ENGINE)
    await p.chatWithTools('gpt-oss-20b', [{ role: 'user', content: 'hi' }], [], {
      thinking: true, reasoningEffort: 'medium', effortLevels: ['low', 'medium', 'high'],
    })
    expect(shape(chatBody())).toEqual({ ...ENGINE_PRE_307, budget: false })
  })

  it('LU Engine: a Think budget of your own still goes out, it is a pick of its own', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'], thinkingBudget: 2048,
    }))
    expect(chatBody().thinking_budget_tokens).toBe(2048)
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it('LU Engine with a pick: the rung goes into the template', async () => {
    const p = await makeOpenAI(ENGINE)
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'medium', effortLevels: ['low', 'medium', 'high'], thinkingBudget: 0,
      localEffortChosen: true,
    }))
    expect(chatBody().chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: 'medium' })
    expect(chatBody().thinking_budget_tokens).toBe(4096)
  })

  it('LM Studio: top-level high as before, even where the global rung is Low', async () => {
    const p = await makeOpenAI(LM_STUDIO, LMS_FACTS)
    await drain(p.chatStream('openai/gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'low', effortLevels: ['low', 'medium', 'high'],
    }))
    expect(shape(chatBody())).toEqual({ ...PRE_307, budget: false })
  })

  it('KoboldCpp: top-level high as before, a stored Max sends no unrestricted request', async () => {
    const p = await makeOpenAI(KOBOLD, KOBOLD_FACTS)
    await drain(p.chatStream('koboldcpp/Qwen3-8B', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'max', effortLevels: ['low', 'medium', 'high', 'max'],
    }))
    expect(shape(chatBody())).toEqual({ ...PRE_307, budget: false })
  })

  it('self-hosted llama.cpp with a gpt-oss template: nothing in the template', async () => {
    const p = await makeOpenAI(LLAMACPP, { '/props': { chat_template: GPT_OSS_TEMPLATE } })
    await drain(p.chatStream('gpt-oss-20b', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'],
    }))
    expect(shape(chatBody())).toEqual({ ...PRE_307, budget: false })
  })

  it('the listing marks such rungs as local, and only those', async () => {
    const p = await makeOpenAI(LM_STUDIO, LMS_FACTS)
    const models = await p.listModels()
    expect(models.find((m) => m.id === 'openai/gpt-oss-20b')!.effortLocal).toBe(true)
    expect(models.find((m) => m.id === 'google/gemma-4-26b-a4b')!.effortLocal).toBeUndefined()
    const { bundledToAIModels } = await import('../../engine')
    const [row] = bundledToAIModels([{ name: 'qwen3-8b.gguf', path: '/m/qwen3-8b.gguf', size: 1 } as never])
    expect(row.effortLocal).toBe(true)
  })

  it('a ladder a LAN catalogue declares itself is the server word and needs no pick', async () => {
    const p = await makeOpenAI(VLLM, {
      '/v1/models': { data: [{ id: 'served/glm', reasoning_effort_levels: ['low', 'medium', 'high'] }] },
    })
    const [m] = await p.listModels()
    expect(m.effortLocal).toBeUndefined()
    await drain(p.chatStream('served/glm', [{ role: 'user', content: 'hi' }], {
      thinking: true, reasoningEffort: 'low', effortLevels: m.effortLevels,
    }))
    expect(chatBody().reasoning_effort).toBe('low')
  })
})
