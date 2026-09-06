/**
 * createSafeStorage has to be wired to the stores that can hit the quota.
 *
 * M4/5: it was wired to NOTHING. Every localStorage store used zustand's
 * default backend, whose setItem runs synchronously inside `api.setState` — so
 * a QuotaExceededError did not fail a save, it threw out of the store action
 * and out of the React handler that called it. Both prune tiers and
 * StorageQuotaToast were unreachable code guarding a door nobody used.
 *
 * Run: npx vitest run src/lib/__tests__/storage-quota-wiring.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const STORES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../stores')
const loaders = import.meta.glob('../../stores/*.ts')

type Persisted = {
  persist: { getOptions: () => { name?: string; storage?: { setItem: (n: string, v: unknown) => unknown } } }
}

function isPersisted(value: unknown): value is Persisted {
  const p = (value as { persist?: { getOptions?: unknown } } | null)?.persist
  return !!p && typeof p.getOptions === 'function'
}

/**
 * Stores whose writes cannot reach React synchronously and so cannot be the
 * crash this test is about:
 *   - anything on idbStorage (chat history, memories, staged changes)
 *   - anything behind coalescedJSONStorage, which defers the write to a timer
 *     and catches its own failures (downloadStore)
 */
function isSyncLocalStorageStore(file: string): boolean {
  const src = readFileSync(join(STORES_DIR, file), 'utf8')
  return !/idbStorage/.test(src) && !/coalescedJSONStorage/.test(src)
}

/**
 * The one store still on the raw backend. It is outside this change's file
 * package (another workstream owns codexStore.ts this cycle), and it is named
 * here so that wiring it makes this list wrong and this test say so.
 */
const KNOWN_UNWIRED = ['locally-uncensored-codex']

function throwingLocalStorage() {
  return {
    getItem: () => null,
    setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
    removeItem: () => {},
    clear: () => {},
    get length() { return 0 },
    key: () => null,
  }
}

describe('quota-safe storage is actually wired up', () => {
  const quotaEvents: string[] = []

  beforeEach(() => {
    quotaEvents.length = 0
    vi.stubGlobal('window', {
      dispatchEvent: (e: { type: string }) => { quotaEvents.push(e.type); return true },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('no localStorage-backed store lets QuotaExceededError escape into the caller', async () => {
    const escaped: string[] = []
    const stillUnwired: string[] = []

    for (const [path, load] of Object.entries(loaders)) {
      const file = path.split('/').pop()!
      if (!isSyncLocalStorageStore(file)) continue
      const mod = (await load()) as Record<string, unknown>
      for (const value of Object.values(mod)) {
        if (!isPersisted(value)) continue
        const { name, storage } = value.persist.getOptions()
        if (!name || !storage) continue

        vi.stubGlobal('localStorage', throwingLocalStorage())
        let threw = false
        try {
          storage.setItem(name, { state: {}, version: 0 })
        } catch {
          threw = true
        }
        if (threw) (KNOWN_UNWIRED.includes(name) ? stillUnwired : escaped).push(`${file}: ${name}`)
      }
    }

    expect(escaped).toEqual([])
    // If this fails, someone wired the last store — delete it from KNOWN_UNWIRED.
    expect(stillUnwired.map((s) => s.split(': ')[1])).toEqual(KNOWN_UNWIRED)
  })

  it('a dropped write reaches the toast instead of vanishing', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', throwingLocalStorage())
    const { createSafeStorage } = await import('../storage-quota')

    createSafeStorage().setItem('chat-settings', '{"state":{}}')

    // StorageQuotaToast listens for exactly this event; before the wiring it
    // could never fire because nothing dispatched from a real store write.
    expect(quotaEvents).toContain('lu:storage-quota-exceeded')
  })

  it('a real store write also reaches the toast', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', throwingLocalStorage())
    const { useUIStore } = await import('../../stores/uiStore')

    expect(() => useUIStore.getState().setExplorerCollapsed(true)).not.toThrow()
    expect(quotaEvents).toContain('lu:storage-quota-exceeded')
  })

  it('an error that is NOT a quota error still propagates', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new TypeError('something else entirely') },
      removeItem: () => {},
    })
    const { createSafeStorage } = await import('../storage-quota')

    expect(() => createSafeStorage().setItem('k', 'v')).toThrow(TypeError)
  })
})
