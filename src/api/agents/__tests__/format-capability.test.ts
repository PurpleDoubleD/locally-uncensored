import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getFormatCapability,
  markFormatSupported,
  markFormatUnsupported,
  clearFormatCapability,
  resetFormatCapabilityCache,
  probeFormatSupport,
} from '../format-capability'

// Minimal localStorage polyfill — tests run under vitest node env where
// localStorage is absent. The module itself gracefully no-ops without it,
// but we want to validate cache behaviour, so we install a stub.
const installLocalStorageStub = () => {
  const store: Record<string, string> = {}
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
  }
}

describe('format-capability — cache', () => {
  beforeEach(() => {
    installLocalStorageStub()
    resetFormatCapabilityCache()
  })

  it('returns "unknown" for a model never probed', () => {
    expect(getFormatCapability('qwen3:8b')).toBe('unknown')
  })

  it('records supported and returns "supported"', () => {
    markFormatSupported('qwen3:8b')
    expect(getFormatCapability('qwen3:8b')).toBe('supported')
  })

  it('records unsupported and returns "unsupported" within TTL', () => {
    markFormatUnsupported('oldmodel:latest')
    expect(getFormatCapability('oldmodel:latest')).toBe('unsupported')
  })

  it('treats unsupported entries older than TTL as "unknown" (re-probe)', () => {
    const past = Date.now() - 25 * 60 * 60 * 1000 // 25h ago, past 24h TTL
    ;(globalThis as any).localStorage.setItem(
      'lu-format-capability-v1',
      JSON.stringify({ 'oldmodel:latest': { capability: 'unsupported', checkedAt: past } })
    )
    expect(getFormatCapability('oldmodel:latest')).toBe('unknown')
  })

  it('clearFormatCapability removes a single entry', () => {
    markFormatSupported('a')
    markFormatSupported('b')
    clearFormatCapability('a')
    expect(getFormatCapability('a')).toBe('unknown')
    expect(getFormatCapability('b')).toBe('supported')
  })

  it('isolates models by name', () => {
    markFormatSupported('a')
    markFormatUnsupported('b')
    expect(getFormatCapability('a')).toBe('supported')
    expect(getFormatCapability('b')).toBe('unsupported')
  })

  it('survives corrupted cache gracefully', () => {
    ;(globalThis as any).localStorage.setItem('lu-format-capability-v1', '{not-json')
    expect(getFormatCapability('a')).toBe('unknown')
    // And subsequent writes overwrite cleanly.
    markFormatSupported('a')
    expect(getFormatCapability('a')).toBe('supported')
  })
})

describe('format-capability — probeFormatSupport', () => {
  beforeEach(() => {
    installLocalStorageStub()
    resetFormatCapabilityCache()
  })

  it('marks supported on HTTP 200 with parseable JSON response', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ response: '{"ok":true}' }), { status: 200 })
    ) as any
    const result = await probeFormatSupport('m', 'http://localhost:11434', fetchStub)
    expect(result).toBe('supported')
    expect(getFormatCapability('m')).toBe('supported')
  })

  it('marks unsupported on HTTP 200 but non-JSON response text', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ response: 'hello, not JSON' }), { status: 200 })
    ) as any
    const result = await probeFormatSupport('m', 'http://localhost:11434', fetchStub)
    expect(result).toBe('unsupported')
    expect(getFormatCapability('m')).toBe('unsupported')
  })

  it('marks unsupported on HTTP error status', async () => {
    const fetchStub = vi.fn(async () =>
      new Response('{"error":"bad"}', { status: 500 })
    ) as any
    const result = await probeFormatSupport('m', 'http://localhost:11434', fetchStub)
    expect(result).toBe('unsupported')
  })

  it('marks unsupported on abort (timeout)', async () => {
    const fetchStub = vi.fn((_url, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err: any = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as any
    const result = await probeFormatSupport('m', 'http://localhost:11434', fetchStub)
    expect(result).toBe('unsupported')
    expect(getFormatCapability('m')).toBe('unsupported')
  }, 10000)

  it('re-throws on non-abort network errors (does not corrupt cache)', async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as any
    await expect(
      probeFormatSupport('m', 'http://localhost:11434', fetchStub)
    ).rejects.toThrow('ECONNREFUSED')
    expect(getFormatCapability('m')).toBe('unknown')
  })

  it('strips trailing slash from base URL', async () => {
    const fetchStub = vi.fn(async (url: string) => {
      expect(url).toBe('http://localhost:11434/api/generate')
      return new Response(JSON.stringify({ response: '{"ok":1}' }), { status: 200 })
    }) as any
    await probeFormatSupport('m', 'http://localhost:11434/', fetchStub)
    expect(fetchStub).toHaveBeenCalled()
  })
})
