/**
 * A fresh install must not greet people with a proxy stack trace
 * (applejames, Discord 2026-08-01, Windows 10, 2.5.10):
 *
 *   Error: proxy_localhost_stream_chunked: error sending request for url
 *   (http://127.0.0.1:8127/v1/chat/completions)
 *
 * They had run onboarding, had qwen 0.5 installed, clicked New Chat, and got
 * that. Two holes led there and both are covered below:
 *
 *  1. the self-heal returned quietly when the picked model was not among the
 *     bundled files, so the send went ahead into a port with nothing behind it
 *  2. nothing translated a refused connection to our own engine, so the raw
 *     transport error reached the chat bubble
 *
 * Run: npx vitest run src/api/__tests__/builtin-engine-dead-port.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import { ensureBuiltinEngineAlive, explainDeadEngine, isManagedBuiltinSlot } from '../builtin-ensure'
import { backendCall } from '../backend'
import { useProviderStore } from '../../stores/providerStore'

const MANAGED_URL = 'http://127.0.0.1:8127/v1'

const asManagedSlot = () => {
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, enabled: true, managed: true, baseUrl: MANAGED_URL },
    },
  }))
}

const asForeignSlot = () => {
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, enabled: true, managed: false, baseUrl: 'https://api.openai.com/v1' },
    },
  }))
}

describe('explainDeadEngine', () => {
  const raw = 'proxy_localhost_stream_chunked: error sending request for url (http://127.0.0.1:8127/v1/chat/completions)'

  it('turns the exact reported error into a sentence naming the engine and the port', () => {
    const out = explainDeadEngine(new Error(raw), MANAGED_URL) as Error
    expect(out.message).toMatch(/built-in engine is not answering on 127\.0\.0\.1:8127/i)
    expect(out.message).toMatch(/Settings/i)
  })

  // Changed 2026-08-29 (counter-check round 2). The raw line used to be
  // appended for bug reports, which put "proxy_localhost_stream_chunked" in
  // front of the user. House rule: no raw Rust error in a chat bubble. The
  // original is written to the app log instead, see explainEngineTransportMessage.
  it('keeps the internal Rust command name out of the bubble', () => {
    const out = explainDeadEngine(new Error(raw), MANAGED_URL) as Error
    expect(out.message).not.toContain('proxy_localhost_stream_chunked')
    expect(out.message).not.toContain('Original error')
  })

  it('covers the other shapes a refused local connection takes', () => {
    for (const msg of [
      'error sending request for url (http://127.0.0.1:8127/v1/chat/completions): connection refused',
      'TypeError: Failed to fetch http://127.0.0.1:8127/v1/chat/completions',
      'ECONNREFUSED 127.0.0.1:8127',
    ]) {
      const out = explainDeadEngine(new Error(msg), MANAGED_URL) as Error
      expect(out.message).toMatch(/built-in engine is not answering/i)
    }
  })

  it('leaves a real HTTP error alone — that text is the server speaking', () => {
    const httpErr = new Error('HTTP 400: {"error":"context length exceeded"}')
    expect(explainDeadEngine(httpErr, MANAGED_URL)).toBe(httpErr)
  })

  it('leaves a failure against a different host alone', () => {
    const other = new Error('error sending request for url (https://api.openai.com/v1/chat/completions)')
    expect(explainDeadEngine(other, MANAGED_URL)).toBe(other)
  })
})

describe('ensureBuiltinEngineAlive — the model is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asManagedSlot()
  })

  it('says which model is missing instead of letting the send hit a dead port', async () => {
    vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
      if (cmd === 'bundled_engine_status') return { running: false, healthy: false }
      if (cmd === 'list_bundled_models') return { models: [] }
      throw new Error(`unexpected command ${cmd}`)
    }) as never)

    await expect(ensureBuiltinEngineAlive('qwen2.5-0.5b-instruct-q4_k_m.gguf'))
      .rejects.toThrow(/no model file named "qwen2\.5-0\.5b-instruct-q4_k_m\.gguf"/i)
  })

  it('points at the Models page as the way out', async () => {
    vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
      if (cmd === 'bundled_engine_status') return { running: false, healthy: false }
      if (cmd === 'list_bundled_models') return { models: [{ name: 'something-else.gguf', path: '/m/other.gguf' }] }
      throw new Error(`unexpected command ${cmd}`)
    }) as never)

    await expect(ensureBuiltinEngineAlive('qwen2.5-0.5b.gguf')).rejects.toThrow(/Open Models/i)
  })

  it('restarts the engine when the model IS there (regression guard)', async () => {
    const calls: string[] = []
    vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'bundled_engine_status') return { running: false, healthy: false }
      if (cmd === 'list_bundled_models') return { models: [{ name: 'qwen2.5-0.5b.gguf', path: '/m/qwen2.5-0.5b.gguf' }] }
      if (cmd === 'start_bundled_engine') return { status: 'started' }
      throw new Error(`unexpected command ${cmd}`)
    }) as never)

    await expect(ensureBuiltinEngineAlive('qwen2.5-0.5b.gguf')).resolves.toBeUndefined()
    expect(calls).toContain('start_bundled_engine')
  })

  it('does nothing at all when the engine is already healthy', async () => {
    const calls: string[] = []
    vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'bundled_engine_status') return { running: true, healthy: true }
      throw new Error(`unexpected command ${cmd}`)
    }) as never)

    await expect(ensureBuiltinEngineAlive('qwen2.5-0.5b.gguf')).resolves.toBeUndefined()
    expect(calls).toEqual(['bundled_engine_status'])
  })

  it('stays out of the way when the slot is somebody else s server', async () => {
    asForeignSlot()
    expect(isManagedBuiltinSlot()).toBe(false)
    await expect(ensureBuiltinEngineAlive('gpt-4o')).resolves.toBeUndefined()
    expect(backendCall).not.toHaveBeenCalled()
  })
})
