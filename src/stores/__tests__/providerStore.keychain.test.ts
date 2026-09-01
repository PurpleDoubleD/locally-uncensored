import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// H5: provider API keys move to the OS keychain on Win/macOS, with a
// localStorage fallback (Linux + web build). These tests mock the Rust
// secret_* bridge and the client cache, then exercise hydrateProviderKeys,
// setProviderApiKey, migration, and the localStorage-strip via partialize.
//
// `keychainReady` is module-level state, so each case re-imports the store
// fresh (vi.resetModules) to start from a clean "not yet probed" flag.

const { secretGet, secretSet, secretDelete } = vi.hoisted(() => ({
  secretGet: vi.fn(),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

// Audit W-T2: Pfadanpassung — clearProviderCache wohnt jetzt in
// providers/client-cache.ts (siehe dort). Gleiche Attrappe, gleicher Zweck.
vi.mock('../../api/providers/client-cache', () => ({ clearProviderCache: vi.fn() }))
vi.mock('../../api/backend', () => ({ secretGet, secretSet, secretDelete }))

async function freshStore() {
  vi.resetModules()
  const mod = await import('../providerStore')
  return mod.useProviderStore
}

const obf = (k: string) => btoa(k.split('').reverse().join(''))

// The default vitest env here is 'node' (no DOM). zustand persist reads
// `window.localStorage` (createJSONStorage default), so install a Map-backed
// store on BOTH `localStorage` and `window.localStorage` (same map) BEFORE the
// store module loads — otherwise persist silently no-ops and the localStorage
// assertions below pass trivially.
function installLocalStorage() {
  const map = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  vi.stubGlobal('localStorage', ls)
  vi.stubGlobal('window', { localStorage: ls })
}

describe('providerStore keychain (H5)', () => {
  beforeEach(() => {
    secretGet.mockReset()
    secretSet.mockReset()
    secretDelete.mockReset()
    installLocalStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals() // restore window/localStorage so other test files are unaffected
  })

  it('no keychain (secret_get rejects on first probe) → stays on localStorage, never writes the vault', async () => {
    secretGet.mockRejectedValue(new Error('keychain unavailable (web build)'))
    const useStore = await freshStore()
    await useStore.getState().hydrateProviderKeys()

    useStore.getState().setProviderApiKey('anthropic', 'sk-test')
    expect(secretSet).not.toHaveBeenCalled()
    // getter still works via the obfuscated localStorage path
    expect(useStore.getState().getProviderApiKey('anthropic')).toBe('sk-test')
  })

  it('loads a key stored in the vault into memory', async () => {
    secretGet.mockImplementation(async (id: string) => (id === 'anthropic' ? 'sk-vault' : null))
    const useStore = await freshStore()
    await useStore.getState().hydrateProviderKeys()
    expect(useStore.getState().getProviderApiKey('anthropic')).toBe('sk-vault')
  })

  it('after hydrate, setProviderApiKey writes the real key to the vault', async () => {
    secretGet.mockResolvedValue(null)
    secretSet.mockResolvedValue(undefined)
    const useStore = await freshStore()
    await useStore.getState().hydrateProviderKeys()

    useStore.getState().setProviderApiKey('openai', 'sk-new')
    expect(secretSet).toHaveBeenCalledWith('openai', 'sk-new')
  })

  it('migrates an existing localStorage key into the vault on hydrate', async () => {
    secretGet.mockResolvedValue(null) // vault empty
    secretSet.mockResolvedValue(undefined)
    const useStore = await freshStore()

    // Seed a key the old way BEFORE hydrate (keychain not yet active).
    useStore.getState().setProviderApiKey('anthropic', 'sk-old-localstorage')
    expect(secretSet).not.toHaveBeenCalled() // not active yet
    secretSet.mockClear()

    await useStore.getState().hydrateProviderKeys()
    expect(secretSet).toHaveBeenCalledWith('anthropic', 'sk-old-localstorage')
  })

  it('after hydrate, partialize strips the key from persisted localStorage', async () => {
    secretGet.mockImplementation(async (id: string) => (id === 'anthropic' ? 'sk-vault' : null))
    secretSet.mockResolvedValue(undefined)
    const useStore = await freshStore()
    await useStore.getState().hydrateProviderKeys()

    const raw = localStorage.getItem('lu-providers') || ''
    expect(raw).not.toContain('sk-vault')
    expect(raw).not.toContain(obf('sk-vault'))
  })

  it('resetProvider deletes the key from the vault when active', async () => {
    secretGet.mockResolvedValue(null)
    secretSet.mockResolvedValue(undefined)
    secretDelete.mockResolvedValue(undefined)
    const useStore = await freshStore()
    await useStore.getState().hydrateProviderKeys()

    useStore.getState().resetProvider('anthropic')
    expect(secretDelete).toHaveBeenCalledWith('anthropic')
  })

  it('does not revert concurrent provider changes made while hydrate awaits the vault', async () => {
    // Locked-keychain scenario: the first secret_get blocks (macOS unlock
    // prompt) while the app keeps running — e.g. useCloudAuth enables the
    // lu-cloud provider. The final set() must overlay only the vault-loaded
    // keys, never replace the providers map with a pre-await snapshot.
    let release!: (value: string | null) => void
    secretGet.mockImplementation((id: string) => {
      if (id === 'ollama') return new Promise<string | null>((resolve) => { release = resolve })
      return Promise.resolve(null)
    })
    const useStore = await freshStore()
    const hydrating = useStore.getState().hydrateProviderKeys()

    // Concurrent write while the first probe is still pending.
    useStore.getState().setProviderConfig('lu-cloud', { enabled: true })
    release('sk-vault-ollama')
    await hydrating

    expect(useStore.getState().providers['lu-cloud'].enabled).toBe(true)
    expect(useStore.getState().getProviderApiKey('ollama')).toBe('sk-vault-ollama')
  })

  it('keeps the obfuscated key in localStorage when the vault WRITE fails (no silent loss on restart)', async () => {
    secretGet.mockResolvedValue(null) // keychain usable but empty
    secretSet.mockRejectedValue(new Error('credential store locked'))
    const useStore = await freshStore()
    await useStore.getState().hydrateProviderKeys() // keychainReady = true

    useStore.getState().setProviderApiKey('anthropic', 'sk-fail-fallback')
    // let the fire-and-forget secretSet rejection + the fallback re-persist settle
    await new Promise((r) => setTimeout(r, 0))

    const raw = localStorage.getItem('lu-providers') || ''
    expect(raw).toContain(obf('sk-fail-fallback')) // retained as fallback, NOT stripped
    expect(useStore.getState().getProviderApiKey('anthropic')).toBe('sk-fail-fallback')
  })
})
