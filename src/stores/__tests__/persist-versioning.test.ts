/**
 * What zustand's persist `version` / `migrate` actually guarantees.
 *
 * The 2.6.8 audit asked for `version: 1` + a no-op migrate on every store that
 * has neither, on the premise that an unversioned store writes NO version, so a
 * later `version: 1` would find `undefined` and skip the migration for every
 * existing user. Against the vendored zustand (5.0.12) that premise is false —
 * the first three tests here are the proof, run against the real library rather
 * than quoted from it — and acting on it would have cost a real regression:
 * an older build reading a version-1 blob discards the persisted state, which
 * is the R1 DOWNGRADE-KONTRAKT (see codexStore) while 2.6.x builds share one
 * WebView profile.
 *
 * The invariant that IS worth enforcing is the pair: a store that declares a
 * version must declare a migrate, because that is the one combination that
 * throws the user's data away on a mismatch.
 *
 * Run: npx vitest run src/stores/__tests__/persist-versioning.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

function memoryStorage() {
  const mem = new Map<string, string>()
  return {
    mem,
    api: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
  }
}

describe('zustand persist versioning, measured not assumed', () => {
  it('a store that declares NO version still writes version 0 into the blob', () => {
    const { mem, api } = memoryStorage()
    const s = create<{ n: number; bump: () => void }>()(persist((set) => ({
      n: 0,
      bump: () => set((x) => ({ n: x.n + 1 })),
    }), { name: 'unversioned', storage: createJSONStorage(() => api as never) }))

    s.getState().bump()
    expect(JSON.parse(mem.get('unversioned')!).version).toBe(0)
  })

  it('a version-0 blob DOES reach a migrate later declared at version 1', () => {
    // This is the audit's claim, inverted: nothing is skipped, because 0 is a
    // number and 0 !== 1.
    const { mem, api } = memoryStorage()
    mem.set('later', JSON.stringify({ state: { n: 7 }, version: 0 }))
    const seen: number[] = []

    const s = create<{ n: number }>()(persist(() => ({ n: 0 }), {
      name: 'later',
      version: 1,
      storage: createJSONStorage(() => api as never),
      migrate: (p, v) => { seen.push(v); return p as { n: number } },
    }))

    expect(seen).toEqual([0])
    expect(s.getState().n).toBe(7)
  })

  it('an older build without a version DISCARDS a version-1 blob', () => {
    // Why the bump is not free. The old build defaults to version 0, sees 1,
    // has no migrate to call, and hydrates from defaults — every setting gone.
    const { mem, api } = memoryStorage()
    mem.set('downgrade', JSON.stringify({ state: { n: 7 }, version: 1 }))

    const s = create<{ n: number }>()(persist(() => ({ n: 0 }), {
      name: 'downgrade',
      storage: createJSONStorage(() => api as never),
    }))

    expect(s.getState().n).toBe(0) // the 7 is gone
  })

  it('the same downgrade keeps the state when a migrate exists', () => {
    const { mem, api } = memoryStorage()
    mem.set('safe', JSON.stringify({ state: { n: 7 }, version: 1 }))

    const s = create<{ n: number }>()(persist(() => ({ n: 0 }), {
      name: 'safe',
      storage: createJSONStorage(() => api as never),
      migrate: (p) => p as { n: number },
    }))

    expect(s.getState().n).toBe(7)
  })
})

const STORES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const loaders = import.meta.glob('../*.ts')

type PersistOptions = { name?: string; version?: number; migrate?: unknown }
type PersistedStore = { persist: { getOptions: () => PersistOptions } }

function isPersisted(value: unknown): value is PersistedStore {
  const p = (value as { persist?: { getOptions?: unknown } } | null)?.persist
  return !!p && typeof p.getOptions === 'function'
}

async function allPersistOptions(): Promise<{ file: string; opts: PersistOptions }[]> {
  const out: { file: string; opts: PersistOptions }[] = []
  for (const [path, load] of Object.entries(loaders)) {
    const mod = (await load()) as Record<string, unknown>
    for (const value of Object.values(mod)) {
      if (isPersisted(value)) out.push({ file: path.split('/').pop()!, opts: value.persist.getOptions() })
    }
  }
  return out
}

describe('every store that declares a version declares a migrate', () => {
  it('has no version-without-migrate anywhere in src/stores', async () => {
    const all = await allPersistOptions()
    expect(all.length).toBeGreaterThan(20)

    // getOptions() hands back the DEFAULTED options, where an undeclared
    // version reads as 0 — indistinguishable from a deliberate 0. So the
    // "declares" half has to come from the source; the "has a migrate" half is
    // structural, straight off the live store.
    const orphans: string[] = []
    for (const { file, opts } of all) {
      const src = readFileSync(join(STORES_DIR, file), 'utf8')
      const declaresVersion = /\n\s{2,}version:\s*\S/.test(src)
      if (declaresVersion && typeof opts.migrate !== 'function') {
        orphans.push(`${file} (${opts.name}) declares a version with no migrate`)
      }
    }

    expect(orphans).toEqual([])
  })

  it('lu-providers specifically — it declared version 1 with no migrate', async () => {
    const all = await allPersistOptions()
    const providers = all.find(({ opts }) => opts.name === 'lu-providers')
    expect(providers).toBeTruthy()
    expect(typeof providers!.opts.migrate).toBe('function')
  })
})
