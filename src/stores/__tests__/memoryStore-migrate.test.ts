/**
 * Was eine kaputte Zeile im gespeicherten Memory-Blob kostet.
 *
 * `migrate` liest Daten, die eine ÄLTERE Version dieser App geschrieben hat,
 * und zustand gibt ihm keinen zweiten Versuch: wirft es, landet der Fehler in
 * persists `.catch`, die Hydration wird abgebrochen, `set()` läuft nie — der
 * Store bleibt auf seinem leeren Default stehen. Der nächste Schreibvorgang
 * persistiert dann GENAU DIESEN leeren Stand über den gespeicherten Blob.
 * Eine einzige Zeile, die die Migration nicht lesen kann, nimmt damit alle
 * Erinnerungen dauerhaft mit.
 *
 * Der erste Block misst diese Mechanik an der echten Bibliothek, statt sie zu
 * behaupten. Der Rest prüft, dass migrateMemoryState sie nicht mehr auslöst.
 *
 * Run: npx vitest run src/stores/__tests__/memoryStore-migrate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { migrateMemoryState } from '../memoryStore'
import type { MemoryFile } from '../../types/agent-mode'

function memoryStorage(seed?: [string, string]) {
  const mem = new Map<string, string>()
  if (seed) mem.set(seed[0], seed[1])
  return {
    mem,
    api: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
  }
}

describe('a throwing migrate costs the whole store, measured not assumed', () => {
  // The unguarded migration's shape: a read straight into each entry.
  const storeOver = (blob: string) => {
    const { mem, api } = memoryStorage(['blast', blob])
    const s = create<{ entries: string[]; add: (e: string) => void }>()(persist((set) => ({
      entries: [],
      add: (e) => set((x) => ({ entries: [...x.entries, e] })),
    }), {
      name: 'blast',
      version: 3,
      storage: createJSONStorage(() => api as never),
      migrate: (p) => ({ entries: (p as { entries: string[] }).entries.map((e) => e.toUpperCase()) }) as never,
    }))
    return { mem, s }
  }

  it('hydrates normally while every entry is readable', async () => {
    const { s } = storeOver(JSON.stringify({ state: { entries: ['a', 'b'] }, version: 2 }))
    await s.persist.rehydrate()
    expect(s.getState().entries).toEqual(['A', 'B'])
  })

  it('leaves the store at its defaults and then overwrites the blob with them', async () => {
    const { mem, s } = storeOver(JSON.stringify({ state: { entries: ['a', null] }, version: 2 }))
    await s.persist.rehydrate()

    // Nothing hydrated — the good entry is lost along with the bad one…
    expect(s.getState().entries).toEqual([])
    // …and the next ordinary write persists that emptiness over the blob.
    s.getState().add('new')
    expect(JSON.parse(mem.get('blast')!).state.entries).toEqual(['new'])
  })
})

describe('migrateMemoryState — v2 blob (the migration every 2.5.x user runs)', () => {
  const good = (id: string): Record<string, unknown> => ({
    id,
    type: 'project',
    title: `t-${id}`,
    description: `d-${id}`,
    content: `c-${id}`,
    tags: ['x'],
    createdAt: 1,
    updatedAt: 2,
    source: 'manual',
  })

  const entriesOf = (v: unknown): MemoryFile[] => (v as { entries: MemoryFile[] }).entries

  it('drops the one unreadable entry instead of the whole store', () => {
    const out = migrateMemoryState({ entries: [good('a'), null, good('b')] }, 2)
    expect(entriesOf(out).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('survives a non-object where an entry should be', () => {
    const out = migrateMemoryState({ entries: ['just a string', 42, good('a')] }, 2)
    expect(entriesOf(out).map((e) => e.id)).toEqual(['a'])
  })

  it('keeps every readable field of a well-formed entry', () => {
    const out = migrateMemoryState({ entries: [good('a')] }, 2)
    expect(entriesOf(out)[0]).toMatchObject({
      id: 'a', type: 'project', title: 't-a', description: 'd-a',
      content: 'c-a', tags: ['x'], createdAt: 1, updatedAt: 2, source: 'manual',
    })
  })

  it('still concretises the stale flag, which is what v3 exists for', () => {
    const out = migrateMemoryState({ entries: [good('a'), { ...good('b'), stale: true }] }, 2)
    expect(entriesOf(out).map((e) => e.stale)).toEqual([false, true])
  })

  it('drops a type it does not know rather than carrying it into retrieval', () => {
    const out = migrateMemoryState({ entries: [{ ...good('a'), type: 'nonsense' }] }, 2)
    expect(entriesOf(out)[0].type).toBe('project')
  })
})

describe('migrateMemoryState — v1 blob (MemoryEntry[] → MemoryFile[])', () => {
  const legacy = (id: string) => ({ id, category: 'fact', content: `c-${id}`, timestamp: 7, source: 'user:manual' })

  const entriesOf = (v: unknown): MemoryFile[] => (v as { entries: MemoryFile[] }).entries

  it('maps the legacy category onto the new type', () => {
    const out = migrateMemoryState({ entries: [legacy('a')] }, 1)
    expect(entriesOf(out)[0]).toMatchObject({ id: 'a', type: 'user', content: 'c-a', createdAt: 7, updatedAt: 7 })
  })

  it('drops a legacy entry with no content instead of throwing on it', () => {
    const out = migrateMemoryState({ entries: [{ id: 'a', category: 'fact' }, legacy('b')] }, 1)
    expect(entriesOf(out).map((e) => e.id)).toEqual(['b'])
  })

  it('does not choke on a null first entry when testing "already migrated?"', () => {
    const out = migrateMemoryState({ entries: [null, legacy('b')] }, 1)
    expect(entriesOf(out).map((e) => e.id)).toEqual(['b'])
  })

  it('leaves a blob with no entries array alone', () => {
    expect(migrateMemoryState({ settings: { maxMemoriesInPrompt: 3 } }, 1))
      .toEqual({ settings: { maxMemoriesInPrompt: 3 } })
  })
})
