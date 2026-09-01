import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../api/comfyui', () => ({ classifyModel: () => 'unknown' }))

// zustand/persist defaults to `window.localStorage` — in the node test env both
// need shimming BEFORE the store module is imported, or persist silently no-ops.
const backing = new Map<string, string>()
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true })
globalThis.localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size
  },
} as Storage

const KEY = 'create-store'

function seedStorage(state: Record<string, unknown>, version?: number) {
  localStorage.setItem(
    KEY,
    JSON.stringify(version === undefined ? { state } : { state, version })
  )
}

// localStorage is synchronous, so persist hydrates during store creation —
// a fresh import after resetModules picks up whatever the test seeded.
async function freshStore() {
  vi.resetModules()
  const mod = await import('../createStore')
  return mod.useCreateStore
}

describe('createStore persist migration (v0 → v1)', () => {
  beforeEach(() => localStorage.clear())

  it('migrates an unversioned v0 blob with mode "i2i" to image/img2img', async () => {
    seedStorage({ mode: 'i2i', steps: 33 })
    const store = await freshStore()
    expect(store.getState().mode).toBe('image')
    expect(store.getState().imageSubMode).toBe('img2img')
    expect(store.getState().steps).toBe(33)
  })

  it('keeps a v0 blob without i2i untouched and backfills new keys from defaults', async () => {
    seedStorage({ mode: 'video', width: 768 })
    const store = await freshStore()
    const s = store.getState()
    expect(s.mode).toBe('video')
    expect(s.width).toBe(768)
    expect(Array.isArray(s.selectedLoras)).toBe(true)
    expect(typeof s.clipSkip).toBe('number')
  })

  it('never rehydrates runtime-only fields (backend stays local)', async () => {
    seedStorage({ mode: 'image', backend: 'cloud', source: { filename: 'x.png' } }, 1)
    const store = await freshStore()
    expect(store.getState().backend).toBe('local')
    expect(store.getState().source).toBeNull()
  })

  it('writes version 1 back to storage after rehydrate', async () => {
    seedStorage({ mode: 'i2i' })
    const store = await freshStore()
    store.getState().setSteps(21)
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(raw.version).toBe(1)
    expect(raw.state.mode).toBe('image')
  })
})
