import { describe, it, expect, vi, afterEach } from 'vitest'
import { idbStorage } from '../idbStorage'
import { prop } from '../../types/json-guards'

// The vitest env is `node`: no `indexedDB`, so idbStorage takes its SYNC
// localStorage fallback. That sync path is exactly what keeps Zustand
// hydration synchronous in the suite (the 2580 store tests rely on it) — in
// the real WebView2 app `indexedDB` exists and the adapter goes async + idb.
function mockLS(init: Record<string, string> = {}): Storage {
  const store: Record<string, string> = { ...init }
  return {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { store[k] = v }),
    removeItem: vi.fn((k: string) => { delete store[k] }),
    clear: vi.fn(() => { for (const k in store) delete store[k] }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
}

describe('idbStorage (no-IndexedDB fallback path)', () => {
  afterEach(() => {
    try { Reflect.deleteProperty(globalThis, 'localStorage') } catch { /* ignore */ }
  })

  it('round-trips via localStorage SYNCHRONOUSLY (no Promise) when idb is absent', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: mockLS(), writable: true, configurable: true })
    // setItem must NOT return a Promise here (keeps persist hydration sync in tests)
    const setResult = idbStorage.setItem('chat-conversations', '{"state":{"conversations":[]}}')
    expect(setResult).toBeUndefined()
    const got = idbStorage.getItem('chat-conversations')
    expect(got).toBe('{"state":{"conversations":[]}}')
    expect(typeof prop(got, 'then')).not.toBe('function') // sync string, not a thenable
    idbStorage.removeItem('chat-conversations')
    expect(idbStorage.getItem('chat-conversations')).toBeNull()
  })

  it('getItem returns null for a missing key', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: mockLS(), writable: true, configurable: true })
    expect(idbStorage.getItem('nonexistent')).toBeNull()
  })

  it('never throws when localStorage is unavailable (SSR / locked)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() { throw new Error('blocked') }, configurable: true,
    })
    expect(() => idbStorage.setItem('k', 'v')).not.toThrow()
    expect(idbStorage.getItem('k')).toBeNull()
    expect(() => idbStorage.removeItem('k')).not.toThrow()
  })
})
