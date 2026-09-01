/**
 * Persist backend must recover from a failed IndexedDB open (2026-07-28)
 *
 * getDB() cached the promise it returned — including a REJECTED one. A single
 * transient open failure (a second window blocking an upgrade, a busy profile
 * directory) therefore poisoned every later read and write for the rest of the
 * session: chat history quietly stopped being saved until the app restarted.
 *
 * Run: npx vitest run src/lib/__tests__/idbStorage-retry.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type OpenReq = {
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onblocked: (() => void) | null
  onupgradeneeded: (() => void) | null
  /** The opened database — a stand-in for IDBDatabase, only what idbStorage reads. */
  result: unknown
  error: unknown
}

/** Minimal fake IDB: `failures` opens reject, everything after succeeds. */
function fakeIndexedDB(failures: number, data: Record<string, string>) {
  let opens = 0
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => {
          const r: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: string | undefined } =
            { onsuccess: null, onerror: null, result: data[k] }
          queueMicrotask(() => r.onsuccess?.())
          return r
        },
        put: (v: string, k: string) => {
          data[k] = v
          return {}
        },
        delete: (k: string) => {
          delete data[k]
          return {}
        },
      }),
      set oncomplete(fn: () => void) {
        queueMicrotask(fn)
      },
      set onerror(_fn: () => void) {},
      set onabort(_fn: () => void) {},
    }),
  }
  return {
    opens: () => opens,
    open: () => {
      opens++
      const req: OpenReq = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        result: db,
        error: new Error('open failed'),
      }
      const shouldFail = opens <= failures
      queueMicrotask(() => (shouldFail ? req.onerror?.() : req.onsuccess?.()))
      return req
    },
  }
}

/** The vitest env is node — no DOM storage. */
function fakeLocalStorage() {
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  }
}

describe('idbStorage after a failed open', () => {
  let ls: ReturnType<typeof fakeLocalStorage>

  beforeEach(() => {
    vi.resetModules()
    ls = fakeLocalStorage()
    vi.stubGlobal('localStorage', ls)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens again on the next call instead of failing forever', async () => {
    const data: Record<string, string> = { 'chat-conversations': '{"kept":true}' }
    const fake = fakeIndexedDB(1, data)
    vi.stubGlobal('indexedDB', fake)

    const { idbStorage } = await import('../idbStorage')

    // First read hits the failing open and degrades to localStorage (empty).
    const first = await idbStorage.getItem('chat-conversations')
    expect(first).toBeNull()

    // Second read must open a NEW connection, not reuse the rejected promise.
    const second = await idbStorage.getItem('chat-conversations')
    expect(second).toBe('{"kept":true}')
    expect(fake.opens()).toBe(2)
  })

  it('writes reach IndexedDB again after a failed open', async () => {
    const data: Record<string, string> = {}
    const fake = fakeIndexedDB(1, data)
    vi.stubGlobal('indexedDB', fake)

    const { idbStorage } = await import('../idbStorage')

    await idbStorage.setItem('chat-conversations', 'first')
    // The failed open pushed this into localStorage.
    expect(ls.getItem('chat-conversations')).toBe('first')

    await idbStorage.setItem('chat-conversations', 'second')
    expect(data['chat-conversations']).toBe('second')
  })
})
