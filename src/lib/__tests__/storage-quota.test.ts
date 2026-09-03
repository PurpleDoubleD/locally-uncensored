import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'
import { getStorageUsage, createSafeStorage } from '../storage-quota'
import { prop, propPath, asString } from '../../types/json-guards'

/**
 * The ids of a pruned list, read back out of the JSON the adapter wrote. The
 * blob is deliberately handled as foreign data here — that is exactly the
 * position production is in when it reads it again.
 */
function idsOf(list: unknown): string[] {
  return Array.isArray(list) ? list.map((e) => asString(prop(e, 'id')) ?? '') : []
}

/** Element `i` of a value that may or may not be an array. */
function at(list: unknown, i: number): unknown {
  return Array.isArray(list) ? list[i] : undefined
}

// Mock localStorage for tests
function createMockStorage(items: Record<string, string> = {}): Storage {
  const store: Record<string, string> = { ...items }
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { for (const k in store) delete store[k] }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
}

describe('storage-quota', () => {
  let originalLocalStorage: Storage

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage
  })

  afterEach(() => {
    // Restore real localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    })
  })

  // ─── getStorageUsage ───

  describe('getStorageUsage', () => {
    it('returns zero bytes for empty storage', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        value: createMockStorage({}),
        writable: true,
        configurable: true,
      })
      const usage = getStorageUsage()
      expect(usage.usedBytes).toBe(0)
      expect(usage.percentFull).toBe(0)
    })

    it('calculates correct byte count for stored items', () => {
      // "a" (1 char key) + "bb" (2 chars value) = 3 chars => 6 bytes (x2 for UTF-16)
      // "cd" (2 char key) + "efg" (3 chars value) = 5 chars => 10 bytes
      // Total = 16 bytes
      Object.defineProperty(globalThis, 'localStorage', {
        value: createMockStorage({ a: 'bb', cd: 'efg' }),
        writable: true,
        configurable: true,
      })
      const usage = getStorageUsage()
      expect(usage.usedBytes).toBe(16)
    })

    it('calculates percentFull based on 5MB estimated limit', () => {
      // 1000 chars = 2000 bytes, limit = 5*1024*1024 = 5242880
      Object.defineProperty(globalThis, 'localStorage', {
        value: createMockStorage({ bigkey: 'x'.repeat(994) }),
        writable: true,
        configurable: true,
      })
      const usage = getStorageUsage()
      // (6 + 994) = 1000 chars -> 2000 bytes -> 2000/5242880
      expect(usage.usedBytes).toBe(2000)
      expect(usage.percentFull).toBeCloseTo(2000 / (5 * 1024 * 1024), 5)
    })

    it('handles localStorage not being available', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        get() { throw new Error('not available') },
        configurable: true,
      })
      const usage = getStorageUsage()
      expect(usage.usedBytes).toBe(0)
      expect(usage.percentFull).toBe(0)
    })
  })

  // ─── createSafeStorage ───

  describe('createSafeStorage', () => {
    it('returns an object with getItem, setItem, removeItem', () => {
      const storage = createSafeStorage()
      expect(typeof storage.getItem).toBe('function')
      expect(typeof storage.setItem).toBe('function')
      expect(typeof storage.removeItem).toBe('function')
    })

    it('getItem reads from localStorage', () => {
      const mock = createMockStorage({ 'test-key': '{"value": 42}' })
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })
      const storage = createSafeStorage()
      expect(storage.getItem('test-key')).toBe('{"value": 42}')
    })

    it('getItem returns null for missing key', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        value: createMockStorage({}),
        writable: true,
        configurable: true,
      })
      const storage = createSafeStorage()
      expect(storage.getItem('nonexistent')).toBeNull()
    })

    it('setItem writes to localStorage', () => {
      const mock = createMockStorage({})
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })
      const storage = createSafeStorage()
      storage.setItem('mykey', 'myvalue')
      expect(mock.setItem).toHaveBeenCalledWith('mykey', 'myvalue')
    })

    it('removeItem removes from localStorage', () => {
      const mock = createMockStorage({ 'del-me': 'val' })
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })
      const storage = createSafeStorage()
      storage.removeItem('del-me')
      expect(mock.removeItem).toHaveBeenCalledWith('del-me')
    })

    it('catches QuotaExceededError and does not throw', () => {
      const quotaErr = new DOMException('quota exceeded', 'QuotaExceededError')
      const mock = createMockStorage({})
      mock.setItem = vi.fn().mockImplementation(() => { throw quotaErr })
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })
      const storage = createSafeStorage()
      // Should not throw
      expect(() => storage.setItem('key', 'value')).not.toThrow()
    })

    it('retries after pruning conversations on QuotaExceededError', () => {
      let callCount = 0
      const quotaErr = new DOMException('quota exceeded', 'QuotaExceededError')

      // Build a conversations store with 150 conversations (>100 threshold)
      const conversations = Array.from({ length: 150 }, (_, i) => ({
        id: `conv-${i}`,
        updatedAt: Date.now() - i * 1000,
        messages: [{ content: 'hello' }],
      }))
      const chatData = JSON.stringify({ state: { conversations } })

      const store: Record<string, string> = { 'chat-conversations': chatData }
      const mock: Storage = {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          callCount++
          if (callCount === 1 && key !== 'chat-conversations') {
            throw quotaErr
          }
          // After pruning, allow the retry
          store[key] = value
        }),
        removeItem: vi.fn((key: string) => { delete store[key] }),
        clear: vi.fn(),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
      }

      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })

      const storage = createSafeStorage()
      // Should not throw — prunes and retries
      expect(() => storage.setItem('new-data', 'big payload')).not.toThrow()

      // Verify chat-conversations was pruned (set with <=100 conversations)
      const prunedCalls = (mock.setItem as ReturnType<typeof vi.fn>).mock.calls
        .filter(([k]) => k === 'chat-conversations')
      if (prunedCalls.length > 0) {
        const pruned = JSON.parse(prunedCalls[0][1])
        expect(pruned.state.conversations.length).toBeLessThanOrEqual(100)
      }
    })

    it('re-throws non-QuotaExceeded errors', () => {
      const genericErr = new Error('some other error')
      const mock = createMockStorage({})
      mock.setItem = vi.fn().mockImplementation(() => { throw genericErr })
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })
      const storage = createSafeStorage()
      expect(() => storage.setItem('key', 'value')).toThrow('some other error')
    })

    it('handles localStorage not available gracefully', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        get() { throw new Error('not available') },
        configurable: true,
      })
      const storage = createSafeStorage()
      expect(storage.getItem('key')).toBeNull()
      // Should not throw
      expect(() => storage.setItem('key', 'val')).not.toThrow()
      expect(() => storage.removeItem('key')).not.toThrow()
    })

    it('pruneOldConversations keeps top 100 by updatedAt descending', () => {
      const conversations = Array.from({ length: 120 }, (_, i) => ({
        id: `c-${i}`,
        updatedAt: i * 1000, // 0, 1000, 2000, ... 119000
      }))
      const chatData = JSON.stringify({ state: { conversations } })

      let pruned = false
      const store: Record<string, string> = { 'chat-conversations': chatData }
      const mock: Storage = {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          if (!pruned && key !== 'chat-conversations') {
            pruned = true
            throw new DOMException('full', 'QuotaExceededError')
          }
          store[key] = value
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
      }

      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })

      const storage = createSafeStorage()
      storage.setItem('overflow', 'data')

      // Verify chat-conversations was written with pruned data
      const writeCalls = (mock.setItem as ReturnType<typeof vi.fn>).mock.calls
        .filter(([k]) => k === 'chat-conversations')
      if (writeCalls.length > 0) {
        const parsed = JSON.parse(writeCalls[0][1])
        expect(parsed.state.conversations.length).toBeLessThanOrEqual(100)
        // Newest conversations should be kept (highest updatedAt)
        const ids = idsOf(parsed.state.conversations)
        expect(ids).toContain('c-119')
        expect(ids).toContain('c-119')
      }
    })

    it('does not prune when conversations count is under 100', () => {
      const conversations = Array.from({ length: 50 }, (_, i) => ({
        id: `c-${i}`,
        updatedAt: i * 1000,
      }))
      const chatData = JSON.stringify({ state: { conversations } })

      let setCallCount = 0
      const store: Record<string, string> = { 'chat-conversations': chatData }
      const mock: Storage = {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          setCallCount++
          if (setCallCount === 1 && key !== 'chat-conversations') {
            throw new DOMException('full', 'QuotaExceededError')
          }
          store[key] = value
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
      }

      Object.defineProperty(globalThis, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
      })

      const storage = createSafeStorage()
      // Should not throw, but also should not prune (under 100)
      expect(() => storage.setItem('overflow', 'data')).not.toThrow()
    })

    // ─── §20: memory-prune fallback + quota-exceeded UI event ───

    it('prunes lowest-value memories and retries when conversations are not over cap', () => {
      // No conversations to prune (so the conv path is a no-op), but a fat
      // memory store with >500 entries. The retry should succeed after the
      // memory prune writes a trimmed list.
      const entries = Array.from({ length: 600 }, (_, i) => ({
        id: `m-${i}`,
        type: 'fact',
        title: `t${i}`,
        description: '',
        content: 'x',
        tags: [],
        createdAt: i * 1000,
        updatedAt: i * 1000,
        source: 'manual',
      }))
      const memData = JSON.stringify({ state: { entries, settings: {}, lastSynced: 0 }, version: 3 })

      let firstWriteFailed = false
      const store: Record<string, string> = { 'locally-uncensored-memory': memData }
      const mock: Storage = {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          // First write of the *target* key fails (quota); everything after
          // the memory prune succeeds.
          if (!firstWriteFailed && key === 'new-data') {
            firstWriteFailed = true
            throw new DOMException('full', 'QuotaExceededError')
          }
          store[key] = value
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
      }
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock, writable: true, configurable: true,
      })

      const storage = createSafeStorage()
      expect(() => storage.setItem('new-data', 'payload')).not.toThrow()

      // Memory store was rewritten with <= 500 entries…
      const memWrites = (mock.setItem as ReturnType<typeof vi.fn>).mock.calls
        .filter(([k]) => k === 'locally-uncensored-memory')
      expect(memWrites.length).toBeGreaterThan(0)
      const pruned = JSON.parse(memWrites[memWrites.length - 1][1])
      expect(pruned.state.entries.length).toBeLessThanOrEqual(500)
      // …keeping the newest entries (highest updatedAt) and dropping the oldest.
      const ids: string[] = idsOf(pruned.state.entries)
      expect(ids).toContain('m-599')
      expect(ids).not.toContain('m-0')
      // The target write eventually landed.
      expect(store['new-data']).toBe('payload')
    })

    it('evicts stale / superseded memories before live ones', () => {
      // 501 entries: index 0 is the NEWEST but is stale; the prune should
      // drop it (stale ranks worst) even though its updatedAt is highest.
      const entries = Array.from({ length: 501 }, (_, i) => ({
        id: `m-${i}`,
        type: 'fact', title: `t${i}`, description: '', content: 'x', tags: [],
        createdAt: i, updatedAt: 100000 - i, source: 'manual',
        ...(i === 0 ? { stale: true } : {}),
      }))
      const memData = JSON.stringify({ state: { entries, settings: {}, lastSynced: 0 }, version: 3 })
      const store: Record<string, string> = { 'locally-uncensored-memory': memData }
      let failed = false
      const mock: Storage = {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          if (!failed && key === 'x') { failed = true; throw new DOMException('full', 'QuotaExceededError') }
          store[key] = value
        }),
        removeItem: vi.fn(), clear: vi.fn(),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
      }
      Object.defineProperty(globalThis, 'localStorage', { value: mock, writable: true, configurable: true })

      createSafeStorage().setItem('x', 'y')

      const memWrites = (mock.setItem as ReturnType<typeof vi.fn>).mock.calls
        .filter(([k]) => k === 'locally-uncensored-memory')
      const pruned = JSON.parse(memWrites[memWrites.length - 1][1])
      const ids: string[] = idsOf(pruned.state.entries)
      // The stale newest entry is the one dropped to get to 500.
      expect(pruned.state.entries.length).toBe(500)
      expect(ids).not.toContain('m-0')
    })

    // ─── REGRESSION (FIX-3): the storage MUST be JSON-wrapped for zustand v5 ───
    // The stores configure `storage: createJSONStorage(() => createSafeStorage())`.
    // Earlier they passed the raw StateStorage, so zustand v5 handed the
    // {state,version} OBJECT to setItem → localStorage.setItem(name, object) →
    // "[object Object]" → chat-conversations + memory never hydrated → wiped on
    // every restart. This asserts the wrapped shape the stores use round-trips an
    // object to VALID JSON (and back), which the raw form cannot.
    it('createJSONStorage(() => createSafeStorage()) round-trips an object as valid JSON (not "[object Object]")', () => {
      const mock = createMockStorage({})
      Object.defineProperty(globalThis, 'localStorage', {
        value: mock, writable: true, configurable: true,
      })
      const wrapped = createJSONStorage(() => createSafeStorage())!
      const value = { state: { conversations: [{ id: 'c1', title: 'hi' }] }, version: 0 }
      wrapped.setItem('chat-conversations', value)

      const raw = globalThis.localStorage.getItem('chat-conversations')
      expect(raw).not.toBe('[object Object]')
      // Must be parseable JSON — the bug stored "[object Object]" which throws here.
      const parsed = JSON.parse(raw as string)
      expect(parsed.state.conversations[0].id).toBe('c1')
      // And getItem hydrates back to the original object (what zustand needs).
      const readBack = wrapped.getItem('chat-conversations')
      expect(at(propPath(readBack, 'state', 'conversations'), 0)).toMatchObject({ title: 'hi' })
    })

    it('dispatches lu:storage-quota-exceeded once when pruning cannot free space', () => {
      // Nothing prunable (no chat-conversations, no memory store), so both
      // prune tiers no-op and the write is genuinely lost — must signal UI.
      // The vitest env is `node`, so there's no real `window`; install a
      // minimal stub that records dispatched events. The production guard
      // (`typeof window !== 'undefined'`) then takes the dispatch path.
      const dispatched: Event[] = []
      const fakeWindow = {
        dispatchEvent: vi.fn((e: Event) => { dispatched.push(e); return true }),
      }
      const hadWindow = 'window' in globalThis
      const prevWindow: unknown = Reflect.get(globalThis, 'window')
      Object.defineProperty(globalThis, 'window', { value: fakeWindow, writable: true, configurable: true })

      const quotaErr = new DOMException('full', 'QuotaExceededError')
      const store: Record<string, string> = {}
      const mock: Storage = {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn(() => { throw quotaErr }),
        removeItem: vi.fn(), clear: vi.fn(),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
      }
      Object.defineProperty(globalThis, 'localStorage', { value: mock, writable: true, configurable: true })

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const storage = createSafeStorage()
        expect(() => storage.setItem('doomed', 'data')).not.toThrow()
        // Exactly one quota event, carrying the failed key.
        expect(fakeWindow.dispatchEvent).toHaveBeenCalledTimes(1)
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0].type).toBe('lu:storage-quota-exceeded')
        expect(prop(dispatched[0], 'detail')).toEqual({ key: 'doomed' })
      } finally {
        warnSpy.mockRestore()
        if (hadWindow) Object.defineProperty(globalThis, 'window', { value: prevWindow, writable: true, configurable: true })
        else Reflect.deleteProperty(globalThis, 'window')
      }
    })
  })
})
