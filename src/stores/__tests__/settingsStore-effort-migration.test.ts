/**
 * The rung survives the update, and a nonsense rung cannot reach the wire.
 *
 * Two things have to hold for settings.reasoningEffort (2.6.8, store v22):
 *
 *  1. A profile written before the field existed lands on 'high'. That is not a
 *     taste: 'high' is the rung the client already put on the wire for thinking
 *     ON, so an existing customer's request is byte-for-byte what it was and
 *     their token bill does not move because they installed an update.
 *  2. A value outside the four rungs is normalised at the store edge. The field
 *     has a closed set of values; anything else would travel through the whole
 *     app as an unknown word, and the composer would draw a rung that the
 *     provider then does not send.
 *
 * Driven black-box like settingsStore-cloud-confirm-optin: seed a versioned
 * blob, fresh-import the store, assert what the user actually gets.
 *
 * Run: npx vitest run src/stores/__tests__/settingsStore-effort-migration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { clampEffort } from '../../lib/effort'

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
/** The version that shipped 2.6.7, one below the rung. */
const BEFORE_THE_RUNG = 21
/** Must track STORE_VERSION: at this version zustand skips migrate. */
const CURRENT = 22

function seed(settings: Record<string, unknown>, version: number) {
  backing.set(
    KEY,
    JSON.stringify({
      state: { settings, personas: [], activePersonaId: 'unrestricted', _version: version },
      version,
    })
  )
}

async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('localStorage', localStorageShim)
  const mod = await import('../settingsStore')
  return mod.useSettingsStore
}

describe('the rung reaches existing profiles without moving anyone bill', () => {
  beforeEach(() => backing.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('THE DECISION: a v21 profile without the field lands on high', async () => {
    seed({ thinkingEnabled: true, temperature: 0.42 }, BEFORE_THE_RUNG)
    const s = (await freshStore()).getState().settings
    expect(s.reasoningEffort).toBe('high')
    // Unrelated settings survive the migration, as they always have.
    expect(s.temperature).toBe(0.42)
    expect(s.thinkingEnabled).toBe(true)
  })

  it('and high is exactly what the client sent before the field existed', async () => {
    seed({ thinkingEnabled: true }, BEFORE_THE_RUNG)
    const s = (await freshStore()).getState().settings
    // No ladder is the state of every model on a server that predates 2.6.8,
    // and there the rung resolves to the old fixed value whatever is stored.
    expect(clampEffort(undefined, s.reasoningEffort)).toBe('high')
  })

  it('a rung the user really chose is preserved across the migration', async () => {
    seed({ reasoningEffort: 'low' }, BEFORE_THE_RUNG)
    expect((await freshStore()).getState().settings.reasoningEffort).toBe('low')
  })

  it('a foreign value is normalised to high, not carried into the app', async () => {
    seed({ reasoningEffort: 'bogus' }, BEFORE_THE_RUNG)
    expect((await freshStore()).getState().settings.reasoningEffort).toBe('high')
  })

  it('including at the CURRENT version, where the migration never runs', async () => {
    // zustand swaps the persisted settings object in wholesale here, so the
    // merge cannot be the only guard. This is the case that made
    // onRehydrateStorage necessary.
    seed({ reasoningEffort: 'bogus' }, CURRENT)
    expect((await freshStore()).getState().settings.reasoningEffort).toBe('high')
  })

  it('and an off value is foreign too, it is not a rung', async () => {
    seed({ reasoningEffort: 'none' }, CURRENT)
    expect((await freshStore()).getState().settings.reasoningEffort).toBe('high')
    backing.clear()
    seed({ reasoningEffort: 'minimal' }, CURRENT)
    expect((await freshStore()).getState().settings.reasoningEffort).toBe('high')
  })

  it('a profile that predates the key at all gets the same answer', async () => {
    seed({ temperature: 0.7 }, 15)
    expect((await freshStore()).getState().settings.reasoningEffort).toBe('high')
  })
})
