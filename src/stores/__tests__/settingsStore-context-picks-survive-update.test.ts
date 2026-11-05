/**
 * GH #201: "the saved context picks of both models had fallen back to Auto"
 * after an update. A pick made in the context menu is the user's word about
 * their hardware and must ride every update untouched: the Ollama num_ctx
 * (contextWindowOverride), the per model picks of LM Studio and of a custom
 * server (contextWindowByModel), the LU Engine's ctx and the cloud send
 * windows.
 *
 * (The loss reported for 3.0.6 to 3.0.7 was the move of LM Studio's pick out
 * of the shared Ollama number into its own key, GH #168, which on purpose
 * carried nothing over. Since then the key is stable, and this file holds
 * every profile shape an update can meet to it.)
 *
 * Driven black-box: seed a versioned blob, fresh-import the store, read what
 * the user gets, write it back and load it once more, as the next start does.
 *
 * Run: npx vitest run src/stores/__tests__/settingsStore-context-picks-survive-update.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const backing = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size
  },
} as Storage

const KEY = 'chat-settings'

const PICKS = {
  contextWindowOverride: 262144,
  contextWindowByModel: {
    'lmstudio|gemma-4-31b-it-2': 262144,
    'http://192.168.1.20:5001/v1|gemma-4-31B-it-UD-Q8_K_XL': 262144,
  },
  cloudSendWindowByModel: { 'lu-cloud::qwen3.6-plus': 131072 },
  builtinEngine: { ctx: 65536, ctxChosen: true },
}

function seed(settings: Record<string, unknown>, version: number) {
  backing.set(KEY, JSON.stringify({
    state: { settings, personas: [], activePersonaId: 'unrestricted', _version: version },
    version,
  }))
}

async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('localStorage', localStorageShim)
  const mod = await import('../settingsStore')
  return mod.useSettingsStore
}

function expectPicks(s: Record<string, unknown>) {
  expect(s.contextWindowOverride).toBe(262144)
  expect(s.contextWindowByModel).toEqual(PICKS.contextWindowByModel)
  expect(s.cloudSendWindowByModel).toEqual(PICKS.cloudSendWindowByModel)
  expect((s.builtinEngine as { ctx: number; ctxChosen: boolean }).ctx).toBe(65536)
  expect((s.builtinEngine as { ctx: number; ctxChosen: boolean }).ctxChosen).toBe(true)
}

describe('GH #201: the context picks survive an update', () => {
  beforeEach(() => backing.clear())
  afterEach(() => vi.unstubAllGlobals())

  // 21: 2.6.7, 22: 2.6.8 to 3.0.6, 23: 3.0.7 and 3.0.8 (the current version,
  // where zustand skips migrate and only onRehydrateStorage runs).
  for (const version of [21, 22, 23]) {
    it(`a profile written at store version ${version} keeps every pick`, async () => {
      seed({ ...PICKS, temperature: 0.7 }, version)
      const store = await freshStore()
      expectPicks(store.getState().settings as unknown as Record<string, unknown>)

      // The next start reads what this one wrote.
      store.getState().updateSettings({ temperature: 0.71 })
      const again = await freshStore()
      expectPicks(again.getState().settings as unknown as Record<string, unknown>)
    })
  }

  it('a fresh install starts on Auto everywhere, so the tests above prove a kept value', async () => {
    const s = (await freshStore()).getState().settings
    expect(s.contextWindowOverride).toBe(0)
    expect(s.contextWindowByModel ?? {}).toEqual({})
  })
})
