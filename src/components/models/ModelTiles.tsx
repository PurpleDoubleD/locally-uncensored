// Presentational building blocks for the redesigned Model Manager ("Model
// Hub"). All download/install LOGIC stays in DiscoverModels/ModelManager —
// these components only render state and forward events, so the existing
// handlers (Ollama routing, sharded confirm, bundle retry/clear, …) keep
// working unchanged behind a new surface.
import { useEffect, useRef, useState } from 'react'
import {
  Download, ExternalLink, Info, Check, ChevronDown, Loader2, RefreshCw,
  X, Flame, Wrench, Eye, Feather, HardDrive,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DiscoverModel, DownloadProgress, ModelBundle } from '../../api/discover'
import { formatBytes, countLabel } from '../../lib/formatters'
import { bundleVramNeedGb } from '../../lib/hardware'
import { modelTileAction } from '../../lib/model-tile-action'
import { ICON_SM } from '../ui/icon-size'

// ─── Hardware fit ───────────────────────────────────────────────────

export type Fit = 'fits' | 'tight' | 'big' | 'unknown'

// GGUF weights ≈ VRAM need; leave headroom for KV-cache/context. Never used
// to BLOCK a download — purely an honest hint.
export function computeFit(sizeGB: number | undefined, vramGb: number | null): Fit {
  if (!sizeGB || !vramGb) return 'unknown'
  if (sizeGB <= vramGb * 0.85) return 'fits'
  if (sizeGB <= vramGb * 1.15) return 'tight'
  return 'big'
}

// Color lives ONLY in the tiny status dot — labels stay neutral gray so the
// grid doesn't turn into a traffic-light wall (David, 2026-07-17 design pass).
//
// `big` war bis zum Ton-Pass (Audit Welle 3) `bg-red-400/80` mit dem Label
// "Too big for your GPU" — und beides war eine Falschaussage. Rot heisst in
// dieser App an rund hundert Stellen „kaputt oder wird geloescht"; ein Modell,
// das auf CPU und RAM ausweicht, ist keins von beidem, es ist LANGSAMER. Und
// "too big" liest sich als Verbot, obwohl `computeFit` ausdruecklich nie
// blockiert (siehe oben: "Never used to BLOCK a download").
//
// Die Leiter bleibt eine Leiter — Folge, nicht Fehlergrad: schnell (emerald)
// → langsamer (amber) → deutlich langsamer (orange). Orange ist die naechste
// Stufe derselben warmen Reihe und gehoert keinem der roten Fehlertokens
// (red-300/400/500/600) an, die die App sonst benutzt.
// Gerechnet auf der Kachelflaeche (`bg-gray-50` hell, `bg-white/[0.03]` ueber
// #1e1e1e = #252525 dunkel): red-400/80 lag bei 4.05:1 dunkel und 2.20:1 hell,
// orange-500/80 liegt bei 3.98:1 und 2.24:1 — die Aussage aendert sich, der
// Kontrast praktisch nicht. (Dass die HELLE Seite fuer die ganze Leiter unter
// 3:1 liegt, ist ein aelterer, eigener Befund; er betrifft alle vier Punkte
// gleich und wird hier nicht einseitig fuer einen davon repariert.)
const FIT_META: Record<Fit, { dot: string; label: string; title: string }> = {
  fits: { dot: 'bg-emerald-500/80', label: 'Runs on your PC', title: 'Fits fully in your GPU memory. Fast.' },
  tight: { dot: 'bg-amber-500/80', label: 'Tight fit', title: 'Barely fits. Parts may spill to RAM and slow it down.' },
  big: { dot: 'bg-orange-500/80', label: 'Runs on CPU, slower', title: 'Bigger than your GPU memory, so most of it runs on CPU and RAM. It works, just slower.' },
  unknown: { dot: 'bg-gray-400 dark:bg-gray-600', label: '', title: 'Hardware not detected yet.' },
}

export function FitHint({ fit, compact = false }: { fit: Fit; compact?: boolean }) {
  if (fit === 'unknown') return null
  const meta = FIT_META[fit]
  return (
    <span className="inline-flex items-center gap-1" title={meta.title}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {!compact && (
        <span className="t-micro text-gray-500 dark:text-gray-400">
          {meta.label}
        </span>
      )}
    </span>
  )
}

// ─── Drei Rollen, drei Erscheinungen ────────────────────────────────
//
// D-S23: „Quant-Dropdown und statischer Groessen-Chip haben identische
// Klassen an identischer Position, Unterschied ist nur ein 10px-Chevron."
// Beide trugen `px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.06]`
// und dieselbe Schriftgroesse — ein Bedienelement, das aussah wie eine
// Anzeige. Das Chevron war die ganze Unterscheidung, und ein Chevron ist
// eine Fussnote, keine Formsprache.
//
// Die Kachelzeile kennt jetzt drei Rollen, und jede sieht anders aus:
//
//   ANZEIGE   `SizePill`, „Installed", die Fortschrittszeile.
//             Flaeche ohne Rand, kein Hover, kein Fokus, kein Zustand.
//   CONTROL   der Varianten-Aufklapper und „View" → `.lu-control`, also
//             das neutrale Hausrezept aus index.css. Es liest seinen
//             offenen Zustand aus `aria-expanded` — die Anzeige des
//             Zustands kann damit gar nicht mehr neben der
//             Barrierefreiheit herlaufen. Rand immer da, im Ruhezustand
//             durchsichtig, also springt beim Oeffnen nichts.
//   AKTION    genau ein Knopf pro Kachel: „Get" / „Install".
//             Als einziger gefuellt UND gerandet.
//
// Warum „Get" NICHT `.lu-primary` traegt, obwohl es die Hauptaktion der
// Kachel ist: es sind 53 Kacheln gleichzeitig sichtbar. 53 Akzentflaechen
// waeren dieselbe Ampelwand, die `FIT_META` weiter oben ausdruecklich
// vermeidet („Color lives ONLY in the tiny status dot"). Der Rang kommt
// hier aus Fuellung + Rand + Schriftgewicht, nicht aus Farbe.
//
// Geometrie aus vorhandenen Tokens: `--control-h-sm` (26px) und
// `--radius-control` (8px) — dieselben, auf denen `.lu-control` steht.
// Damit stehen Anzeige, Control und Aktion in derselben Zeilenhoehe.

/** AKTION — der eine gefuellte Knopf einer Kachel.
 *
 *  D-S24: hier stand `shadow-sm`, 53 Mal auf einem Bildschirm. Das ist
 *  Tailwinds Hell-Rezept `0 1px 2px rgba(0,0,0,.05)` und auf der dunklen
 *  Kachelflaeche schlicht unsichtbar — ein Effekt, den niemand je gesehen
 *  hat, aber jede Kachel bezahlt hat. Getragen wird die Erhebung vom Rand,
 *  den der Knopf ohnehin hat (Hairline-Elevation, wie es der Token-Diff des
 *  Audits fuer genau diese Stelle vorschlaegt). Echte Schatten bleiben den
 *  Flaechen, die wirklich schweben — das Aufklappmenue nimmt dafuer seit
 *  D-T06/D-T09 das Hausrezept `.lu-elevated` (Flaeche + Kante + Schatten
 *  aus einer Quelle) statt einer eigenen Kette. */
const TILE_ACTION =
  'flex items-center gap-1 h-[var(--control-h-sm)] px-2.5 rounded-lg '
  + 'bg-white dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/[0.16] '
  + 'border border-gray-200 dark:border-white/[0.08] text-gray-800 dark:text-gray-100 '
  + 't-micro font-semibold transition-colors'

/** ANZEIGE — ein Zustand, den man lesen und nicht druecken kann. */
const TILE_STATE =
  'flex items-center gap-1 h-[var(--control-h-sm)] px-2 rounded-lg '
  + 'bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 t-micro font-medium'

// ─── Small chips ────────────────────────────────────────────────────

/** ANZEIGE. Bleibt bewusst flach und ohne Hover: sie ist die Groesse, nicht
 *  die Wahl der Groesse. Wo es etwas zu waehlen gibt, steht an derselben
 *  Stelle das Control (siehe `ModelTile`). */
export function SizePill({ sizeGB }: { sizeGB?: number }) {
  if (!sizeGB) return null
  return (
    <span className="t-micro px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 font-medium tabular-nums">
      {sizeGB} GB
    </span>
  )
}

// Capability icons with tooltips replace the old text badges (AGENT /
// CPU-FRIENDLY / Vision tag soup) — same information, far less noise.
// Deliberately monochrome: the info lives in the tooltip, not in a rainbow.
//
// ── D-S22 · vier Glyphen im selben Slot ohne Legende ────────────────
// Der Befund: „Vier verschiedene Glyphen im selben Slot neben dem Titel
// (Flame/Wrench/Eye/Feather), alle 11px, alle text-gray-500, ohne Legende."
// Vier Bedeutungen, eine Optik — und die Bedeutung nur im `title`, also erst
// nach einer Sekunde Stillstehen mit der Maus, nie fuer die Tastatur, nie
// fuer einen Screenreader.
//
// Drei Dinge aendern das, keins davon ist eine neue Farbe:
//
// 1. Flamme raus aus dem Slot. `hot` ist keine Faehigkeit, sondern
//    Beliebtheit — dieselbe Kategorie wie die Downloadzahl `pulls`, und die
//    steht schon in der Metazeile. Ein Slot, der zwei Kategorien mischt, ist
//    genau deshalb nicht lesbar. Uebrig bleiben DREI Glyphen, und die drei
//    beantworten alle dieselbe Frage: „was kann das Modell".
// 2. Eine Tabelle statt vier Call-Sites. `CAPABILITIES` ist die einzige
//    Quelle fuer Icon, Wort und Satz. Die Legende ueber dem Raster
//    (`DiscoverModels`) rendert aus derselben Tabelle — eine Legende, die
//    von den Kacheln abweichen kann, ist schlimmer als keine.
// 3. Jedes Glyph traegt seinen Namen mit: `role="img"` + `aria-label`
//    zusaetzlich zum `title`. Damit existiert die Bedeutung auch ohne Maus.
//
// Groesse aus der Haus-Leiter (`ui/icon-size.ts`, ICON_SM = 12) statt der
// handgesetzten 11 — Legende und Kachel muessen dasselbe Zeichen in
// derselben Groesse zeigen, sonst ist es keine Legende.

export interface Capability {
  key: 'agent' | 'vision' | 'lightweight'
  Icon: LucideIcon
  /** Das Wort in der Legende. Kurz, weil es 53 Mal daneben stehen koennte. */
  label: string
  /** Der ganze Satz — Tooltip auf der Kachel, Titel in der Legende. */
  title: string
  has: (m: DiscoverModel) => boolean
}

export const CAPABILITIES: readonly Capability[] = [
  {
    key: 'agent',
    Icon: Wrench,
    label: 'Tools',
    title: 'Tool calling. Works in Agent Mode',
    has: (m) => !!m.agent,
  },
  {
    key: 'vision',
    Icon: Eye,
    label: 'Images',
    title: 'Understands images (vision)',
    has: (m) => m.tags.some(t => /vision/i.test(t)),
  },
  {
    key: 'lightweight',
    Icon: Feather,
    label: 'No GPU',
    title: 'Runs on 8 GB RAM, CPU only. No GPU needed',
    has: (m) => !!m.lightweight,
  },
] as const

const GLYPH = 'p-0.5 rounded text-gray-400 dark:text-gray-500'

export function CapIcons({ model }: { model: DiscoverModel }) {
  const shown = CAPABILITIES.filter(c => c.has(model))
  if (!shown.length) return null
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map(({ key, Icon, title }) => (
        <span key={key} title={title} aria-label={title} role="img" className={GLYPH}>
          <Icon size={ICON_SM} />
        </span>
      ))}
    </span>
  )
}

/** Beliebtheit, nicht Faehigkeit — steht deshalb bei `pulls`, nicht bei den
 *  Faehigkeiten. Ein eigener Baustein, damit die Trennung im Code sichtbar
 *  ist und nicht nur in der Reihenfolge zweier JSX-Zeilen. */
export function HotMark() {
  return (
    <span
      title="Hot right now"
      aria-label="Hot right now"
      role="img"
      className="shrink-0 text-gray-400 dark:text-gray-500"
    >
      <Flame size={ICON_SM} />
    </span>
  )
}

/** Die Legende zu `CapIcons`. Dieselbe Tabelle, dieselben Zeichen, dieselbe
 *  Groesse — steht einmal ueber dem Raster statt 53 Mal daneben. */
export function CapLegend({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 flex-wrap text-[0.55rem] text-gray-400 dark:text-gray-500 ${className}`}>
      {CAPABILITIES.map(({ key, Icon, label, title }) => (
        <span key={key} className="inline-flex items-center gap-1" title={title}>
          <Icon size={ICON_SM} aria-hidden="true" />
          {label}
        </span>
      ))}
    </div>
  )
}

// ─── Blurb derivation ───────────────────────────────────────────────

// One calm line per card instead of the full catalog description. The full
// text stays reachable via the ⓘ details modal — nothing is lost.
export function shortBlurb(m: DiscoverModel): string {
  if (m.blurb) return m.blurb
  const d = m.description || ''
  // Catalog descriptions are "Name · blurb" (middot separator, dash-free copy
  // rule 2026-07-18); slice off the name part.
  const afterSep = d.includes('·') ? d.slice(d.indexOf('·') + 1) : d
  const dot = afterSep.indexOf('. ')
  const first = dot > 0 ? afterSep.slice(0, dot) : afterSep
  const t = first.trim().replace(/\.\s*$/, '')
  return t.length > 92 ? `${t.slice(0, 89)}…` : t
}

// Human variant label: prefer the quant tag ("Q4_K_M"), else the size.
export function variantLabel(m: DiscoverModel): string {
  const quant = m.tags.find(t => /^(UD-)?(I?Q\d|BF16|FP\d|NVFP\d|MXFP\d|MLX)/i.test(t))
  return quant || (m.sizeGB ? `${m.sizeGB} GB` : m.name)
}

// ─── Grouping ───────────────────────────────────────────────────────

/** Group catalog entries that only differ by quant (same `group` key),
 *  preserving catalog order. Ungrouped entries become 1-element groups. */
export function groupModels(models: DiscoverModel[]): DiscoverModel[][] {
  const order: string[] = []
  const byKey = new Map<string, DiscoverModel[]>()
  for (const m of models) {
    const key = m.group ?? m.name
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key) }
    byKey.get(key)!.push(m)
  }
  return order.map(k => byKey.get(k)!)
}

/** Default variant: installed > downloading > best fit under VRAM > smallest. */
export function pickDefaultVariant(
  variants: DiscoverModel[],
  vramGb: number | null,
  isInstalled: (m: DiscoverModel) => boolean,
  dlState: (m: DiscoverModel) => DownloadProgress | null,
): DiscoverModel {
  const installed = variants.find(isInstalled)
  if (installed) return installed
  const active = variants.find(v => {
    const s = dlState(v)?.status
    return s === 'downloading' || s === 'connecting'
  })
  if (active) return active
  if (vramGb) {
    const fitting = variants.filter(v => v.sizeGB && v.sizeGB <= vramGb * 0.85)
    if (fitting.length) return fitting.reduce((a, b) => ((a.sizeGB ?? 0) >= (b.sizeGB ?? 0) ? a : b))
  }
  return variants.reduce((a, b) => ((a.sizeGB ?? Infinity) <= (b.sizeGB ?? Infinity) ? a : b))
}

// ─── Model tile ─────────────────────────────────────────────────────

export interface ModelTileProps {
  variants: DiscoverModel[]
  vramGb: number | null
  isInstalled: (m: DiscoverModel) => boolean
  dlState: (m: DiscoverModel) => DownloadProgress | null
  onDownload: (m: DiscoverModel) => void
  onInfo: (m: DiscoverModel) => void
  onOpenUrl: (url: string) => void
  /** Load an already installed model into the chat. GH #118: without this the
   *  Installed state is an inert pill, which is the dead end the ticket
   *  describes. Absent = the old badge, for surfaces that cannot activate. */
  onUse?: (m: DiscoverModel) => void
  /** Can `onUse` do anything for THIS row, i.e. is the local model behind it
   *  known by name. */
  canUse?: (m: DiscoverModel) => boolean
  /** Is a Use click for THIS row already running (S6). */
  isUsing?: (m: DiscoverModel) => boolean
  highlight?: boolean
}

export function ModelTile({ variants, vramGb, isInstalled, dlState, onDownload, onInfo, onOpenUrl, onUse, canUse, isUsing, highlight }: ModelTileProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  const def = pickDefaultVariant(variants, vramGb, isInstalled, dlState)
  const sel = variants.find(v => v.name === chosen) ?? def
  const groupTitle = sel.group ?? sel.name
  const dl = dlState(sel)
  const downloading = dl?.status === 'downloading' || dl?.status === 'connecting'
  const installed = isInstalled(sel) || dl?.status === 'complete'
  const externalOnly = sel.canPull === false
  const fit = computeFit(sel.sizeGB, vramGb)
  // One rule for what the button does, so no state can end up without one
  // (lib/model-tile-action.ts).
  const action = modelTileAction({
    externalOnly,
    installed,
    downloading,
    loadable: !!onUse && (canUse ? canUse(sel) : true),
    using: !!isUsing?.(sel),
  })

  useEffect(() => {
    if (!pickerOpen) return
    const close = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    // Ein Aufklapper, der sich `aria-haspopup="listbox"` nennt, muss auf
    // Escape zugehen — sonst ist die Ansage falsch (und die Tastatur sitzt
    // im offenen Menue fest, bis sie irgendwo hinklickt).
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [pickerOpen])

  return (
    <div
      className={`relative rounded-xl border p-3 transition-colors bg-gray-50 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.05] ${
        highlight
          ? 'border-gray-300 dark:border-white/[0.14]'
          : 'border-gray-200 dark:border-white/[0.06]'
      }`}
      data-model-tile={groupTitle}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-[0.78rem] font-semibold text-gray-900 dark:text-white truncate">{groupTitle}</h3>
            <CapIcons model={sel} />
          </div>
          <p className="t-micro text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{shortBlurb(sel)}</p>
        </div>
        <button
          onClick={() => onInfo(sel)}
          className="shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          title="Details"
          aria-label={`Details for ${groupTitle}`}
        >
          <Info size={ICON_SM} />
        </button>
      </div>

      <div className="flex items-center gap-2 mt-2.5 min-h-[var(--control-h-sm)]">
        {/* Variant / size selector — only when the family ships several quants */}
        {variants.length > 1 ? (
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen(o => !o)}
              className="lu-control tabular-nums"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-label={`Size and quality for ${groupTitle}`}
              title="Choose a size / quality"
            >
              {variantLabel(sel)} · {sel.sizeGB} GB
              <ChevronDown size={ICON_SM} className={`transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
            </button>
            {pickerOpen && (
              <div
                role="listbox"
                aria-label={`Size and quality for ${groupTitle}`}
                className="absolute z-30 left-0 top-full mt-1 w-56 rounded-lg lu-elevated p-1"
              >
                {variants.map(v => {
                  const vFit = computeFit(v.sizeGB, vramGb)
                  const vInst = isInstalled(v) || dlState(v)?.status === 'complete'
                  return (
                    <button
                      key={v.name}
                      role="option"
                      aria-selected={v.name === sel.name}
                      onClick={() => { setChosen(v.name); setPickerOpen(false) }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06] ${v.name === sel.name ? 'bg-gray-100 dark:bg-white/[0.06]' : ''}`}
                    >
                      <FitHint fit={vFit} compact />
                      <span className="flex-1 t-micro text-gray-800 dark:text-gray-200">{variantLabel(v)}</span>
                      <span className="t-micro text-gray-400 tabular-nums">{v.sizeGB} GB</span>
                      {vInst && <Check size={ICON_SM} className="text-emerald-500/80" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <SizePill sizeGB={sel.sizeGB} />
        )}

        <FitHint fit={fit} />
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {sel.hot && <HotMark />}
          {sel.pulls && <span className="text-[0.55rem] text-gray-400 dark:text-gray-500 mr-1">{sel.pulls}</span>}

          {/* Ein Zustand, ein Ausgang: die Leiter kommt aus `modelTileAction`
              (GH #118), die Optik aus den Rezepten dieser Datei. `installed`,
              `downloading` und `externalOnly` stehen deshalb nicht mehr
              einzeln in dieser Kette, sie gehen oben in `action` ein. */}
          {action === 'view' ? (
            sel.url ? (
              <button
                onClick={() => onOpenUrl(sel.url!)}
                className="lu-control"
                title="View on HuggingFace"
                aria-label={`View ${groupTitle} on HuggingFace`}
              >
                <ExternalLink size={ICON_SM} /> View
              </button>
            ) : null
          ) : action === 'use' ? (
            <button
              onClick={() => onUse!(sel)}
              className="lu-control"
              title="Installed. Load it in the chat and start the engine if it is not running."
              aria-label={`Use ${sel.name}`}
            >
              <Check size={ICON_SM} className="text-emerald-500/80" /> Use
            </button>
          ) : action === 'using' ? (
            <span className="flex items-center gap-1.5 h-[var(--control-h-sm)] px-2 t-micro text-gray-500 dark:text-gray-400">
              <Loader2 size={ICON_SM} className="animate-spin" /> Loading…
            </span>
          ) : action === 'installed' ? (
            <span className={TILE_STATE}>
              <Check size={ICON_SM} className="text-emerald-500/80" /> Installed
            </span>
          ) : action === 'downloading' ? (
            <span className="flex items-center gap-1.5 h-[var(--control-h-sm)] px-2 t-micro text-gray-500 dark:text-gray-400">
              <Loader2 size={ICON_SM} className="animate-spin" /> Downloading…
            </span>
          ) : (
            <button
              onClick={() => onDownload(sel)}
              className={TILE_ACTION}
              title={sel.sizeGB ? `Download ${sel.sizeGB} GB` : 'Download'}
            >
              <Download size={ICON_SM} /> Get
            </button>
          )}
        </div>
      </div>

      {/* Slim inline progress — the header badge stays the full control center */}
      {downloading && dl && dl.total > 0 && (
        <div className="mt-2">
          <div className="h-1 rounded-full bg-gray-200 dark:bg-white/[0.06] overflow-hidden">
            <div className="h-full rounded-full bg-gray-500 dark:bg-white/60 transition-[width]" style={{ width: `${Math.min(100, (dl.progress / dl.total) * 100)}%` }} />
          </div>
          <div className="flex justify-between mt-0.5 text-[0.55rem] text-gray-400 tabular-nums">
            <span>{formatBytes(dl.progress)} / {formatBytes(dl.total)}</span>
            <span>{Math.round((dl.progress / dl.total) * 100)}%</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Bundle tile (image / video) ────────────────────────────────────

export interface BundleTileProps {
  bundle: ModelBundle
  vramGb: number | null
  complete: boolean
  downloading: boolean
  hasErrors: boolean
  onInstall: () => void
  onRetry: () => void
  onClear: () => void
  onOpenUrl: (url: string) => void
}

export function BundleTile({ bundle, vramGb, complete, downloading, hasErrors, onInstall, onRetry, onClear, onOpenUrl }: BundleTileProps) {
  // No COMING SOON overlay any more (2026-07-24). It was driven by
  // `!bundle.verified && !complete`, a hand-set boolean, and it dimmed the tile
  // behind a full-cover "COMING SOON" pill while that tile's own working
  // "Get · 3.6 GB" button sat underneath. Everything in this catalogue is
  // downloadable and installable right now, so the badge only ever talked
  // people out of models that work.
  //
  // What replaced the flag is stronger than the flag was: app-wide-smoke
  // asserts every catalogued bundle resolves to a real strategy, and
  // wrapper-node-names pins every node name the builder emits against real
  // wrapper registries. A lane that cannot run gets pulled (see the CogVideoX
  // and Pyramid Flow removals) rather than shipped behind a badge.
  // bundleVramNeedGb, not a local parser: the add-on bundles say "any" and the
  // old local one answered 99 GB to that, which painted a 0.17 GB LoRA red.
  const need = bundleVramNeedGb(bundle)
  const fit: Fit = !vramGb ? 'unknown' : need <= vramGb ? 'fits' : need <= vramGb + 2 ? 'tight' : 'big'

  return (
    <div
      className="relative rounded-xl border border-gray-200 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.03] p-3 overflow-hidden transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.05]"
      data-bundle-tile={bundle.name}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-[0.78rem] font-semibold text-gray-900 dark:text-white truncate">{bundle.name}</h3>
            {bundle.hot && !complete && <HotMark />}
          </div>
          {bundle.description && (
            <p className="t-micro text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{bundle.description}</p>
          )}
        </div>
        {bundle.url && (
          <button
            onClick={() => onOpenUrl(bundle.url!)}
            className="shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            title="View on HuggingFace"
            aria-label={`View ${bundle.name} on HuggingFace`}
          >
            <ExternalLink size={ICON_SM} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2.5 min-h-[var(--control-h-sm)]">
        <SizePill sizeGB={bundle.totalSizeGB} />
        <span className="text-[0.55rem] text-gray-400 dark:text-gray-500">{countLabel(bundle.files.length, 'file')}</span>
        <FitHint fit={fit} />

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {complete ? (
            <span className={TILE_STATE}>
              <Check size={ICON_SM} className="text-emerald-500/80" /> Installed
            </span>
          ) : downloading ? (
            <span className="flex items-center gap-1.5 h-[var(--control-h-sm)] px-2 t-micro text-gray-500 dark:text-gray-400">
              <Loader2 size={ICON_SM} className="animate-spin" /> Installing…
            </span>
          ) : hasErrors ? (
            // Rot bleibt hier richtig: dieses Bundle IST kaputt, und Retry ist
            // die Reparatur. Das ist der Unterschied zu D-S24 und zum
            // Ton-Pass an FIT_META — dort hiess Rot „langsam", hier heisst es
            // „fehlgeschlagen".
            <>
              <button
                onClick={onRetry}
                className="flex items-center gap-1 h-[var(--control-h-sm)] px-2 rounded-lg bg-red-100 dark:bg-red-500/15 hover:bg-red-200 dark:hover:bg-red-500/25 text-red-700 dark:text-red-400 t-micro font-medium transition-colors"
                title="Retry failed downloads"
              >
                <RefreshCw size={ICON_SM} /> Retry
              </button>
              <button
                onClick={onClear}
                className="lu-control"
                title="Clear this failed download so you can start over or pick another model"
              >
                <X size={ICON_SM} /> Clear
              </button>
            </>
          ) : (
            <button
              onClick={onInstall}
              className={TILE_ACTION}
              title={`Install ${countLabel(bundle.files.length, 'file')} (${bundle.totalSizeGB} GB)`}
            >
              <Download size={ICON_SM} /> Get · {bundle.totalSizeGB} GB
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Hardware chip ──────────────────────────────────────────────────

export function HardwareChip({ vramGb, ramGb }: { vramGb: number | null; ramGb: number | null }) {
  if (!vramGb && !ramGb) return null
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] t-micro text-gray-600 dark:text-gray-300"
      title="Detected hardware. Used for the 'runs on your PC' hints. Models are never hidden because of it."
    >
      <HardDrive size={ICON_SM} className="text-gray-400" />
      {/* A side we could not measure says so. Zhorts (GH #123) read "62 GB GPU"
          off this chip on a 16 GB card, because the number behind it was his
          system RAM; the source of that is fixed in api/comfyui.ts, and this is
          the other half. Leaving the half out entirely reads as "no GPU", and
          an unmeasured GPU is not the same thing as an absent one. Beide
          Haelften stehen also immer, und der Trenner dazwischen braucht keine
          Bedingung mehr. */}
      {vramGb
        ? <span className="tabular-nums">{Math.round(vramGb)} GB GPU</span>
        : <span>GPU unknown</span>}
      <span className="opacity-40">·</span>
      {ramGb
        ? <span className="tabular-nums">{Math.round(ramGb)} GB RAM</span>
        : <span>RAM unknown</span>}
    </span>
  )
}
