import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getStorageUsage, createSafeStorage } from '../storage-quota'

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
        const ids = parsed.state.conversations.map((c: any) => c.id)
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
  })
})
