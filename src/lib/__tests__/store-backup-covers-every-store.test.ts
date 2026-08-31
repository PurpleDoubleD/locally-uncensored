/**
 * Every persisted store must be in the appData backup key list.
 *
 * M4/2: `staged-changes` — approved code edits that are not on disk yet — was
 * persisted to IndexedDB and listed in NEITHER key list, so the NSIS/WebView2
 * wipe that store_backup.json exists to survive destroyed it anyway. So did
 * `locally-uncensored-todos`, `locally-uncensored-ui`, `lu_release_notes` and
 * `locally-uncensored-downloads`. A prose list nobody checks drifts the moment
 * somebody adds a store, which is exactly what happened.
 *
 * This asks zustand what each store actually persists rather than reading the
 * source, so a renamed key or a new store fails here instead of silently not
 * surviving an update.
 *
 * Run: npx vitest run src/lib/__tests__/store-backup-covers-every-store.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { STORE_KEYS, IDB_STORE_KEYS } from '../store-backup'

const HERE = dirname(fileURLToPath(import.meta.url))
const STORES_DIR = join(HERE, '../../stores')

const loaders = import.meta.glob('../../stores/*.ts')

type PersistedStore = { persist: { getOptions: () => { name?: string } } }

function isPersisted(value: unknown): value is PersistedStore {
  const p = (value as { persist?: { getOptions?: unknown } } | null)?.persist
  return !!p && typeof p.getOptions === 'function'
}

/** file basename -> the persist keys that file declares. */
async function persistKeysByFile(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const [path, load] of Object.entries(loaders)) {
    const mod = (await load()) as Record<string, unknown>
    const names: string[] = []
    for (const value of Object.values(mod)) {
      if (!isPersisted(value)) continue
      const name = value.persist.getOptions().name
      if (name) names.push(name)
    }
    if (names.length > 0) out.set(path.split('/').pop()!, names)
  }
  return out
}

describe('the appData backup covers every persisted store', () => {
  it('lists every persist key that exists in src/stores', async () => {
    const byFile = await persistKeysByFile()
    const missing: string[] = []
    for (const [file, names] of byFile) {
      for (const name of names) {
        if (!STORE_KEYS.includes(name)) missing.push(`${file}: ${name}`)
      }
    }
    expect(missing).toEqual([])
    // Sanity: the walk has to actually find stores, or the assertion above is
    // vacuously true and this file guards nothing.
    expect(byFile.size).toBeGreaterThan(20)
  })

  it('names the four keys the 2.6.8 audit found missing', async () => {
    // Spelled out so a future "tidy-up" of the list cannot quietly drop them
    // again — each one is a real loss report, not a hypothetical.
    for (const key of [
      'staged-changes',            // approved edits not yet on disk (Morgan)
      'locally-uncensored-todos',  // the plan a long run is working through
      'locally-uncensored-ui',
      'lu_release_notes',
      'locally-uncensored-downloads', // which model bundles are installed
    ]) {
      expect(STORE_KEYS).toContain(key)
    }
  })

  it('routes every IndexedDB-backed store through IDB_STORE_KEYS', async () => {
    // A key backed by IndexedDB but absent from IDB_STORE_KEYS is read from
    // localStorage by the snapshot builder, where the 2.5.0 migration deleted
    // it — so it backs up as "empty" and restores as nothing.
    const byFile = await persistKeysByFile()
    const wrong: string[] = []
    for (const [file, names] of byFile) {
      const src = readFileSync(join(STORES_DIR, file), 'utf8')
      const backedByIdb = /from '\.\.\/lib\/idbStorage'/.test(src)
      for (const name of names) {
        if (backedByIdb && !IDB_STORE_KEYS.has(name)) wrong.push(`${file}: ${name} is on IndexedDB but not in IDB_STORE_KEYS`)
        if (!backedByIdb && IDB_STORE_KEYS.has(name)) wrong.push(`${file}: ${name} is in IDB_STORE_KEYS but not on IndexedDB`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('keeps IDB_STORE_KEYS a subset of STORE_KEYS', () => {
    // An IDB key that is not in STORE_KEYS is never visited by the snapshot
    // loop at all, so the IDB branch would never run for it.
    for (const key of IDB_STORE_KEYS) expect(STORE_KEYS).toContain(key)
  })

  it('has no duplicate keys', () => {
    expect(new Set(STORE_KEYS).size).toBe(STORE_KEYS.length)
  })
})
