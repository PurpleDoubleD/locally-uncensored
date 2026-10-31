// @vitest-environment jsdom
/**
 * Kimi K3 und Kimi K3.1 Pro im Model Manager: was erscheint, wann, und mit
 * welcher Warnung. Alle HF-Antworten sind gemockt, kein Netz.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENGINE_OPENS_GATED_ARCHS, KIMI_K3_ARCH, KIMI_K31_CACHE_KEY,
  findKimiK31Entries, ggufSets, isKimiK31ProRepo, kimiK3CatalogEntries, kimiK3EntriesUngated,
  kimiK31CatalogEntries, pickOfferedSets, resetKimiK31Cache,
} from '../kimi-k3-catalog'
import { getMainstreamTextModels } from '../discover'
import { parsePinnedLlamaTag } from '../gguf-arch'
import { extractGgufQuant } from '../../lib/hf-to-provider'

const hier = dirname(fileURLToPath(import.meta.url))
const OPEN = new Set([KIMI_K3_ARCH])

/** Words a German sentence carries and an English one does not. */
const GERMAN = /\b(und|oder|nicht|fuer|für|ohne|wenn|Groesse|mehrteilig)\b|[äöüÄÖÜß]/

// ── K3.1 Pro: gemockte HF-API ───────────────────────────────────────────────

const GB = 1_000_000_000
const shard = (quant: string, i: number, n: number, bytes: number) => ({
  type: 'file',
  path: `${quant}/Kimi-K3.1-Pro-${quant}-${String(i).padStart(5, '0')}-of-${String(n).padStart(5, '0')}.gguf`,
  size: 134,
  lfs: { size: bytes, oid: 'a'.repeat(64) },
})
const TREE = [
  { type: 'file', path: 'README.md', size: 4000 },
  { type: 'file', path: 'mmproj-F32.gguf', size: 134, lfs: { size: 1_800_000_000, oid: 'c'.repeat(64) } },
  { type: 'file', path: 'mmproj-F16.gguf', size: 134, lfs: { size: 903_000_000, oid: 'b'.repeat(64) } },
  { type: 'file', path: 'imatrix_unsloth.gguf', size: 134, lfs: { size: 1_000_000_000, oid: 'd'.repeat(64) } },
  shard('UD-Q2_K_XL', 1, 2, 7_000_000), shard('UD-Q2_K_XL', 2, 2, 860 * GB),
  shard('UD-Q1_0', 2, 2, 470 * GB), shard('UD-Q1_0', 1, 2, 7_000_000),
  shard('UD-Q4_K_XL', 1, 2, 7_000_000), shard('UD-Q4_K_XL', 2, 2, 1510 * GB),
  shard('UD-IQ1_S', 1, 2, 7_000_000), shard('UD-IQ1_S', 2, 2, 600 * GB),
]
const REPO = 'unsloth/Kimi-K3.1-Pro-GGUF'
const INFO = { id: REPO, downloads: 12_345, createdAt: '2026-11-04T10:00:00.000Z', gated: false, private: false, gguf: { architecture: 'kimi-k3', total: 2_800_000_000_000 } }

type Routes = Record<string, unknown>
function hf(routes: Routes) {
  const calls: string[] = []
  const fetchText = vi.fn(async (url: string) => {
    calls.push(url)
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        if (body instanceof Error) throw body
        return JSON.stringify(body)
      }
    }
    return JSON.stringify({ error: 'Repository not found' })
  })
  return { fetchText, calls }
}
const SEARCH = 'https://huggingface.co/api/models?search=Kimi-K3.1'
const info = (repo: string) => `https://huggingface.co/api/models/${repo}`
const tree = (repo: string) => `https://huggingface.co/api/models/${repo}/tree/main`

beforeEach(() => resetKimiK31Cache())

describe('Kimi K3 (offene Gewichte seit 27.07.2026)', () => {
  it('steht fertig bereit: drei Stufen, kleinste zuerst, echte Pfade aus unsloth/Kimi-K3-GGUF', () => {
    const all = kimiK3EntriesUngated()
    expect(all.map((m) => m.sizeGB)).toEqual([466.4, 594.0, 861.3])
    for (const m of all) {
      expect(m.group).toBe('Kimi K3 2.8T')
      expect(m.downloadUrl).toMatch(/^https:\/\/huggingface\.co\/unsloth\/Kimi-K3-GGUF\/resolve\/main\/UD-[A-Z0-9_]+\/Kimi-K3-UD-[A-Z0-9_]+-00001-of-000\d\d\.gguf$/)
      expect(m.downloadUrl!.endsWith(`/${m.filename}`)).toBe(true)
      expect(m.tags).toContain('Multi-part')
      expect(m.tags).toContain(`${Math.round(m.sizeGB!)} GB`)
      expect(extractGgufQuant(m.filename!)).toBeTruthy()
      expect(m.mmprojUrl).toBe('https://huggingface.co/unsloth/Kimi-K3-GGUF/resolve/main/mmproj-F16.gguf')
      expect(m.mmprojBytes).toBe(903244832)
    }
  })

  it('warnt deutlich vor der Groesse, auf Englisch', () => {
    for (const m of kimiK3EntriesUngated()) {
      expect(m.description).toMatch(/Size warning/)
      expect(m.description).toMatch(/not a single PC or Mac/)
      expect(m.description).toMatch(/LU Cloud runs it/)
      expect(m.description).not.toMatch(GERMAN)
      expect(m.description).not.toMatch(/\u2014|\u2013/)
    }
  })

  it('erscheint nicht, solange die Engine kimi-k3 nicht oeffnet', () => {
    expect(kimiK3CatalogEntries(new Set())).toEqual([])
    expect(kimiK3CatalogEntries(OPEN)).toHaveLength(3)
    const shown = getMainstreamTextModels().filter((m) => m.name.startsWith('Kimi K3 '))
    expect(shown).toHaveLength(ENGINE_OPENS_GATED_ARCHS.has(KIMI_K3_ARCH) ? 3 : 0)
  })

  it('das Tor bleibt zu ohne echten Ladelauf (b9949 kennt kimi-k3 nicht, b11960 kennt es, geladen hat es noch niemand)', () => {
    const skript = readFileSync(resolve(hier, '../../../scripts/build-llama.sh'), 'utf8')
    const tag = parsePinnedLlamaTag(skript)
    expect(tag).not.toBeNull()
    // E1 (3.0.9): b11960 fuehrt LLM_ARCH_KIMI_K3 in src/llama-arch.cpp. Das
    // Tor ist trotzdem kein Pin-Schalter: umgelegt wird es erst nach einem
    // echten Ladelauf (466 GB), siehe Kopf von kimi-k3-catalog.ts.
    if (tag === 'b9949' || tag === 'b11960') expect(ENGINE_OPENS_GATED_ARCHS.size).toBe(0)
  })
})

describe('Kimi K3.1 Pro: Eintrag nur, wenn die Gewichte auf HF liegen', () => {
  it('nicht da (Stand 23.10.2026): kein Eintrag', async () => {
    const { fetchText } = hf({
      // Was die Suche heute wirklich findet: ein leeres, gesperrtes Fremd-Repo.
      [SEARCH]: [{ id: 'audnai/penclaw-Kimi-K3.1-pro-unrestricted', downloads: 0 }],
    })
    expect(await findKimiK31Entries(fetchText, OPEN)).toEqual([])
  })

  it('da: Eintraege mit deutlicher Groessenwarnung, kleinste zuerst, dazu Q2 und Q4', async () => {
    const { fetchText } = hf({ [SEARCH]: [], [tree(REPO)]: TREE, [info(REPO)]: INFO })
    const entries = await findKimiK31Entries(fetchText, OPEN)
    expect(entries.map((e) => e.name)).toEqual(['Kimi K3.1 Pro UD-Q1_0', 'Kimi K3.1 Pro UD-Q2_K_XL', 'Kimi K3.1 Pro UD-Q4_K_XL'])
    const [q1] = entries
    expect(q1.group).toBe('Kimi K3.1 Pro')
    expect(q1.downloadUrl).toBe(`https://huggingface.co/${REPO}/resolve/main/UD-Q1_0/Kimi-K3.1-Pro-UD-Q1_0-00001-of-00002.gguf`)
    expect(q1.filename).toBe('Kimi-K3.1-Pro-UD-Q1_0-00001-of-00002.gguf')
    expect(q1.sizeGB).toBe(470)
    expect(q1.tags).toEqual(['2.8T MoE', 'Vision', 'UD-Q1_0', '470 GB', 'Multi-part'])
    expect(q1.description).toMatch(/Size warning: 470 GB in 2 parts/)
    expect(q1.description).toMatch(/about 510 GB of RAM/)
    expect(q1.description).not.toMatch(GERMAN)
    expect(q1.released).toBe('2026-11')
    expect(q1.pulls).toBe('12K+')
    // F16 statt F32, und die imatrix-Datei ist kein Modell.
    expect(q1.mmprojUrl).toBe(`https://huggingface.co/${REPO}/resolve/main/mmproj-F16.gguf`)
    expect(entries.some((e) => /imatrix/i.test(e.downloadUrl!))).toBe(false)
  })

  it('findet auch einen abweichenden Repo-Namen ueber die Suche', async () => {
    const odd = 'AtomicChat/Kimi_K3.1_Pro-GGUF-imatrix'
    const { fetchText } = hf({
      [SEARCH]: [{ id: 'someone/Kimi-K3.1-Pro-GGUF' }, { id: 'unsloth/Kimi-K3.1-Pro-Highspeed-GGUF' }, { id: odd }],
      [tree(odd)]: TREE, [info(odd)]: { ...INFO, id: odd },
    })
    const entries = await findKimiK31Entries(fetchText, OPEN)
    expect(entries[0].downloadUrl).toContain(`/${odd}/`)
  })

  it('ein Repo ohne von der Engine geoeffnete Architektur ergibt keinen Eintrag', async () => {
    const { fetchText } = hf({ [SEARCH]: [], [tree(REPO)]: TREE, [info(REPO)]: { ...INFO, gguf: { architecture: 'kimi-k3.1' } } })
    expect(await findKimiK31Entries(fetchText, OPEN)).toEqual([])
    const ohneArch = hf({ [SEARCH]: [], [tree(REPO)]: TREE, [info(REPO)]: { ...INFO, gguf: undefined } })
    expect(await findKimiK31Entries(ohneArch.fetchText, OPEN)).toEqual([])
  })

  it('gesperrtes Repo oder eines ohne GGUF-Dateien: kein Eintrag', async () => {
    const gated = hf({ [SEARCH]: [], [tree(REPO)]: TREE, [info(REPO)]: { ...INFO, gated: 'manual' } })
    expect(await findKimiK31Entries(gated.fetchText, OPEN)).toEqual([])
    const leer = hf({ [SEARCH]: [], [tree(REPO)]: [{ type: 'file', path: 'README.md', size: 10 }], [info(REPO)]: INFO })
    expect(await findKimiK31Entries(leer.fetchText, OPEN)).toEqual([])
  })

  it('offline oder HF-Fehler: kein Eintrag, und kein Wurf', async () => {
    const offline = vi.fn(async () => { throw new Error('offline') })
    expect(await findKimiK31Entries(offline, OPEN)).toEqual([])
    const kaputt = vi.fn(async () => '<html>502</html>')
    expect(await findKimiK31Entries(kaputt, OPEN)).toEqual([])
  })

  it('Tor zu: keine einzige Anfrage, kein Eintrag', async () => {
    const { fetchText } = hf({ [SEARCH]: [], [tree(REPO)]: TREE, [info(REPO)]: INFO })
    expect(await findKimiK31Entries(fetchText, new Set())).toEqual([])
    expect(await kimiK31CatalogEntries({ fetchText, engineArchs: new Set() })).toEqual([])
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('haelt das Ergebnis: ein Treffer sechs Stunden, ein Fehlschlag dreissig Minuten', async () => {
    let t = 1_000_000
    const now = () => t
    const da = hf({ [SEARCH]: [], [tree(REPO)]: TREE, [info(REPO)]: INFO })
    expect(await kimiK31CatalogEntries({ fetchText: da.fetchText, engineArchs: OPEN, now })).toHaveLength(3)
    const n = da.fetchText.mock.calls.length
    t += 5 * 60 * 60 * 1000
    expect(await kimiK31CatalogEntries({ fetchText: da.fetchText, engineArchs: OPEN, now })).toHaveLength(3)
    expect(da.fetchText.mock.calls.length).toBe(n)
    expect(JSON.parse(localStorage.getItem(KIMI_K31_CACHE_KEY)!).entries).toHaveLength(3)

    resetKimiK31Cache()
    const weg = vi.fn(async () => { throw new Error('offline') })
    expect(await kimiK31CatalogEntries({ fetchText: weg, engineArchs: OPEN, now })).toEqual([])
    const m = weg.mock.calls.length
    t += 20 * 60 * 1000
    await kimiK31CatalogEntries({ fetchText: weg, engineArchs: OPEN, now })
    expect(weg.mock.calls.length).toBe(m)
    t += 11 * 60 * 1000
    await kimiK31CatalogEntries({ fetchText: weg, engineArchs: OPEN, now })
    expect(weg.mock.calls.length).toBeGreaterThan(m)
  })
})

describe('Bausteine', () => {
  it('nimmt nur K3.1-Pro-Repos bekannter Quantisierer', () => {
    expect(isKimiK31ProRepo('unsloth/Kimi-K3.1-Pro-GGUF')).toBe(true)
    expect(isKimiK31ProRepo('bartowski/moonshotai_Kimi-K3.1-Pro-GGUF')).toBe(true)
    expect(isKimiK31ProRepo('audnai/penclaw-Kimi-K3.1-pro-unrestricted')).toBe(false)
    expect(isKimiK31ProRepo('unsloth/Kimi-K3.1-Pro-Highspeed-GGUF')).toBe(false)
    expect(isKimiK31ProRepo('unsloth/Kimi-K3-GGUF')).toBe(false)
    expect(isKimiK31ProRepo('mradermacher/Qwen3.5-9B-Kimi-K3.1-Pro-Distill-GGUF')).toBe(false)
  })

  it('bildet Saetze aus Teilen und sortiert nach Gesamtgroesse', () => {
    const sets = ggufSets(TREE)
    expect(sets.map((s) => s.quant)).toEqual(['UD-Q1_0', 'UD-IQ1_S', 'UD-Q2_K_XL', 'UD-Q4_K_XL'])
    expect(sets[0].parts.map((p) => p.path.split('/').pop())).toEqual([
      'Kimi-K3.1-Pro-UD-Q1_0-00001-of-00002.gguf', 'Kimi-K3.1-Pro-UD-Q1_0-00002-of-00002.gguf',
    ])
    expect(pickOfferedSets(sets).map((s) => s.quant)).toEqual(['UD-Q1_0', 'UD-Q2_K_XL', 'UD-Q4_K_XL'])
    expect(pickOfferedSets([])).toEqual([])
  })
})
