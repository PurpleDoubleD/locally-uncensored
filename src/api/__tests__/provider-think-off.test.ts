/**
 * Thinking OFF has to mean off, on somebody else's server too.
 *
 * kevinmlynch, issue #112 on 2026-08-13, arrived with a trace and a working
 * local patch: he points LU at DwarfStar, turns thinking off for his tool
 * workflows, and gets reasoning anyway. We sent `reasoning_effort: 'minimal'`,
 * the least the OpenAI API itself allows, and DwarfStar reads 'minimal' as
 * `think_mode: high`. Our switch did the opposite of what it says. Only 'none'
 * really disables it there.
 *
 * LU Cloud was never affected, the proxy already translates minimal to none.
 * This is exactly the endpoints a user configures themselves.
 *
 * Swapping the literal is not enough, and useChat.ts:524 says why: 'none' is
 * younger than 'minimal', an older API answers 400, and forcing a value on an
 * always-thinker can 4xx as well. So the knob walks down over the retry path
 * that already exists: none, then minimal, then gone.
 *
 * Test isolation: the walk is remembered per endpoint and model in a static
 * map, so every test below uses its own model name.
 *
 * Run: npx vitest run src/api/__tests__/provider-think-off.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../providers/openai-provider'
import type { ChatStreamChunk, ProviderConfig } from '../providers/types'
import type { OpenAIChatRequest } from '../providers/openai-provider'
import { sentJson } from './provider-test-support'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'TestProvider',
    enabled: true,
    baseUrl: 'https://third-party.test/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  }
}

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
const refuse = (status = 400) =>
  new Response(JSON.stringify({ error: { message: 'unknown value for reasoning_effort' } }), { status })
const okStream = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 })

/**
 * Der mitgeschnittene Request-Koerper, gelesen als der Typ, den der Provider
 * BAUT. Als `any` gelesen haette eine Umbenennung von `reasoning_effort` jede
 * Zeile unten still auf `undefined` gegen `'none'` laufen lassen — also rot,
 * aber erst zur Laufzeit und mit einer Meldung, die die Ursache verschweigt.
 *
 * Der Spy-Parameter ist strukturell getippt statt als `MockInstance`: gebraucht
 * wird nur `mock.calls`, und das haelt den Helfer unabhaengig davon, wie vitest
 * seine Mock-Generics gerade schreibt.
 */
const bodyOf = (spy: { mock: { calls: readonly (readonly unknown[])[] } }, call: number) =>
  sentJson<OpenAIChatRequest>(spy.mock.calls, call)

async function drain(gen: AsyncIterable<ChatStreamChunk>) {
  for await (const _ of gen) { /* consume, the fetch only happens on first next() */ }
}

afterEach(() => vi.restoreAllMocks())

describe('the off switch sends the value that actually turns thinking off', () => {
  it('chatWithTools sends none, not minimal', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools('m-off-tools', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })

  it('chatStream sends none too, it is the path a chat actually takes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream('m-off-stream', [{ role: 'user', content: 'hi' }], { thinking: false }))
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })

  it('thinking on is untouched at high', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools('m-on', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('high')
  })

  it('a model with no declared think capability still sends no knob at all', async () => {
    // useChat leaves `thinking` undefined for 'always' and 'never' models, so
    // the upstream keeps deciding for itself. That must survive this change.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools('m-undef', [{ role: 'user', content: 'hi' }], [])
    expect('reasoning_effort' in bodyOf(spy, 0)).toBe(false)
  })
})

describe('an endpoint that does not know none gets minimal, not nothing', () => {
  it('the second attempt carries minimal and keeps stream_options', async () => {
    // The old code dropped both fields at the first complaint. Dropping the
    // knob entirely is the one outcome that gives the user thinking back, so
    // it stays the last resort and not the first answer.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream('m-old-api', [{ role: 'user', content: 'hi' }], { thinking: false }))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(bodyOf(spy, 1).reasoning_effort).toBe('minimal')
    expect(bodyOf(spy, 1).stream_options).toEqual({ include_usage: true })
  })

  it('422 walks the same ladder, that is DeepInfra bad-parameter status', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse(422))
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools('m-422', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 1).reasoning_effort).toBe('minimal')
  })

  it('stream_options is dropped on its own rung, before the knob', async () => {
    // The two fields get separate rungs so a 400 that stream_options caused is
    // never blamed on thinking. Dropping both at once and then crediting the
    // knob is how an endpoint that merely dislikes stream_options ended up
    // remembered as one that cannot think at all.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream('m-no-stream-opts', [{ role: 'user', content: 'hi' }], { thinking: false }))
    expect(spy).toHaveBeenCalledTimes(3)
    expect(bodyOf(spy, 2).reasoning_effort).toBe('minimal')
    expect('stream_options' in bodyOf(spy, 2)).toBe(false)
  })

  it('an endpoint that knows neither ends up with no knob and no stream_options', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(okStream())
    await drain(new OpenAIProvider(makeConfig()).chatStream('m-ancient', [{ role: 'user', content: 'hi' }], { thinking: false }))
    expect(spy).toHaveBeenCalledTimes(4)
    expect('reasoning_effort' in bodyOf(spy, 3)).toBe(false)
    expect('stream_options' in bodyOf(spy, 3)).toBe(false)
  })

  it('a refused high goes straight to no knob, it is not a step on the ladder', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await new OpenAIProvider(makeConfig()).chatWithTools('m-high-refused', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    expect(spy).toHaveBeenCalledTimes(2)
    expect('reasoning_effort' in bodyOf(spy, 1)).toBe(false)
  })
})

describe('the detour is paid once, not on every message', () => {
  it('after a successful step down, the next message starts at minimal', async () => {
    const provider = new OpenAIProvider(makeConfig())
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-memory', [{ role: 'user', content: 'one' }], [], { thinking: false })
    await provider.chatWithTools('m-memory', [{ role: 'user', content: 'two' }], [], { thinking: false })
    expect(spy).toHaveBeenCalledTimes(3)
    expect(bodyOf(spy, 2).reasoning_effort).toBe('minimal')
  })

  it('the memory is per model, a sibling model still gets none', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-sibling-a', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    vi.restoreAllMocks()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-sibling-b', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })

  it('a refused high is remembered, and the next ON message skips the knob', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-no-knob', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    vi.restoreAllMocks()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-no-knob', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect('reasoning_effort' in bodyOf(spy, 0)).toBe(false)
  })
})

describe('what one direction of the switch learns never binds the other', () => {
  // The review of this very fix found the hole (2026-08-14). Endpoints with
  // the o1-era vocabulary accept low, medium and high while refusing both
  // 'none' and 'minimal'. With a single shared entry, one message sent with
  // thinking OFF walked all the way to "no knob" and that memory then
  // swallowed the user's 'high' forever after, with no note and no way back
  // short of restarting the app. The switch looked alive and did nothing.

  it('a walk to no knob with thinking OFF still leaves thinking ON at high', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-o1-era', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-o1-era', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('high')
  })

  it('a refused high does not cost the user the off switch', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-on-only', [{ role: 'user', content: 'hi' }], [], { thinking: true })
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-on-only', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })

  it('a 400 that stream_options caused is not remembered as a dead knob', async () => {
    const provider = new OpenAIProvider(makeConfig())
    // none refused, minimal refused, stream_options dropped and it goes through:
    // the endpoint understands minimal fine, it just never knew stream_options.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(okStream())
    await drain(provider.chatStream('m-blame', [{ role: 'user', content: 'hi' }], { thinking: false }))
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-blame', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('minimal')
  })
})

describe('a 400 for an unrelated reason teaches nothing', () => {
  // The load-bearing one. An overlong context is the everyday 400, and it
  // walks this exact ladder. If a failed walk wrote to the memory, one
  // oversized message would cost the user their off switch for the whole
  // session, on an endpoint that supports it perfectly well.
  it('when every attempt fails, the next message starts at none again', async () => {
    const provider = new OpenAIProvider(makeConfig())
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
    await expect(
      provider.chatWithTools('m-context-blown', [{ role: 'user', content: 'war and peace' }], [], { thinking: false }),
    ).rejects.toBeTruthy()
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-context-blown', [{ role: 'user', content: 'short' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })

  it('a 500 is not a refusal and is not retried at all', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(
      new OpenAIProvider(makeConfig()).chatWithTools('m-500', [{ role: 'user', content: 'hi' }], [], { thinking: false }),
    ).rejects.toBeTruthy()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('stop ends the walk', () => {
  // P6 from the review. The claim as filed does not hold for the real fetch:
  // an aborted signal makes it reject, so no rung reaches the network. It does
  // hold for localFetchStream, whose proxy path used to call cancel on a stream
  // id it had not opened yet and then start the request anyway. The mock here
  // stands in for exactly that kind of fetcher, one that ignores the signal.
  it('a rung is not posted once the user has pressed stop', async () => {
    const ac = new AbortController()
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Deaf to the signal on purpose, like the proxy path was.
      ac.abort()
      return refuse()
    })
    await expect(
      new OpenAIProvider(makeConfig()).chatWithTools(
        'm-stopped', [{ role: 'user', content: 'hi' }], [], { thinking: false, signal: ac.signal },
      ),
    ).rejects.toBeTruthy()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('and nothing is learned from a walk the user cut short', async () => {
    const provider = new OpenAIProvider(makeConfig())
    const ac = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { ac.abort(); return refuse() })
    await expect(
      provider.chatWithTools('m-cut', [{ role: 'user', content: 'hi' }], [], { thinking: false, signal: ac.signal }),
    ).rejects.toBeTruthy()
    vi.restoreAllMocks()

    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok())
    await provider.chatWithTools('m-cut', [{ role: 'user', content: 'hi' }], [], { thinking: false })
    expect(bodyOf(spy, 0).reasoning_effort).toBe('none')
  })
})
