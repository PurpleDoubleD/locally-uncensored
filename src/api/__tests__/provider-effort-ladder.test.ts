/**
 * The chosen effort rung has to arrive on the wire, and a model that always
 * reasons must never be sent 'none'.
 *
 * Companion to provider-think-off.test.ts, which nails the OFF switch. This
 * file is the other direction: the rung the user picked in the composer, the
 * ladder the server declared for that model, and what happens when the upstream
 * refuses a rung anyway.
 *
 * Two live measurements from 2026-09-02 stand behind it
 * (ops/wissen/deepinfra-modellmatrix-2026-09-02.md):
 *
 *  - Qwen/Qwen3.8-27B answers 400 to 'high' and to 'max', naming 'low' and
 *    'medium'. Dropping the parameter on that 400 hands the turn to the
 *    upstream default, which is the most expensive setting there is. Stepping
 *    one rung down keeps the reasoning AND the price the user asked for.
 *  - On GLM 5.3, 'none' does not stop the thinking. It only stops the upstream
 *    from separating it, so the monologue lands in the customer's chat window
 *    and costs more tokens than sending nothing at all. GLM 5.3 is a
 *    think:'always' model, so this file holds the rule that an always-reasoner
 *    never receives 'none'.
 *
 * Test isolation: the walk is remembered per endpoint, model AND rung in a
 * static map, so every case below uses its own model name.
 *
 * Run: npx vitest run src/api/__tests__/provider-effort-ladder.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../providers/openai-provider'
import type { ProviderConfig } from '../providers/types'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'lu-cloud',
    name: 'LU Cloud',
    enabled: true,
    baseUrl: 'https://lu-labs.ai/api/inference/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  }
}

const GLM53 = ['low', 'medium', 'high', 'max']
const QWEN38_27B = ['minimal', 'low', 'medium']

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
const refuse = (status = 400) =>
  new Response(JSON.stringify({ error: { message: 'Unexpected reasoning effort high.' } }), { status })
const okStream = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 })

const bodyOf = (spy: any, call: number) => JSON.parse(spy.mock.calls[call][1]?.body as string)

async function drain(gen: AsyncGenerator<any>) {
  for await (const _ of gen) { /* consume, the fetch only happens on first next() */ }
}

afterEach(() => vi.restoreAllMocks())

describe('the rung the user picked is the rung that goes out', () => {
  it('chatWithTools sends it', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-tools', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'low', effortLevels: GLM53 },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('low')
  })

  it('chatStream sends it too, that is the path a chat actually takes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream(
      'e-stream', [{ role: 'user', content: 'hi' }],
      { thinking: true, reasoningEffort: 'max', effortLevels: GLM53 },
    ))
    expect(bodyOf(spy, 0).reasoning_effort).toBe('max')
  })

  it('a wish above the model ladder is clamped before it leaves, not refused there', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-clamp', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'max', effortLevels: QWEN38_27B },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(bodyOf(spy, 0).reasoning_effort).toBe('medium')
  })
})

describe('a model that always reasons never gets none', () => {
  // The composer keeps the Think button locked on for these, so `thinking`
  // arrives undefined. Before the ladder existed that meant "send no knob at
  // all"; with a declared ladder it means "send the rung, and only the rung".
  it('THE RULE: thinking undefined plus a ladder sends the rung, never none', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-always', [{ role: 'user', content: 'hi' }], [],
      { reasoningEffort: 'medium', effortLevels: GLM53 },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('medium')
    expect(bodyOf(spy, 0).reasoning_effort).not.toBe('none')
  })

  it('and on the streaming path as well', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream(
      'e-always-stream', [{ role: 'user', content: 'hi' }],
      { reasoningEffort: 'max', effortLevels: GLM53 },
    ))
    expect(bodyOf(spy, 0).reasoning_effort).toBe('max')
  })

  it('with no wish at all it still sends a rung, and the rung is not none', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-always-nowish', [{ role: 'user', content: 'hi' }], [], { effortLevels: GLM53 },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('high')
  })
})

describe('a refused rung steps down the ladder instead of vanishing', () => {
  it('THE MEASUREMENT: a 400 on high lands on medium, not on no knob', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-step', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'] },
    )
    expect(spy).toHaveBeenCalledTimes(2)
    expect(bodyOf(spy, 1).reasoning_effort).toBe('medium')
  })

  it('walks further down while the upstream keeps refusing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-step-twice', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'max', effortLevels: GLM53 },
    )
    expect(spy).toHaveBeenCalledTimes(3)
    expect(bodyOf(spy, 2).reasoning_effort).toBe('medium')
  })

  it('an accepted rung is never thrown away for the next one', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-stop-at-yes', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'max', effortLevels: GLM53 },
    )
    expect(spy).toHaveBeenCalledTimes(2)
    expect(bodyOf(spy, 1).reasoning_effort).toBe('high')
  })

  it('and the knob is only dropped once the whole ladder is exhausted', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-exhausted', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'] },
    )
    expect(spy).toHaveBeenCalledTimes(4)
    expect('reasoning_effort' in bodyOf(spy, 3)).toBe(false)
  })

  it('the step down NEVER lands on none, not even at the bottom of the ladder', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-never-none', [{ role: 'user', content: 'hi' }], [],
      { reasoningEffort: 'max', effortLevels: ['low', 'high', 'max'] },
    )
    const sent = spy.mock.calls.map((_c, i) => bodyOf(spy, i).reasoning_effort)
    expect(sent).toEqual(['max', 'high', 'low', undefined])
    expect(sent).not.toContain('none')
    expect(sent).not.toContain('minimal')
  })
})

describe('the memory belongs to one rung, not to the whole switch', () => {
  it('what a refused max taught is not charged to low', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-rungs', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'max', effortLevels: ['low', 'medium', 'max'] },
    )
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-rungs', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'low', effortLevels: ['low', 'medium', 'max'] },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(bodyOf(spy, 0).reasoning_effort).toBe('low')
  })

  it('a rung that had to step down starts at the rung that worked next time', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-learned', [{ role: 'user', content: 'one' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'] },
    )
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-learned', [{ role: 'user', content: 'two' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'] },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(bodyOf(spy, 0).reasoning_effort).toBe('medium')
  })

  it('and the off switch keeps its own memory, untouched by any of it', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-lanes', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'high'] },
    )
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('e-lanes', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })
})

describe('an older server that declares no ladder changes nothing at all', () => {
  it('thinking on is still exactly high', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-noladder-on', [{ role: 'user', content: 'hi' }], [], { thinking: true, reasoningEffort: 'low' },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('high')
  })

  it('thinking off is still exactly none', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-noladder-off', [{ role: 'user', content: 'hi' }], [], { thinking: false, reasoningEffort: 'max' },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })

  it('and a model with no declared capability still sends no knob at all', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-noladder-undef', [{ role: 'user', content: 'hi' }], [], { reasoningEffort: 'max' },
    )
    expect('reasoning_effort' in bodyOf(spy, 0)).toBe(false)
  })
})

describe('the catalogue carries the ladder from the server to the composer', () => {
  it('reasoning_effort_levels and reasoning_effort_default survive listModels', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        object: 'list',
        data: [{
          id: 'zai-org/GLM-5.3', object: 'model', owned_by: 'lu-labs', name: 'GLM 5.3',
          context_length: 1_048_576, input_modalities: ['text'], think: 'always',
          supports_tools: true,
          reasoning_effort_levels: ['low', 'medium', 'high', 'max'],
          reasoning_effort_default: 'high',
        }],
      }), { status: 200 }),
    )
    const models = await new OpenAIProvider(makeConfig()).listModels()
    expect(models[0].effortLevels).toEqual(['low', 'medium', 'high', 'max'])
    expect(models[0].effortDefault).toBe('high')
    expect(models[0].thinkMode).toBe('always')
  })

  it('a server that sends neither field leaves both undefined, and that is the off switch for the control', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'old/model', object: 'model', name: 'Old', context_length: 8192, think: 'toggle' }],
      }), { status: 200 }),
    )
    const models = await new OpenAIProvider(makeConfig()).listModels()
    expect(models[0].effortLevels).toBeUndefined()
    expect(models[0].effortDefault).toBeUndefined()
  })
})
