/**
 * tool-capability cache (2.5.8) — learns which models reject tool calling from
 * real request outcomes, so the picker can flag them and Agent/Code can warn.
 * Run: npx vitest run src/api/__tests__/tool-capability.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getToolCapability,
  markToolsSupported,
  markToolsUnsupported,
  clearToolCapability,
  resetToolCapabilityCache,
} from '../tool-capability'

// vitest runs under the node env where localStorage is absent; the module
// gracefully no-ops without it, but we install a stub to exercise the cache.
const installLocalStorageStub = () => {
  const store: Record<string, string> = {}
  // Reflect statt eines Casts: `globalThis.localStorage` ist in den DOM-Typen
  // als vollstaendiges `Storage` deklariert, und nur daran hing das `as any`.
  Reflect.set(globalThis, 'localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  })
}

describe('tool-capability cache', () => {
  beforeEach(() => {
    installLocalStorageStub()
    resetToolCapabilityCache()
  })

  it('reports unknown for an unseen model', () => {
    expect(getToolCapability('mystery-model')).toBe('unknown')
  })

  it('reports unknown for an empty id', () => {
    expect(getToolCapability('')).toBe('unknown')
  })

  it('remembers a model that rejected tool calls', () => {
    markToolsUnsupported('no-tools-model')
    expect(getToolCapability('no-tools-model')).toBe('unsupported')
  })

  it('remembers a model that supports tool calls', () => {
    markToolsSupported('good-model')
    expect(getToolCapability('good-model')).toBe('supported')
  })

  it('normalizes the provider prefix so cloud id and picker id converge', () => {
    // hooks mark the raw id sent to the provider; the picker looks up model.name
    markToolsUnsupported('lu-cloud::meta-llama/Meta-Llama-3.1-8B')
    expect(getToolCapability('meta-llama/Meta-Llama-3.1-8B')).toBe('unsupported')
    expect(getToolCapability('lu-cloud::meta-llama/Meta-Llama-3.1-8B')).toBe('unsupported')
  })

  it('clears a single entry back to unknown', () => {
    markToolsUnsupported('m')
    clearToolCapability('m')
    expect(getToolCapability('m')).toBe('unknown')
  })

  describe('negative-result decay', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('decays a negative result to unknown after the 24h TTL', () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      markToolsUnsupported('decays')
      expect(getToolCapability('decays')).toBe('unsupported')
      vi.setSystemTime(new Date('2026-01-02T01:00:00Z')) // +25h
      expect(getToolCapability('decays')).toBe('unknown')
    })

    it('keeps a positive result sticky past the TTL', () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      markToolsSupported('sticky')
      vi.setSystemTime(new Date('2026-02-01T00:00:00Z')) // +1 month
      expect(getToolCapability('sticky')).toBe('supported')
    })
  })
})
