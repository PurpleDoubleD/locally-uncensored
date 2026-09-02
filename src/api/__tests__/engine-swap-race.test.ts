/**
 * Counter-check round 2, side finding 2 (installed Windows build, 2026-08-29).
 *
 * Two model switches in quick succession, then send at once. What appeared in
 * the chat bubble:
 *
 *   Error: proxy_localhost_stream_chunked: error sending request for url
 *   (http://127.0.0.1:8127/v1/chat/completions)
 *
 * Two separate faults, one test file:
 *  1. the send went out while the app's OWN swap was still restarting
 *     llama-server, so it fired into a port with nothing behind it
 *  2. when a transport failure does get through, the user reads the name of a
 *     Rust command instead of a sentence
 *
 * Run: npx vitest run src/api/__tests__/engine-swap-race.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn(), localFetch: vi.fn(), localFetchStream: vi.fn() }
})

import {
  trackEngineSwap,
  waitForEngineSwap,
  engineSwapInFlight,
  __resetEngineSwapGateForTests,
} from '../engine-swap-gate'
import { ensureBuiltinEngineAlive, explainEngineTransportMessage } from '../builtin-ensure'
import { backendCall, localFetch } from '../backend'
import { OpenAIProvider } from '../providers/openai-provider'
import { useProviderStore } from '../../stores/providerStore'

const MANAGED_URL = 'http://127.0.0.1:8127/v1'
const RAW = 'proxy_localhost_stream_chunked: error sending request for url (http://127.0.0.1:8127/v1/chat/completions)'

const asManagedSlot = () => {
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, enabled: true, managed: true, baseUrl: MANAGED_URL },
    },
  }))
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetEngineSwapGateForTests()
  vi.mocked(backendCall).mockReset()
  vi.mocked(localFetch).mockReset()
  asManagedSlot()
})

const managedProvider = () =>
  new OpenAIProvider({
    id: 'openai', name: 'LU Engine', enabled: true,
    baseUrl: MANAGED_URL, apiKey: '', isLocal: true, managed: true,
  } as never)

describe('engine swap gate', () => {
  it('reports an idle engine when nothing is loading', async () => {
    expect(engineSwapInFlight()).toBe(false)
    expect(await waitForEngineSwap(50)).toBe('idle')
  })

  it('a send waits for a swap that is still running', async () => {
    const d = deferred<void>()
    trackEngineSwap(d.promise)
    expect(engineSwapInFlight()).toBe(true)

    let done = false
    const waiting = waitForEngineSwap(5_000).then((r) => { done = true; return r })
    await Promise.resolve()
    expect(done).toBe(false) // still parked on the swap

    d.resolve()
    expect(await waiting).toBe('settled')
    expect(engineSwapInFlight()).toBe(false)
  })

  it('a failed swap clears the light instead of wedging every later send', async () => {
    const d = deferred<void>()
    trackEngineSwap(d.promise).catch(() => undefined)
    d.reject(new Error('engine refused to start'))
    expect(await waitForEngineSwap(5_000)).toBe('settled')
    expect(engineSwapInFlight()).toBe(false)
  })

  // NEGATIVE CONTROL: the wait must have a deadline. A swap that never
  // finishes may not hold a send hostage forever.
  it('gives up on a swap that outlasts the deadline', async () => {
    trackEngineSwap(deferred<void>().promise)
    expect(await waitForEngineSwap(20)).toBe('timeout')
  })

  it('the promise handed to the caller is untouched', async () => {
    const p = Promise.resolve('value')
    expect(await trackEngineSwap(p)).toBe('value')
  })
})

describe('ensureBuiltinEngineAlive waits the swap out before probing', () => {
  it('does not touch the engine while a swap is in flight', async () => {
    const swap = deferred<void>()
    trackEngineSwap(swap.promise)
    vi.mocked(backendCall).mockResolvedValue({
      running: true, healthy: true, model_path: '/m/Hermes.gguf',
    } as never)

    const send = ensureBuiltinEngineAlive('openai::Hermes')
    await Promise.resolve()
    await Promise.resolve()
    // The status probe is the first thing the old code did. It must not have
    // happened yet: that probe answering "healthy" mid-restart is exactly how
    // the send was let through into the gap.
    expect(vi.mocked(backendCall)).not.toHaveBeenCalled()

    swap.resolve()
    await send
    expect(vi.mocked(backendCall).mock.calls.map((c) => c[0])).toContain('bundled_engine_status')
  })

  // NEGATIVE CONTROL: with no swap running the send must not be delayed at
  // all, otherwise the fix would tax every ordinary message.
  it('probes straight away when no swap is running', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      running: true, healthy: true, model_path: '/m/Hermes.gguf',
    } as never)
    await ensureBuiltinEngineAlive('openai::Hermes')
    expect(vi.mocked(backendCall).mock.calls.map((c) => c[0])).toContain('bundled_engine_status')
  })
})

describe('a transport failure that still gets through is labelled in English', () => {
  it('rewrites the exact body the proxy hands back as a 503', () => {
    const out = explainEngineTransportMessage(RAW, MANAGED_URL)
    expect(out).toMatch(/LU Engine is not answering on 127\.0\.0\.1:8127/i)
    expect(out).toMatch(/still loading a model/i)
    expect(out).not.toContain('proxy_localhost_stream_chunked')
  })

  it('covers the shorter proxy_localhost variant too', () => {
    const out = explainEngineTransportMessage(
      'proxy_localhost: error sending request for url (http://127.0.0.1:8127/v1/models)',
      MANAGED_URL,
    )
    expect(out).toMatch(/LU Engine is not answering/i)
  })

  // NEGATIVE CONTROL: a real answer from the server keeps the server's own
  // words, and a failure against somebody else's host is none of our business.
  it('leaves a real server message and a foreign host alone', () => {
    expect(explainEngineTransportMessage('context length exceeded', MANAGED_URL)).toBeNull()
    expect(
      explainEngineTransportMessage(
        'error sending request for url (https://api.openai.com/v1/chat/completions)',
        MANAGED_URL,
      ),
    ).toBeNull()
  })
})

describe('the provider really hands the plain sentence on (wiring)', () => {
  // The transport failure does NOT arrive as a thrown error: localFetchStream
  // turns it into Response(503, {"error": "proxy_localhost_stream_chunked ..."}),
  // which is why sendOrExplain never saw it and the raw text reached the
  // bubble. This drives the real provider through that exact shape.
  it('a 503 from our own proxy comes out as a sentence, not a command name', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      running: true, healthy: true, model_path: '/m/Hermes.gguf',
    } as never)
    vi.mocked(localFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: RAW }), { status: 503 }) as never,
    )
    const err = await managedProvider()
      .chatWithTools('Hermes', [{ role: 'user', content: 'hi' }] as never, [] as never)
      .then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/LU Engine is not answering/i)
    expect(err?.message).not.toContain('proxy_localhost_stream_chunked')
  })

  // NEGATIVE CONTROL: when the engine DID answer, its own words must survive.
  // Rewriting a real 400 would hide the actual reason from the user.
  it('a real engine answer keeps the engine words', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      running: true, healthy: true, model_path: '/m/Hermes.gguf',
    } as never)
    vi.mocked(localFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'the request exceeds the available context size' }), { status: 400 }) as never,
    )
    const err = await managedProvider()
      .chatWithTools('Hermes', [{ role: 'user', content: 'hi' }] as never, [] as never)
      .then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/exceeds the available context size/i)
  })
})
