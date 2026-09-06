/**
 * v21: the cloud shell confirm becomes an opt-in that ships OFF (David
 * 2026-08-22, replacing G15a). This store writes the WHOLE settings object to
 * disk, so every profile out there already has `codexCloudConfirmShell: true`
 * materialised and a flipped default would never have reached a single
 * existing user. The flip therefore rides a NEW key, not a one-shot reset of
 * the old one, because R1's downgrade contract forbids one-shot resets while
 * 2.6.5 and 2.6.6 share one WebView profile and re-run this migration on every
 * build switch.
 *
 * Driven black-box like settingsStore-migrate-mac-appmode: seed a versioned
 * blob, fresh-import the store, assert what the user actually gets.
 *
 * Run: npx vitest run src/stores/__tests__/settingsStore-cloud-confirm-optin.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { codexConfirmEnabled } from '../../hooks/codexShellGate'

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
/** Must track STORE_VERSION in settingsStore.ts: the case below needs a blob
 *  that zustand does NOT migrate, and that is only true at the current
 *  version. Bumped to 22 with the reasoningEffort field (2.6.8). */
const CURRENT = 22
/** What a 2.6.5 build stamps back into the shared profile. */
const OLD_BUILD = 20

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

describe('the cloud confirm opt-in reaches existing profiles, not just fresh installs', () => {
  beforeEach(() => backing.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('THE DECISION: a profile carrying the old materialised true still lands on the opt-in off', async () => {
    seed({ codexCloudConfirmShell: true, temperature: 0.42 }, OLD_BUILD)
    const s = (await freshStore()).getState().settings
    expect(s.codexCloudConfirmOptIn).toBe(false)
    // Unrelated settings survive the migration.
    expect(s.temperature).toBe(0.42)
  })

  it('the retired key is never read again, whatever it says on disk', async () => {
    seed({ codexCloudConfirmShell: true, codexConfirmShell: false }, OLD_BUILD)
    const s = (await freshStore()).getState().settings
    expect(s.codexCloudConfirmOptIn).toBe(false)
    expect(codexConfirmEnabled({
      confirmShell: s.codexConfirmShell,
      cloudOptIn: s.codexCloudConfirmOptIn,
      providerId: 'lu-cloud',
    })).toBe(false)
  })

  it('fails safe: a blob the merge never ran on has the key undefined, which is not an opt-in', async () => {
    // Only reachable at the same store version, where zustand skips migrate
    // and swaps the settings object in wholesale. The gate reads `=== true`,
    // so undefined lands on the new policy rather than the old one.
    seed({ codexCloudConfirmShell: true }, CURRENT)
    const s = (await freshStore()).getState().settings
    expect(s.codexCloudConfirmOptIn).toBeUndefined()
    expect(codexConfirmEnabled({
      confirmShell: false,
      cloudOptIn: s.codexCloudConfirmOptIn,
      providerId: 'lu-cloud',
    })).toBe(false)
  })

  it('a profile that predates the key at all gets the new default', async () => {
    seed({ temperature: 0.7 }, 15)
    const s = (await freshStore()).getState().settings
    expect(s.codexCloudConfirmOptIn).toBe(false)
  })

  it('NO one-shot reset: an opt-in survives the 2.6.5 / 2.6.6 A/B switch', async () => {
    // The old build stamps its own version back, so this migration runs again
    // on the next 2.6.6 start. A reset here would quietly wipe the opt-in
    // every single time the user changed builds.
    seed({ codexCloudConfirmOptIn: true }, OLD_BUILD)
    const s = (await freshStore()).getState().settings
    expect(s.codexCloudConfirmOptIn).toBe(true)
  })

  it('and it survives however often the migration re-runs', async () => {
    seed({ codexCloudConfirmOptIn: true }, OLD_BUILD)
    for (let i = 0; i < 3; i++) {
      const store = await freshStore()
      expect(store.getState().settings.codexCloudConfirmOptIn).toBe(true)
      seed({ ...store.getState().settings }, OLD_BUILD)
    }
  })

  it('a fresh install starts opted out', async () => {
    const s = (await freshStore()).getState().settings
    expect(s.codexCloudConfirmOptIn).toBe(false)
  })
})
