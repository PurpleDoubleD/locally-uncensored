/**
 * The CivitAI API key belongs in the OS vault, like every other secret.
 *
 * The field added for goonerforporn wrote the key into localStorage in plain
 * text, while provider keys (providerStore, security fix H5) and the
 * HuggingFace token (MlxMediaSettings) already sit in Windows Credential
 * Manager or the macOS Keychain. Same shape here, same limits: Linux desktop
 * and the web build have no uniform vault and keep the localStorage path.
 *
 * `civitaiVaultReady` is module state, so every case re-imports the store
 * (vi.resetModules) to start from "not yet probed".
 *
 * Run: npx vitest run src/stores/__tests__/civitai-key-keychain.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { secretGet, secretSet, secretDelete } = vi.hoisted(() => ({
  secretGet: vi.fn(),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../api/backend', () => ({ secretGet, secretSet, secretDelete }))

async function freshStore() {
  vi.resetModules()
  return await import('../workflowStore')
}

// The default env here is node, and zustand persist reads
// `window.localStorage`. Without a stand-in the persistence assertions below
// would pass trivially.
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

const KEY = 'civitai-key-abcdef'

beforeEach(() => {
  secretGet.mockReset()
  secretSet.mockReset()
  secretDelete.mockReset()
  installLocalStorage()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the CivitAI key in the OS vault', () => {
  it('reads the key back out of the vault at boot', async () => {
    secretGet.mockResolvedValue(KEY)
    const { useWorkflowStore, hydrateCivitaiApiKey, CIVITAI_KEY_ACCOUNT } = await freshStore()
    await hydrateCivitaiApiKey()
    expect(secretGet).toHaveBeenCalledWith(CIVITAI_KEY_ACCOUNT)
    expect(useWorkflowStore.getState().civitaiApiKey).toBe(KEY)
  })

  it('moves a key that is still in localStorage into the vault, once', async () => {
    secretGet.mockResolvedValue(null)
    secretSet.mockResolvedValue(undefined)
    const { useWorkflowStore, hydrateCivitaiApiKey, CIVITAI_KEY_ACCOUNT } = await freshStore()
    useWorkflowStore.setState({ civitaiApiKey: 'from-the-old-build' })
    await hydrateCivitaiApiKey()
    expect(secretSet).toHaveBeenCalledWith(CIVITAI_KEY_ACCOUNT, 'from-the-old-build')
    // And the plaintext copy stops being persisted.
    const raw = localStorage.getItem('workflow-store') || ''
    expect(raw).not.toContain('from-the-old-build')
  })

  it('writes every later edit to the vault and removes it when cleared', async () => {
    secretGet.mockResolvedValue(null)
    secretSet.mockResolvedValue(undefined)
    secretDelete.mockResolvedValue(undefined)
    const { useWorkflowStore, hydrateCivitaiApiKey, CIVITAI_KEY_ACCOUNT } = await freshStore()
    await hydrateCivitaiApiKey()

    useWorkflowStore.getState().setCivitaiApiKey('  typed-by-hand  ')
    expect(useWorkflowStore.getState().civitaiApiKey).toBe('typed-by-hand')
    expect(secretSet).toHaveBeenCalledWith(CIVITAI_KEY_ACCOUNT, 'typed-by-hand')
    expect(localStorage.getItem('workflow-store') || '').not.toContain('typed-by-hand')

    useWorkflowStore.getState().setCivitaiApiKey('')
    expect(secretDelete).toHaveBeenCalledWith(CIVITAI_KEY_ACCOUNT)
  })

  // Negative control 1: a host without a vault must behave exactly as it did.
  // Dropping the key there would lose it, not protect it.
  it('no vault: stays on localStorage and never writes one', async () => {
    secretGet.mockRejectedValue(new Error('keychain unavailable (web build)'))
    const { useWorkflowStore, hydrateCivitaiApiKey } = await freshStore()
    await hydrateCivitaiApiKey()
    useWorkflowStore.getState().setCivitaiApiKey(KEY)

    expect(secretSet).not.toHaveBeenCalled()
    expect(secretDelete).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().civitaiApiKey).toBe(KEY)
    expect(localStorage.getItem('workflow-store') || '').toContain(KEY)
  })

  // Negative control 2: a vault that accepts the probe but refuses the write
  // (locked, full, policy) must keep the localStorage copy, or the key would
  // vanish on the next restart with nothing left to read.
  it('a failed vault write keeps the key in localStorage', async () => {
    secretGet.mockResolvedValue(null)
    secretSet.mockRejectedValue(new Error('keychain locked'))
    const { useWorkflowStore, hydrateCivitaiApiKey } = await freshStore()
    await hydrateCivitaiApiKey()

    useWorkflowStore.getState().setCivitaiApiKey(KEY)
    await new Promise((r) => setTimeout(r, 0))
    // One more write so partialize runs again with the failure flag set.
    useWorkflowStore.getState().setCivitaiApiKey(KEY)
    await new Promise((r) => setTimeout(r, 0))

    expect(useWorkflowStore.getState().civitaiApiKey).toBe(KEY)
    expect(localStorage.getItem('workflow-store') || '').toContain(KEY)
  })

  // Negative control 3: the rest of the store keeps being persisted. A
  // partialize that dropped more than the key would lose the user's workflows.
  it('everything else in the store is still persisted', async () => {
    secretGet.mockResolvedValue(KEY)
    const { useWorkflowStore, hydrateCivitaiApiKey } = await freshStore()
    await hydrateCivitaiApiKey()
    useWorkflowStore.getState().setCivitaiHost('civitai.red')

    const raw = localStorage.getItem('workflow-store') || ''
    expect(raw).toContain('civitai.red')
    expect(raw).not.toContain(KEY)
  })
})
