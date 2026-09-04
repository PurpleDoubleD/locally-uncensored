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
 *    'medium'. That is why the ladder is per model and why the wish is clamped
 *    onto it BEFORE the request leaves. The clamping happens on the server too,
 *    so a rung off the ladder never reaches the upstream and never comes back
 *    as a 4xx; the client therefore does not walk the rungs on a 4xx, because
 *    the everyday 4xx is an overlong context and has nothing to do with the
 *    knob.
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

// Die Form, die `vi.spyOn(globalThis, 'fetch')` wirklich hat. Ein `any` an
// dieser Stelle haette jeden Tippfehler im Zugriff verschluckt.
type FetchSpy = { mock: { calls: Parameters<typeof fetch>[] } }
const bodyOf = (spy: FetchSpy, call: number) => JSON.parse(spy.mock.calls[call][1]?.body as string)

async function drain(gen: AsyncGenerator<unknown>) {
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

  it("a wish off the ladder falls back to the model's own default", async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-fallback', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: ['low', 'medium', 'max'], effortDefault: 'low' },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('low')
  })

  it('but a model default ABOVE the wish never upgrades the bill', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-fallback-up', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'low', effortLevels: ['medium', 'high', 'max'], effortDefault: 'max' },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('medium')
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

describe('a 4xx is NEVER blamed on the rung', () => {
  // The server clamps every rung it knows onto the model's own ladder before
  // the request leaves the proxy, so a rung off this ladder does not come back
  // as a 400. What DOES come back as a 400 every day is an overlong context.
  // A client-side walk down the rungs would spend a post per rung on it, blame
  // the knob, and then remember a downgrade that nothing ever clears.
  it('THE RULE: a foreign 400 leaves the chosen rung exactly as it was', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-foreign-400', [{ role: 'user', content: 'war and peace' }], [],
      { thinking: true, reasoningEffort: 'max', effortLevels: GLM53 },
    )
    // Two posts: the request, then the one rung that has always existed, which
    // is dropping the knob. No 'high', no 'medium', no 'low' in between.
    expect(spy).toHaveBeenCalledTimes(2)
    expect(bodyOf(spy, 0).reasoning_effort).toBe('max')
    expect('reasoning_effort' in bodyOf(spy, 1)).toBe(false)
  })

  it('and one bad message does not cost the rung for the rest of the session', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refuse()).mockResolvedValueOnce(refuse())
    await expect(
      provider.chatWithTools(
        'e-context-blown', [{ role: 'user', content: 'war and peace' }], [],
        { thinking: true, reasoningEffort: 'high', effortLevels: GLM53 },
      ),
    ).rejects.toBeTruthy()
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-context-blown', [{ role: 'user', content: 'short' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: GLM53 },
    )
    expect(bodyOf(spy, 0).reasoning_effort).toBe('high')
  })

  it('the walk never invents a cheaper rung, it only ever drops the field', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools(
      'e-no-invention', [{ role: 'user', content: 'hi' }], [],
      { reasoningEffort: 'max', effortLevels: GLM53 },
    )
    const sent = spy.mock.calls.map((_c, i) => bodyOf(spy, i).reasoning_effort)
    expect(sent).toEqual(['max', undefined])
    expect(sent).not.toContain('high')
    expect(sent).not.toContain('none')
    expect(sent).not.toContain('minimal')
  })

  it('and on the streaming path stream_options keeps its own rung ahead of the knob', async () => {
    // The rung that has always been there: a 400 that stream_options caused is
    // never blamed on thinking, so the chosen rung survives that step untouched.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream(
      'e-stream-rung', [{ role: 'user', content: 'hi' }],
      { reasoningEffort: 'max', effortLevels: GLM53 },
    ))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(bodyOf(spy, 1).reasoning_effort).toBe('max')
    expect('stream_options' in bodyOf(spy, 1)).toBe(false)
  })
})

describe('the memory belongs to one rung, not to the whole switch', () => {
  it('a max that had to give the knob up does not take low down with it', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refuse()).mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-rungs', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'max', effortLevels: GLM53 },
    )
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-rungs', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'low', effortLevels: GLM53 },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(bodyOf(spy, 0).reasoning_effort).toBe('low')
  })

  it('but the same rung remembers, so the detour is paid once', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refuse()).mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-learned', [{ role: 'user', content: 'one' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: GLM53 },
    )
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-learned', [{ role: 'user', content: 'two' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: GLM53 },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect('reasoning_effort' in bodyOf(spy, 0)).toBe(false)
  })

  it('and the off switch keeps its own memory, untouched by any of it', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refuse()).mockResolvedValueOnce(ok())
    await provider.chatWithTools(
      'e-lanes', [{ role: 'user', content: 'hi' }], [],
      { thinking: true, reasoningEffort: 'high', effortLevels: GLM53 },
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
