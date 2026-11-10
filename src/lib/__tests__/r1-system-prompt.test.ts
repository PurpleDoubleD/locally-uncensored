/**
 * C69 (3.1.0): DeepSeek R1 and its distills get no system message.
 *
 * Discord: deepseek-r1:14b on Ollama answered "hi" with pages of thinking
 * about LU's system prompt. DeepSeek's model card: no system prompt, all
 * instructions in the user prompt. See lib/r1-system-prompt.ts.
 *
 * Run: npx vitest run src/lib/__tests__/r1-system-prompt.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { isR1StyleModel, foldSystemForR1, withoutLuLines } from '../r1-system-prompt'
import { applyTemplateContract } from '../../api/providers/normalize-system'
import { buildChatSystemPrompt, withHouseConduct, CHAT_BASE_SYSTEM_PROMPT, HOUSE_RULES } from '../system-prompt'
import type { ChatMessage, ProviderConfig } from '../../api/providers/types'
import type { OpenAIChatRequest } from '../../api/providers/openai-provider'
import type { OllamaChatRequest } from '../../api/providers/ollama-provider'

describe('which models count as R1', () => {
  it.each([
    'deepseek-r1:14b',
    'deepseek-r1:8b',
    'deepseek-r1',
    'deepseek-r1:671b',
    'huihui_ai/deepseek-r1-abliterated:8b',
    'hf.co/bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF:Q4_K_M',
    'hf.co/unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF:Q4_K_M',
    // LU Engine: the GGUF file name, with or without the extension.
    'DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf',
    'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M',
    'deepseek_r1_distill_qwen_1.5b',
    'R1-Distill-Qwen-7B-abliterated.Q4_K_M.gguf',
    // Cloud catalogues.
    'deepseek/deepseek-r1-0528',
    'deepseek/deepseek-r1-distill-llama-70b',
    'deepseek-ai/DeepSeek-R1',
    'perplexity/r1-1776',
  ])('%s is R1', (name) => {
    expect(isR1StyleModel(name)).toBe(true)
  })

  it.each([
    'deepseek-v3', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-coder-v2:16b',
    'deepseek-v2.5', 'qwen3:8b', 'gemma3:4b', 'command-r:35b', 'command-r7b',
    'llama3.1:8b', 'deepseek-r10', 'mistral-small', '', undefined, null,
  ])('%s is not', (name) => {
    expect(isR1StyleModel(name as string)).toBe(false)
  })
})

describe('the fold', () => {
  const chat = (system: string): ChatMessage[] => [
    { role: 'system', content: system },
    { role: 'user', content: 'hi' },
  ]

  it('the plain LU prompt is left out entirely: "hi" goes out as "hi"', () => {
    const out = foldSystemForR1('deepseek-r1:14b', chat(buildChatSystemPrompt({})))
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('a persona is kept, fenced, in front of the first user message, without the house lines', () => {
    const persona = 'You are Captain Mira, a gruff starship pilot. Stay in character.'
    const system = buildChatSystemPrompt({ systemPrompt: persona, personaEnabled: true })
    expect(system).toContain(HOUSE_RULES)
    const out = foldSystemForR1('deepseek-r1:14b', chat(system))
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe(`<instructions>\n${persona}\n</instructions>\n\nhi`)
  })

  it('an agent role and its tool catalogue survive the fold', () => {
    const agent = withHouseConduct('You are a coding agent.\n\n<tools>\n[{"name":"file_read"}]\n</tools>')
    const out = foldSystemForR1('deepseek-r1:8b', chat(agent))
    expect(out[0].content).toContain('You are a coding agent.')
    expect(out[0].content).toContain('"name":"file_read"')
    expect(out[0].content).not.toContain(HOUSE_RULES)
  })

  it('it lands in the FIRST user turn of a longer chat, the rest stays by reference', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'Persona P.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'two' },
    ]
    const out = foldSystemForR1('deepseek-r1:14b', msgs)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[0].content).toBe('<instructions>\nPersona P.\n</instructions>\n\none')
    expect(out[1]).toBe(msgs[2])
    expect(out[2]).toBe(msgs[3])
  })

  it('images on the first user turn ride along', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'Persona P.' },
      { role: 'user', content: 'what is this', images: [{ data: 'AAA', mimeType: 'image/png' }] },
    ]
    const out = foldSystemForR1('deepseek-r1:14b', msgs)
    expect(out[0].images).toEqual([{ data: 'AAA', mimeType: 'image/png' }])
  })

  it('a system message with no user turn becomes the user turn', () => {
    const out = foldSystemForR1('deepseek-r1:14b', [{ role: 'system', content: 'Summarise X.' }])
    expect(out).toEqual([{ role: 'user', content: '<instructions>\nSummarise X.\n</instructions>' }])
  })

  it('withoutLuLines strips only LU lines', () => {
    expect(withoutLuLines(CHAT_BASE_SYSTEM_PROMPT)).toBe('')
    expect(withoutLuLines(`Mine.\n\n${HOUSE_RULES}`)).toBe('Mine.')
    expect(withoutLuLines('Mine only.')).toBe('Mine only.')
  })

  it('NEGATIVE CONTROL: every other model gets the same array back, by reference', () => {
    const msgs = chat(buildChatSystemPrompt({}))
    for (const m of ['qwen3:8b', 'deepseek-v3', 'gemma3:4b', 'Llama-3.1-8B-Q4_K_M.gguf']) {
      expect(foldSystemForR1(m, msgs)).toBe(msgs)
      expect(applyTemplateContract(msgs, { toolRole: 'text', alternate: true, model: m })).toBe(msgs)
    }
    expect(applyTemplateContract(msgs, { toolRole: 'text', alternate: true })).toBe(msgs)
  })

  it('through the whole contract, a greeting-first character chat still alternates', () => {
    // A character card opens with an assistant greeting. userTurnFirst puts a
    // bridge user line in front; the persona folds into that one.
    const msgs: ChatMessage[] = [
      { role: 'system', content: buildChatSystemPrompt({ systemPrompt: 'Card text.', personaEnabled: true }) },
      { role: 'assistant', content: 'Greetings, traveller.' },
      { role: 'user', content: 'hi' },
    ]
    const out = applyTemplateContract(msgs, { toolRole: 'text', alternate: true, model: 'deepseek-r1:14b' })
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[0].content).toContain('Card text.')
    expect(out.some((m) => m.role === 'system')).toBe(false)
  })
})

// ── On the wire ────────────────────────────────────────────────

type CapturedInit = { body?: string }

const backendMock = (capture: (url: string, init: CapturedInit) => Response) => ({
  isTauri: () => false,
  localFetch: vi.fn(async (url: string, init: CapturedInit) => capture(url, init)),
  localFetchStream: vi.fn(async (url: string, init: CapturedInit) => capture(url, init)),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  backendCall: vi.fn(),
  isPrivateOrLanHost: () => true,
  isDirectFetchAllowed: () => false,
  hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(),
})

afterEach(() => {
  vi.doUnmock('../../api/backend')
  vi.doUnmock('../../api/builtin-ensure')
  vi.resetModules()
})

const HI: ChatMessage[] = [
  { role: 'system', content: CHAT_BASE_SYSTEM_PROMPT },
  { role: 'user', content: 'hi' },
]

async function viaOllama(model: string): Promise<OllamaChatRequest> {
  vi.resetModules()
  const captures: OllamaChatRequest[] = []
  vi.doMock('../../api/backend', () =>
    backendMock((url, init) => {
      if (url.endsWith('/chat')) captures.push(JSON.parse(init.body ?? '{}'))
      return new Response('{"message":{"content":"ok"},"done":true}\n')
    }),
  )
  const { OllamaProvider } = await import('../../api/providers/ollama-provider')
  const p = new OllamaProvider({ id: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true })
  for await (const chunk of p.chatStream(model, HI)) { void chunk }
  expect(captures).toHaveLength(1)
  return captures[0]
}

async function viaEngine(model: string): Promise<OpenAIChatRequest> {
  vi.resetModules()
  let sent: OpenAIChatRequest | null = null
  vi.doMock('../../api/backend', () =>
    backendMock((url, init) => {
      if (url.includes('/chat/completions')) {
        sent = JSON.parse(init.body ?? '{}')
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }),
  )
  vi.doMock('../../api/builtin-ensure', () => ({
    ensureBuiltinEngineAlive: vi.fn(),
    explainDeadEngine: (e: unknown) => e,
    isManagedBuiltinSlot: () => true,
  }))
  const { OpenAIProvider } = await import('../../api/providers/openai-provider')
  const cfg: ProviderConfig = { id: 'openai', name: 'LU Engine', enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true }
  await new OpenAIProvider(cfg).chatWithTools(model, HI, [])
  if (!sent) throw new Error('no /chat/completions request was captured')
  return sent
}

describe('the request that leaves', () => {
  it('Ollama deepseek-r1:14b: no system message, "hi" is "hi"', async () => {
    const body = await viaOllama('deepseek-r1:14b')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('NEGATIVE CONTROL: Ollama qwen3:8b keeps its system message', async () => {
    const body = await viaOllama('qwen3:8b')
    expect(body.messages[0]).toEqual({ role: 'system', content: CHAT_BASE_SYSTEM_PROMPT })
  })

  it('LU Engine with an R1 distill GGUF: no system message', async () => {
    const sent = await viaEngine('DeepSeek-R1-Distill-Qwen-14B-Q4_K_M')
    expect(sent.messages.some((m) => m.role === 'system')).toBe(false)
    expect(sent.messages[0]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('NEGATIVE CONTROL: LU Engine with another GGUF keeps it', async () => {
    const sent = await viaEngine('Qwen3-8B-Q4_K_M')
    expect(sent.messages[0]).toMatchObject({ role: 'system', content: CHAT_BASE_SYSTEM_PROMPT })
  })
})
