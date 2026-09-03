import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localFetch to simulate Ollama responses without hitting a real server.
// This covers BOTH listModels (/api/tags) AND checkModelCapability (/api/generate)
// since both go through the same transport.
vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return {
    ...actual,
    localFetch: vi.fn(),
    isTauri: () => false,
    ollamaUrl: (p: string) => `http://localhost:11434/api${p.startsWith('/') ? p : '/' + p}`,
  }
})

import { localFetch } from '../backend'
import { checkModelCapability, scanInstalledModels } from '../ollama'

const mockedFetch = localFetch as unknown as ReturnType<typeof vi.fn>

/** Helper: match a request to the /api/generate probe for a specific model. */
type LocalFetchInit = Parameters<typeof localFetch>[1]

function respond(matcher: (url: string, body: Record<string, unknown>) => Response | null): void {
  mockedFetch.mockImplementation(async (url: string, opts?: LocalFetchInit) => {
    const body: Record<string, unknown> = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {}
    const res = matcher(url, body)
    if (res) return res
    return new Response(JSON.stringify({ error: 'no matcher' }), { status: 500 })
  })
}

describe('checkModelCapability', () => {
  beforeEach(() => {
    mockedFetch.mockReset()
  })
  afterEach(() => {
    mockedFetch.mockReset()
  })

  it('returns ok=true when /api/show returns metadata (valid manifest)', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ license: 'Apache-2.0', template: '{{ .Prompt }}', parameters: '' }), { status: 200 })
    )
    const result = await checkModelCapability('qwen2.5-coder:3b')
    expect(result).toEqual({ name: 'qwen2.5-coder:3b', ok: true, stale: false })
  })

  it('flags stale=true when /api/show returns 404 "model not found" (the staleness signature in 0.20.7)', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "model 'phi4:14b' not found" }), { status: 404 })
    )
    const result = await checkModelCapability('phi4:14b')
    expect(result.ok).toBe(false)
    expect(result.stale).toBe(true)
    expect(result.name).toBe('phi4:14b')
  })

  it('flags stale=true for legacy 400 "does not support chat" bodies (covers chat/codex/agent paths)', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: '"phi4:14b" does not support chat' }), { status: 400 })
    )
    const result = await checkModelCapability('phi4:14b')
    expect(result.stale).toBe(true)
  })

  it('flags stale=true even when wrapped as fake-500 by Rust proxy fallback', async () => {
    const wrapped = `HTTP 404: ${JSON.stringify({ error: "model 'phi4:14b' not found" })}`
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: wrapped }), { status: 500 })
    )
    const result = await checkModelCapability('phi4:14b')
    expect(result.stale).toBe(true)
  })

  it('returns ok=false, stale=false for unrelated errors (e.g. CUDA OOM)', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'CUDA: out of memory' }), { status: 500 })
    )
    const result = await checkModelCapability('gemma4:e4b')
    expect(result.ok).toBe(false)
    expect(result.stale).toBe(false)
    expect(result.error).toContain('CUDA')
  })

  it('returns ok=false, stale=false on network error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await checkModelCapability('qwen2.5-coder:3b')
    expect(result.ok).toBe(false)
    expect(result.stale).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('passes AbortSignal through to localFetch', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ done: true }), { status: 200 })
    )
    const controller = new AbortController()
    await checkModelCapability('qwen2.5-coder:3b', controller.signal)
    const callArgs = mockedFetch.mock.calls[0][1]
    expect(callArgs.signal).toBe(controller.signal)
  })
})

describe('scanInstalledModels', () => {
  beforeEach(() => {
    mockedFetch.mockReset()
  })

  it('filters out embedding models (nomic, bge, *-embed)', async () => {
    respond((url) => {
      // /api/tags listing — Ollama's canonical shape is {models: [{name, ...}]}
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'qwen2.5-coder:3b' },
              { name: 'nomic-embed-text:latest' },
              { name: 'bge-large:latest' },
              { name: 'some-embed-v1:small' },
              { name: 'phi4:14b' },
            ],
          }),
          { status: 200 }
        )
      }
      // /api/show metadata probe — succeed for any non-embedding model
      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({ license: 'MIT', template: '' }), { status: 200 })
      }
      return null
    })
    const results = await scanInstalledModels()
    expect(results.map((r) => r.name).sort()).toEqual(['phi4:14b', 'qwen2.5-coder:3b'])
  })

  it('returns per-model results including mixed pass/fail', async () => {
    respond((url, body) => {
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b' }, { name: 'phi4:14b' }] }),
          { status: 200 }
        )
      }
      if (url.endsWith('/api/show')) {
        if (body.model === 'qwen2.5-coder:3b') {
          return new Response(JSON.stringify({ license: 'MIT', template: '' }), { status: 200 })
        }
        return new Response(JSON.stringify({ error: `model '${body.model}' not found` }), { status: 404 })
      }
      return null
    })
    const results = await scanInstalledModels()
    expect(results).toHaveLength(2)
    const qwen = results.find((r) => r.name === 'qwen2.5-coder:3b')!
    const phi4 = results.find((r) => r.name === 'phi4:14b')!
    expect(qwen.ok).toBe(true)
    expect(phi4.ok).toBe(false)
    expect(phi4.stale).toBe(true)
  })

  it('returns empty array when listModels returns empty', async () => {
    respond((url) => {
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      return null
    })
    const results = await scanInstalledModels()
    expect(results).toEqual([])
  })
})
