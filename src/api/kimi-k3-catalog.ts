/**
 * Kimi K3 and Kimi K3.1 Pro im lokalen Model Manager.
 *
 * ── WARUM BEIDE HINTER EINEM TOR STEHEN ────────────────────────────────────
 *
 * Kimi K3 hat offene Gewichte seit dem 27.07.2026, und die GGUFs gibt es
 * (unsloth/Kimi-K3-GGUF, am 23.10.2026 ueber die Tree-API gelesen: kleinste
 * Quantisierung UD-Q1_0 mit 466,4 GB in 11 Teilen). Die Datei traegt laut
 * HF-Modell-API `general.architecture = kimi-k3`. Der llama.cpp-Stand, den
 * scripts/build-llama.sh pinnt (b9949), kennt diese Architektur NICHT: in
 * src/llama-arch.cpp von b9949 steht `kimi-linear`, aber kein `kimi-k3`; auf
 * master steht `LLM_ARCH_KIMI_K3` (beides am 23.10.2026 nachgesehen).
 *
 * Damit gilt dieselbe Regel wie fuer GLM 5.3 Flash und Hunyuan 3 (siehe den
 * GLM-5.3-Block in discover.ts): ein Eintrag, der hunderte Gigabyte laedt, die
 * die Engine danach nicht oeffnen kann, kommt nicht in den Katalog. Die
 * Eintraege stehen deshalb hier fertig und echt (Pfade, Groessen, Teile aus
 * der HF-Dateiliste), erscheinen aber erst, wenn `ENGINE_OPENS_GATED_ARCHS`
 * die Architektur nennt. Das ist der Schalter, und er gehoert erst umgelegt,
 * wenn LLAMA_TAG/LLAMA_COMMIT gehoben UND ein echter Ladelauf gemacht ist.
 * E1 (3.0.9, Pin b11960): b11960 fuehrt `kimi-k3` in src/llama-arch.cpp,
 * geladen hat es noch niemand, also bleibt das Tor zu.
 * __tests__/kimi-k3-catalog.test.ts haelt ihn fest, solange kein Ladelauf da ist,
 * und der Architektur-Waechter (katalog-architektur.live.test.ts) liest die
 * Kopfbytes, sobald die K3-Eintraege in getMainstreamTextModels stehen.
 *
 * ── KIMI K3.1 PRO ──────────────────────────────────────────────────────────
 *
 * K3.1 Pro laeuft in der LU Cloud, offene Gewichte gibt es noch nicht
 * (Moonshot nennt "bis 4. November 2026"; am 23.10.2026 antwortet
 * moonshotai/Kimi-K3.1-Pro mit 401, die HF-Suche nach "Kimi-K3.1" findet nur
 * ein leeres, gesperrtes Fremd-Repo ohne eine einzige Datei). Der Eintrag
 * entsteht deshalb beim Laden der Liste aus der HF-API:
 *
 *   1. Bekannte Kandidaten-Repos zuerst, danach die HF-Suche "Kimi-K3.1" mit
 *      Filter gguf. Nur Repos bekannter Quantisierer zaehlen, und nur Namen,
 *      die wirklich K3.1 Pro meinen (keine Highspeed-, Distill- oder
 *      Abliterated-Ableger). Ein Fremd-Repo mit passendem Namen bekommt so
 *      keinen Eintrag mit LU-Logo davor.
 *   2. Die Modell-API muss eine Architektur nennen, die die Engine oeffnet
 *      (dasselbe Tor wie oben). Keine Architektur gemeldet: kein Eintrag.
 *   3. Die Tree-API liefert die echten Dateien und Groessen. Angeboten werden
 *      die kleinste Quantisierung und, wenn vorhanden, je eine 2-bit- und eine
 *      4-bit-Variante.
 *
 * Fehler, Offline, 401, leere Antwort: kein Eintrag. Das Ergebnis wird sechs
 * Stunden gehalten (Speicher und localStorage), ein Fehlschlag dreissig
 * Minuten. Solange das Tor keine Architektur nennt, geht gar keine Anfrage
 * raus: dann koennte auch kein Treffer erscheinen.
 *
 * Die Original-Gewichte (moonshotai/Kimi-K3.1-Pro, safetensors) ergeben
 * absichtlich keinen Eintrag: die Engine laedt GGUF, und ein Download von
 * mehreren Terabyte safetensors waere fuer sie nutzlos.
 */
import { fetchExternal } from './backend'
import type { DiscoverModel } from './model-bundles'
import { IMAGE_PART } from './image-parts'
import { isUpstreamImagePart, pickUpstreamImagePart } from '../lib/image-part'
import { log } from '../lib/logger'

/**
 * Architekturen aus den Kimi-K3-Familien, die die ausgelieferte Engine
 * oeffnet. Leer bis zum echten Ladelauf (siehe Kopf).
 * Umlegen heisst: 'kimi-k3' eintragen, nachdem Tag gehoben und geladen ist.
 */
export const ENGINE_OPENS_GATED_ARCHS: ReadonlySet<string> = new Set<string>([])

/** Die Architektur, die unsloth/Kimi-K3-GGUF meldet (HF-Modell-API, 23.10.2026). */
export const KIMI_K3_ARCH = 'kimi-k3'

const HF = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

const CLOUD_LINE = 'LU Cloud runs it without any download.'

/**
 * Kimi K3, gelesen aus der Tree-API von unsloth/Kimi-K3-GGUF am 23.10.2026.
 * Groessen in dezimalen GB (Summe aller Teile): UD-Q1_0 466.369.456.320 Bytes
 * in 11 Teilen, UD-IQ1_S 594.040.923.616 in 14, UD-Q2_K_XL 861.277.858.912
 * in 19. Der erste Teil ist jeweils nur ~6,9 MB gross (nur Metadaten).
 * Groessere Stufen (UD-Q4_K_XL 1.508,7 GB, UD-Q8_K_XL 1.561,2 GB) stehen
 * nicht im Katalog: das ist Server-Gebiet, nicht Desktop.
 */
const KIMI_K3_ENTRIES: DiscoverModel[] = [
  {
    name: 'Kimi K3 2.8T Q1', group: 'Kimi K3 2.8T',
    description: `Moonshot Kimi K3 · 2.8T MoE, 1M context, vision, tools and thinking. Size warning: this is the smallest quant there is and it is still 466 GB in 11 parts. It needs about 500 GB of RAM or unified memory before any context, so not a single PC or Mac: a cluster of 512 GB Mac Studios or a multi-GPU server. ${CLOUD_LINE}`,
    pulls: '287K+', tags: ['2.8T MoE', 'Vision', 'UD-Q1_0', '466 GB', 'Multi-part'], updated: 'New', agent: true, released: '2026-07',
    downloadUrl: HF('unsloth/Kimi-K3-GGUF', 'UD-Q1_0/Kimi-K3-UD-Q1_0-00001-of-00011.gguf'), filename: 'Kimi-K3-UD-Q1_0-00001-of-00011.gguf', sizeGB: 466.4,
    ...IMAGE_PART['unsloth/Kimi-K3-GGUF/mmproj-F16.gguf'],
  },
  {
    name: 'Kimi K3 2.8T IQ1', group: 'Kimi K3 2.8T',
    description: `Moonshot Kimi K3 · Unsloth dynamic IQ1_S, a little more quality than Q1 for 128 GB more. Size warning: 594 GB in 14 parts, needs about 640 GB of RAM or unified memory, so not a single PC or Mac: two 512 GB Mac Studios or a multi-GPU server. ${CLOUD_LINE}`,
    pulls: '287K+', tags: ['2.8T MoE', 'Vision', 'UD-IQ1_S', '594 GB', 'Multi-part'], updated: 'New', agent: true, released: '2026-07',
    downloadUrl: HF('unsloth/Kimi-K3-GGUF', 'UD-IQ1_S/Kimi-K3-UD-IQ1_S-00001-of-00014.gguf'), filename: 'Kimi-K3-UD-IQ1_S-00001-of-00014.gguf', sizeGB: 594.0,
    ...IMAGE_PART['unsloth/Kimi-K3-GGUF/mmproj-F16.gguf'],
  },
  {
    name: 'Kimi K3 2.8T Q2', group: 'Kimi K3 2.8T',
    description: `Moonshot Kimi K3 · Unsloth dynamic Q2_K_XL, the quality and size sweet spot for this MoE. Size warning: 861 GB in 19 parts, needs about 900 GB of RAM or unified memory, so not a single PC or Mac: two to three 512 GB Mac Studios or an 8 GPU server. ${CLOUD_LINE}`,
    pulls: '287K+', tags: ['2.8T MoE', 'Vision', 'UD-Q2_K_XL', '861 GB', 'Multi-part'], updated: 'New', agent: true, released: '2026-07',
    downloadUrl: HF('unsloth/Kimi-K3-GGUF', 'UD-Q2_K_XL/Kimi-K3-UD-Q2_K_XL-00001-of-00019.gguf'), filename: 'Kimi-K3-UD-Q2_K_XL-00001-of-00019.gguf', sizeGB: 861.3,
    ...IMAGE_PART['unsloth/Kimi-K3-GGUF/mmproj-F16.gguf'],
  },
]

/** Alle K3-Eintraege, unabhaengig vom Tor. Fuer Tests und den Waechter. */
export function kimiK3EntriesUngated(): DiscoverModel[] {
  return KIMI_K3_ENTRIES.map((m) => ({ ...m, tags: [...m.tags] }))
}

/** Die K3-Eintraege, die der Katalog zeigt: keine, solange die Engine die
 *  Architektur nicht oeffnet. */
export function kimiK3CatalogEntries(engineArchs: ReadonlySet<string> = ENGINE_OPENS_GATED_ARCHS): DiscoverModel[] {
  return engineArchs.has(KIMI_K3_ARCH) ? kimiK3EntriesUngated() : []
}

// ── Kimi K3.1 Pro: Eintrag erst, wenn es die Gewichte als GGUF gibt ─────────

/** Die Repos, unter denen ein K3.1-Pro-GGUF am ehesten auftaucht. */
export const KIMI_K31_CANDIDATE_REPOS: readonly string[] = [
  'unsloth/Kimi-K3.1-Pro-GGUF',
  'AtomicChat/Kimi-K3.1-Pro-GGUF',
  'bartowski/moonshotai_Kimi-K3.1-Pro-GGUF',
  'lmstudio-community/Kimi-K3.1-Pro-GGUF',
  'ggml-org/Kimi-K3.1-Pro-GGUF',
]

/** Quantisierer, deren Repo einen Eintrag bekommen darf. */
export const KIMI_K31_TRUSTED_AUTHORS: readonly string[] = [
  'unsloth', 'AtomicChat', 'bartowski', 'lmstudio-community', 'ggml-org', 'moonshotai', 'mradermacher',
]

const HF_SEARCH = 'https://huggingface.co/api/models?search=Kimi-K3.1&filter=gguf&sort=downloads&limit=50'

/** Ist das ein Repo, das K3.1 Pro selbst meint, von einem bekannten Quantisierer? */
export function isKimiK31ProRepo(repoId: string): boolean {
  const [author, name, rest] = repoId.split('/')
  if (!author || !name || rest !== undefined) return false
  if (!KIMI_K31_TRUSTED_AUTHORS.some((a) => a.toLowerCase() === author.toLowerCase())) return false
  if (!/kimi[-_.]?k3\.1[-_.]?pro/i.test(name)) return false
  return !/high[-_.]?speed|distill|abliterat|uncensor|heretic|reap|dflash|dspark|eagle|draft|mlx|nvfp4|fp8|layers|tiny|dummy|random|lora/i.test(name)
}

/** Antwort einer HF-Abfrage als Text, wirft bei Netz- oder HTTP-Fehler. */
export type FetchText = (url: string) => Promise<string>

interface TreeFile { path: string; bytes: number; sha256?: string }

const SHARD_RE = /-(\d{4,5})-of-(\d{4,5})\.gguf$/i
const QUANT_RE = /((?:UD-)?(?:IQ\d_[A-Z0-9]+|TQ\d_\d|Q\d_K(?:_[A-Z]+)?|Q\d_[01]|MXFP4(?:_MOE)?|BF16|F16))/i

function treeFiles(raw: unknown): TreeFile[] {
  if (!Array.isArray(raw)) return []
  const out: TreeFile[] = []
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue
    const r = e as { type?: unknown; path?: unknown; size?: unknown; lfs?: { size?: unknown; oid?: unknown } }
    if (r.type !== 'file' || typeof r.path !== 'string') continue
    const bytes = typeof r.lfs?.size === 'number' ? r.lfs.size : typeof r.size === 'number' ? r.size : 0
    const oid = typeof r.lfs?.oid === 'string' && /^[0-9a-f]{64}$/i.test(r.lfs.oid) ? r.lfs.oid.toLowerCase() : undefined
    out.push({ path: r.path, bytes, sha256: oid })
  }
  return out
}

/** Eine herunterladbare Einheit: eine Datei oder alle Teile eines Satzes. */
export interface GgufSet { quant: string; parts: TreeFile[]; totalBytes: number }

/** Die GGUF-Saetze eines Repos, kleinster zuerst. Bildteile zaehlen nicht. */
export function ggufSets(raw: unknown): GgufSet[] {
  const groups = new Map<string, TreeFile[]>()
  for (const f of treeFiles(raw)) {
    if (!/\.gguf$/i.test(f.path) || isUpstreamImagePart(f.path) || /imatrix/i.test(f.path)) continue
    const key = f.path.replace(SHARD_RE, '')
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const sets: GgufSet[] = []
  for (const [key, parts] of groups) {
    const total = parts.reduce((s, p) => s + p.bytes, 0)
    // Ein Satz ohne Groessenangabe ist keiner, den man ehrlich anbieten kann.
    if (total <= 0 || parts.some((p) => p.bytes <= 0)) continue
    const quant = (QUANT_RE.exec(key.split('/').pop() ?? '')?.[1] ?? QUANT_RE.exec(key)?.[1] ?? 'GGUF').toUpperCase()
    const sorted = [...parts].sort((a, b) => a.path.localeCompare(b.path))
    sets.push({ quant, parts: sorted, totalBytes: total })
  }
  return sets.sort((a, b) => a.totalBytes - b.totalBytes)
}

/** Kleinster Satz, dazu je ein 2-bit- und ein 4-bit-Satz, ohne Dubletten. */
export function pickOfferedSets(sets: GgufSet[]): GgufSet[] {
  if (sets.length === 0) return []
  const firstOf = (re: RegExp) => sets.find((s) => re.test(s.quant))
  const picked = [sets[0], firstOf(/Q2_K/), firstOf(/Q4_K|MXFP4/)].filter((s): s is GgufSet => !!s)
  return picked.filter((s, i) => picked.indexOf(s) === i)
}

const gbText = (bytes: number) => `${Math.round(bytes / 1e9)} GB`
const gbNumber = (bytes: number) => Math.round(bytes / 1e8) / 10

function pullsText(downloads: unknown): string {
  if (typeof downloads !== 'number' || downloads <= 0) return 'New'
  if (downloads >= 1_000_000) return `${Math.floor(downloads / 1_000_000)}M+`
  if (downloads >= 1_000) return `${Math.floor(downloads / 1_000)}K+`
  return `${downloads}`
}

/** Der Katalog-Eintrag fuer einen Satz aus einem K3.1-Pro-Repo. */
export function kimiK31Entry(repoId: string, set: GgufSet, info: { downloads?: unknown; createdAt?: unknown }, tree: unknown): DiscoverModel {
  const first = set.parts[0]
  const leaf = first.path.split('/').pop() ?? first.path
  const multi = set.parts.length > 1
  const ramGb = Math.ceil((set.totalBytes / 1e9) * 1.08 / 10) * 10
  const mmproj = pickUpstreamImagePart(treeFiles(tree))
  const released = typeof info.createdAt === 'string' && /^\d{4}-\d{2}/.test(info.createdAt) ? info.createdAt.slice(0, 7) : undefined
  const image = mmproj && mmproj.bytes > 0
    ? {
        mmprojUrl: HF(repoId, mmproj.path),
        mmprojSizeGB: Math.round((mmproj.bytes / 1_073_741_824) * 100) / 100,
        mmprojBytes: mmproj.bytes,
        ...(mmproj.sha256 ? { mmprojSha256: mmproj.sha256 } : {}),
      }
    : {}
  const parts = multi ? ` in ${set.parts.length} parts` : ''
  return {
    name: `Kimi K3.1 Pro ${set.quant}`,
    group: 'Kimi K3.1 Pro',
    description: `Moonshot Kimi K3.1 Pro · 2.8T MoE (104B active), 1M context, vision, tools and thinking. Size warning: ${gbText(set.totalBytes)}${parts}. It needs about ${ramGb} GB of RAM or unified memory before any context, so not a single PC or Mac: a cluster of 512 GB Mac Studios or a multi-GPU server. ${CLOUD_LINE}`,
    pulls: pullsText(info.downloads),
    tags: ['2.8T MoE', ...(mmproj ? ['Vision'] : []), set.quant, gbText(set.totalBytes), ...(multi ? ['Multi-part'] : [])],
    updated: 'New',
    agent: true,
    ...(released ? { released } : {}),
    downloadUrl: HF(repoId, first.path),
    filename: leaf,
    sizeGB: gbNumber(set.totalBytes),
    ...image,
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * Sucht K3.1-Pro-GGUFs auf HF und baut die Eintraege. Wirft nie: jeder Fehler
 * heisst "keine Gewichte gefunden". `engineArchs` ist das Tor von oben.
 */
export async function findKimiK31Entries(
  fetchText: FetchText,
  engineArchs: ReadonlySet<string> = ENGINE_OPENS_GATED_ARCHS,
): Promise<DiscoverModel[]> {
  if (engineArchs.size === 0) return []
  const repos: string[] = [...KIMI_K31_CANDIDATE_REPOS]
  try {
    const found = parseJson(await fetchText(HF_SEARCH))
    if (Array.isArray(found)) {
      for (const m of found) {
        const id = typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined
        if (typeof id === 'string' && !repos.includes(id)) repos.push(id)
      }
    }
  } catch (err) {
    log.warn('[kimi-k3.1] HF search failed', { err })
  }
  for (const repoId of repos) {
    if (!isKimiK31ProRepo(repoId)) continue
    try {
      const info = parseJson(await fetchText(`https://huggingface.co/api/models/${repoId}`))
      if (typeof info !== 'object' || info === null || 'error' in info) continue
      const meta = info as { gguf?: { architecture?: unknown }; downloads?: unknown; createdAt?: unknown; gated?: unknown; private?: unknown }
      if (meta.private === true || (meta.gated !== undefined && meta.gated !== false)) continue
      const arch = meta.gguf?.architecture
      if (typeof arch !== 'string' || !engineArchs.has(arch)) continue
      const tree = parseJson(await fetchText(`https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`))
      const offered = pickOfferedSets(ggufSets(tree))
      if (offered.length === 0) continue
      return offered.map((s) => kimiK31Entry(repoId, s, meta, tree))
    } catch (err) {
      log.warn('[kimi-k3.1] HF repo check failed', { repoId, err })
    }
  }
  return []
}

// ── Zwischenspeicher ────────────────────────────────────────────────────────

export const KIMI_K31_CACHE_KEY = 'lu.kimiK31Weights.v1'
const HIT_TTL_MS = 6 * 60 * 60 * 1000
const MISS_TTL_MS = 30 * 60 * 1000

interface CacheRow { at: number; entries: DiscoverModel[] }
let memo: CacheRow | null = null
let inflight: Promise<DiscoverModel[]> | null = null

function fresh(row: CacheRow | null, now: number): row is CacheRow {
  if (!row) return false
  const ttl = row.entries.length > 0 ? HIT_TTL_MS : MISS_TTL_MS
  return now - row.at >= 0 && now - row.at < ttl
}

function readStored(): CacheRow | null {
  try {
    const raw = globalThis.localStorage?.getItem(KIMI_K31_CACHE_KEY)
    if (!raw) return null
    const row = JSON.parse(raw) as CacheRow
    return typeof row?.at === 'number' && Array.isArray(row.entries) ? row : null
  } catch {
    return null
  }
}

function store(row: CacheRow): void {
  memo = row
  try { globalThis.localStorage?.setItem(KIMI_K31_CACHE_KEY, JSON.stringify(row)) } catch { /* nur Bequemlichkeit */ }
}

/** Fuer Tests: vergisst den Zwischenspeicher. */
export function resetKimiK31Cache(): void {
  memo = null
  inflight = null
  try { globalThis.localStorage?.removeItem(KIMI_K31_CACHE_KEY) } catch { /* egal */ }
}

/**
 * Die K3.1-Pro-Eintraege fuer den Model Manager, gecacht. Leer, solange es
 * keine passenden Gewichte gibt, offline oder bei jedem Fehler.
 */
export async function kimiK31CatalogEntries(opts: {
  fetchText?: FetchText
  engineArchs?: ReadonlySet<string>
  now?: () => number
} = {}): Promise<DiscoverModel[]> {
  const engineArchs = opts.engineArchs ?? ENGINE_OPENS_GATED_ARCHS
  if (engineArchs.size === 0) return []
  const now = opts.now ?? Date.now
  if (fresh(memo, now())) return memo.entries
  const stored = readStored()
  if (fresh(stored, now())) { memo = stored; return stored.entries }
  if (inflight) return inflight
  const fetchText = opts.fetchText ?? ((url: string) => fetchExternal(url))
  inflight = findKimiK31Entries(fetchText, engineArchs)
    .catch(() => [] as DiscoverModel[])
    .then((entries) => { store({ at: now(), entries }); return entries })
    .finally(() => { inflight = null })
  return inflight
}
