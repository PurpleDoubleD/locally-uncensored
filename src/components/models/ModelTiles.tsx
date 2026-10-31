// Presentational building blocks for the redesigned Model Manager ("Model
// Hub"). All download/install LOGIC stays in DiscoverModels/ModelManager —
// these components only render state and forward events, so the existing
// handlers (Ollama routing, sharded confirm, bundle retry/clear, …) keep
// working unchanged behind a new surface.
import { useEffect, useRef, useState } from 'react'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { isBelowChatMinimum, SMALL_CHAT_MODEL_WARNING } from '../../lib/chat-model-minimum'
import {
  Download, ExternalLink, Info, Check, ChevronDown, Loader2, RefreshCw,
  X, Flame, Wrench, Eye, Feather, HardDrive, FileCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DiscoverModel, DownloadProgress, ModelBundle } from '../../api/discover'
import { formatBytes, countLabel } from '../../lib/formatters'
import { partInputWord } from '../../lib/image-part'
import { vramFit, vramFitLine, vramNeedTitle, type VramFit } from '../../lib/vram-fit'
import { sharedFitWords, sharedMemoryWording } from '../../lib/shared-memory-wording'
import { tierMarks } from '../../lib/render/model-tier'
import { modelTileAction } from '../../lib/model-tile-action'
import { bundleGetPlan } from '../../lib/bundle-state'
import { ICON_SM } from '../ui/icon-size'
import { downloadSizeGB, gbOf } from '../../lib/image-part'
import { CloudOfferLine } from '../cloud/CloudOffer'
import type { CloudOfferTask } from '../../lib/cloud-offer'

// ─── Hardware fit ───────────────────────────────────────────────────

export type Fit = VramFit

// GGUF weights ≈ VRAM need; leave headroom for KV-cache/context. Never used
// to BLOCK a download — purely an honest hint.
/**
 * What a chat model takes in memory and on disk, in GB: the model, plus its
 * image part when it has one and the part comes along. The part is loaded
 * into graphics memory next to the model, so the fit verdict has to count it,
 * and it is downloaded with the model, so the size on the tile has to as well.
 */
export function modelFootprintGb(model: Pick<DiscoverModel, 'sizeGB' | 'mmprojBytes'>, withImagePart = true): number | undefined {
  return downloadSizeGB(model.sizeGB, model.mmprojBytes, withImagePart)
}

export function computeFit(sizeGB: number | undefined, vramGb: number | null): Fit {
  if (!sizeGB || !vramGb) return 'unknown'
  if (sizeGB <= vramGb * 0.85) return 'fits'
  if (sizeGB <= vramGb * 1.15) return 'tight'
  return 'big'
}

// Color lives ONLY in the tiny status dot — labels stay neutral gray so the
// grid doesn't turn into a traffic-light wall (2026-07-17 design pass).
//
// `big` war bis zum Ton-Pass (Audit Welle 3) `bg-red-400/80` mit dem Label
// "Too big for your GPU" — und beides war eine Falschaussage. Rot heisst in
// dieser App an rund hundert Stellen „kaputt oder wird geloescht"; ein Modell,
// das auf CPU und RAM ausweicht, ist keins von beidem, es ist LANGSAMER. Und
// "too big" liest sich als Verbot, obwohl `computeFit` ausdruecklich nie
// blockiert (siehe oben: "Never used to BLOCK a download").
//
// Die Leiter ist eine Folge, kein Fehlergrad. Die mittlere Stufe stand in
// Bernstein, also in genau dem Ton, mit dem diese App bis zum 04.09.2026 jede
// Warnung gemalt hat (die Begruendung, warum es diesen Ton nicht mehr gibt,
// steht in `lib/hinweis.ts`). „Passt knapp" ist keine Warnung: es passt.
//
// Damit hoert die Leiter auf, eine Waermeskala zu sein, denn eine Waermeskala
// braucht in der Mitte Gelb. Sie nennt jetzt den ORT, an dem gerechnet wird:
// ganz im Grafikspeicher (emerald) → knapp, Teile weichen in den Arbeits-
// speicher aus (sky) → groesstenteils auf CPU und RAM (orange). Nebenbei
// gewinnt der 6px-Punkt dabei: Bernstein und Orange sind Nachbarn auf dem
// Farbkreis und waren auf dieser Groesse kaum zu trennen, Blau liegt von
// beiden weit weg.
//
// Gerechnet auf der Kachelflaeche (`bg-gray-50` hell, `bg-white/[0.03]` ueber
// #1e1e1e = #252525 dunkel): der alte mittlere Punkt lag bei 5.08:1 dunkel und
// 1.80:1 hell, sky-500/80 liegt bei 4.01:1 und 2.21:1. Dunkel bleibt 1.4.11
// erfuellt (>= 3:1), hell wird es sogar etwas besser. Fuer `big` galt dieselbe
// Rechnung schon beim Ton-Pass: red-400/80 lag bei 4.05:1 dunkel und 2.20:1
// hell, orange-500/80 liegt bei 3.98:1 und 2.24:1. (Dass die HELLE Seite
// fuer die ganze Leiter unter 3:1 liegt, ist ein aelterer, eigener Befund; er
// betrifft alle vier Punkte gleich und wird hier nicht einseitig fuer einen
// davon repariert.)
export const FIT_META: Record<Fit, { dot: string; label: string; title: string }> = {
  fits: { dot: 'bg-emerald-500/80', label: 'Runs on your PC', title: 'Fits fully in your GPU memory. Fast.' },
  tight: { dot: 'bg-sky-500/80', label: 'Tight fit', title: 'Barely fits. Parts may spill to RAM and slow it down.' },
  big: { dot: 'bg-orange-500/80', label: 'Runs on CPU, slower', title: 'Bigger than your GPU memory, so most of it runs on CPU and RAM. It works, just slower.' },
  unknown: { dot: 'bg-gray-400 dark:bg-gray-600', label: '', title: 'Hardware not detected yet.' },
}

/** `sharedMemory`: a machine with one memory pool (a Mac). The dot keeps its
 *  colour, the words stop naming a PC, a GPU and a CPU fallback that such a
 *  machine does not have (lib/shared-memory-wording.ts). */
export function FitHint({ fit, compact = false, sharedMemory = false }: { fit: Fit; compact?: boolean; sharedMemory?: boolean }) {
  if (fit === 'unknown') return null
  const meta = FIT_META[fit]
  const words = sharedMemory ? sharedFitWords(fit) : meta
  return (
    <span className="inline-flex items-center gap-1" title={words.title} data-fit={fit}>
      <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${meta.dot}`} />
      {!compact && (
        // One line: a verdict broken in two ("Runs on your" / "PC") made a
        // narrow tile a row taller than its neighbour.
        <span className="t-micro whitespace-nowrap text-gray-500 dark:text-gray-400">
          {words.label}
        </span>
      )}
    </span>
  )
}

// ─── Three roles, three looks ───────────────────────────────────────
//
// D-S23 (audit): the quant dropdown and the static size chip carried the same
// classes at the same place, `px-1.5 py-0.5 rounded-md bg-gray-100`, and the
// only difference was a 10px chevron. A control that looked like a display.
// The footer of a tile has known three roles since, and each looks different.
// The redesign of 08.10.2026 kept the three roles and changed the look of two:
//
//   DISPLAY   the size, "Installed", the progress line.
//             Plain text. No container, no hover, no focus, no state. It was
//             a flat grey chip; a chip is a shape, and a shape next to the
//             picker is exactly what D-S23 was about.
//   CONTROL   the variant picker, "View", "Stop", "Remove", "Clear":
//             `.lu-control lu-control--outline`, the neutral recipe of the
//             house with its edge showing, because on a card a control stands
//             alone and without an edge it reads as a label. Open and pressed
//             still come from ARIA, so the look cannot drift from the state.
//   ACTION    exactly one per tile, "Get" or "Use": `.lu-tonal`.
//
// Why the action is tinted. Until this redesign Get was neutral, filled and
// edged, and the reasoning stood here: 53 tiles are on screen at once, 53
// accent surfaces would be the traffic light wall `FIT_META` avoids, so the
// rank came from fill, edge and weight instead of colour. The owner's verdict on
// the result, 08.10.2026: "Man weiss nicht, wo man draufklicken soll." Rank
// without colour did not carry. The answer is not `.lu-primary` 53 times, it
// is the tint between the two (index.css, `.lu-tonal`): the accent at 12 %
// with the accent as its word. A model that does not fit this machine keeps
// a neutral Get, so the tint also says which cards are worth the download.
//
// Geometry from the tokens the neutral recipe stands on, `--control-h-sm`
// (26px) and `--radius-control` (8px), so display, control and action share
// one line height.

/** ACTION: the one tinted button of a tile. One constant, so that the three
 *  tiles cannot each grow a copy of it (D-S24). It carries no shadow: on the
 *  dark tile a shadow is invisible, the edge of the recipe does the lifting.
 *  Real shadows stay with what really floats, the picker's list takes
 *  `.lu-elevated`. */
export const TILE_ACTION = 'lu-tonal'

/** The same slot on a tile whose model does not fit this machine. Still a
 *  button and still Get, without the tint that recommends it. */
export const TILE_ACTION_QUIET = 'lu-control lu-control--outline'

/** CONTROL: what stands alone in a tile footer and is not its action. */
export const TILE_CONTROL = 'lu-control lu-control--outline'

/** DISPLAY: a state to read, not to press. Green is the one state colour a
 *  tile spends on text, and only on this word. Computed on the tile surface:
 *  emerald-700 on #f9fafb 5.25:1, emerald-400 on #252525 7.97:1. */
export const TILE_STATE =
  'inline-flex items-center gap-1 h-[var(--control-h-sm)] t-micro font-medium whitespace-nowrap '
  + 'text-emerald-700 dark:text-emerald-400'

/** DISPLAY: something in flight. Read by a screen reader as it changes. */
export const TILE_BUSY =
  'inline-flex items-center gap-1.5 h-[var(--control-h-sm)] t-micro whitespace-nowrap '
  + 'text-gray-500 dark:text-gray-400'

/** The quiet line of facts in a tile footer: size, memory, file count. */
export const TILE_META = 't-micro tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400'

/** The name of a tile. A model that does not fit steps back one tone. */
export const tileTitle = (fits: boolean) =>
  `t-title truncate ${fits ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`

/** The two lines under the name. */
export const TILE_TEXT = 'mt-1 text-xs leading-snug line-clamp-2 text-gray-500 dark:text-gray-400'

/** The track and fill of a download in a tile. The fill is the accent: a
 *  running download is the one thing on the page that moves. */
export const TILE_BAR = 'h-1 rounded-full overflow-hidden bg-gray-200 dark:bg-white/[0.08]'
export const TILE_BAR_FILL = 'h-full rounded-full bg-lu-accent transition-[width] duration-[var(--motion-slow)]'

// ─── Small pieces ───────────────────────────────────────────────────

/** DISPLAY. The size as text. Where there is a choice of sizes the picker
 *  stands at the same place (see `ModelTile`), and the picker has an edge. */
export function TileSize({ sizeGB, bytes }: { sizeGB?: number; bytes?: number }) {
  if (!sizeGB && !bytes) return null
  return (
    <span className={TILE_META} data-tile-size>
      {bytes ? formatBytes(bytes) : `${sizeGB} GB`}
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
  /** Word and sentence on a machine with one memory pool (a Mac), where the
   *  PC wording would name hardware that is not there. */
  shared?: { label: string; title: string }
  has: (m: DiscoverModel) => boolean
}

const capWords = (c: Capability, sharedMemory: boolean) => (sharedMemory && c.shared ? c.shared : c)

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
    shared: { label: 'Light', title: 'Light enough for a Mac with 8 GB of memory' },
    has: (m) => !!m.lightweight,
  },
] as const

const GLYPH = 'p-0.5 rounded text-gray-400 dark:text-gray-500'

export function CapIcons({ model, sharedMemory = false }: { model: DiscoverModel; sharedMemory?: boolean }) {
  const shown = CAPABILITIES.filter(c => c.has(model))
  if (!shown.length) return null
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map((c) => {
        const { title } = capWords(c, sharedMemory)
        return (
          <span key={c.key} title={title} aria-label={title} role="img" className={GLYPH}>
            <c.Icon size={ICON_SM} />
          </span>
        )
      })}
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

const CAP_LEGEND_INK = 't-micro text-gray-500 dark:text-gray-400'

/** Die Legende zu `CapIcons`. Dieselbe Tabelle, dieselben Zeichen, dieselbe
 *  Groesse — steht einmal ueber dem Raster statt 53 Mal daneben. */
export function CapLegend({ className = '', sharedMemory = false, ink = CAP_LEGEND_INK }: { className?: string; sharedMemory?: boolean; /** Size and tone of the words. The classic face brings its own. */ ink?: string }) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${ink} ${className}`}>
      {CAPABILITIES.map((c) => {
        const { label, title } = capWords(c, sharedMemory)
        return (
          <span key={c.key} className="inline-flex items-center gap-1" title={title}>
            <c.Icon size={ICON_SM} aria-hidden="true" />
            {label}
          </span>
        )
      })}
    </div>
  )
}

// ─── Blurb derivation ───────────────────────────────────────────────

// One calm line per card instead of the full catalog description. The full
// text stays reachable via the ⓘ details modal — nothing is lost.
export function shortBlurb(m: DiscoverModel, sharedMemory = false): string {
  if (m.blurb) return sharedMemoryWording(m.blurb, sharedMemory)
  // Rewritten before it is cut: the Mac sentence can be the longer one.
  const d = sharedMemoryWording(m.description || '', sharedMemory)
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
    const fitting = variants.filter(v => v.sizeGB && (modelFootprintGb(v) ?? v.sizeGB) <= vramGb * 0.85)
    if (fitting.length) return fitting.reduce((a, b) => ((a.sizeGB ?? 0) >= (b.sizeGB ?? 0) ? a : b))
  }
  return variants.reduce((a, b) => ((a.sizeGB ?? Infinity) <= (b.sizeGB ?? Infinity) ? a : b))
}

// ─── Model tile ─────────────────────────────────────────────────────

export interface ModelTileProps {
  variants: DiscoverModel[]
  /** What a model is compared with: the graphics card on a PC, the share of
   *  the memory pool a model can take on a Mac (`chatModelBudgetGb`). */
  vramGb: number | null
  /** True on a machine with one memory pool (a Mac): the tile speaks of
   *  memory and of this Mac, never of a card, a GPU or a PC. */
  sharedMemory?: boolean
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
  /** Check files (GH #113) for an installed row. Shown only where
   *  `canCheck` says the files are where the check looks for them. */
  onCheck?: (m: DiscoverModel) => void
  canCheck?: (m: DiscoverModel) => boolean
  /** Does the download of THIS row bring the image part along. Absent = yes,
   *  which is the default everywhere; false only after the user unticked it. */
  withImagePart?: (m: DiscoverModel) => boolean
  highlight?: boolean
}

/** What a chat tile knows and does, without its look: which variant is
 *  chosen, whether it fits, what its one button does, and the size picker's
 *  open state with its two ways out. The two faces of the tile (this file for
 *  the Mac, skin/ClassicTiles.tsx for Windows and Linux) both stand on it, so
 *  the rules exist once. */
export function useModelTile({ variants, vramGb, isInstalled, dlState, onUse, canUse, isUsing, withImagePart }: ModelTileProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const variantListRef = useRef<HTMLDivElement>(null)
  const variantList = usePopoverPlatz(variantListRef, pickerOpen)

  const def = pickDefaultVariant(variants, vramGb, isInstalled, dlState)
  const sel = variants.find(v => v.name === chosen) ?? def
  const groupTitle = sel.group ?? sel.name
  const dl = dlState(sel)
  const downloading = dl?.status === 'downloading' || dl?.status === 'connecting'
  const installed = isInstalled(sel) || dl?.status === 'complete'
  const externalOnly = sel.canPull === false
  // Size and fit count the image part whenever it comes along.
  const sizeOf = (m: DiscoverModel) => modelFootprintGb(m, withImagePart ? withImagePart(m) : true)
  const selSize = sizeOf(sel)
  const partComes = !!sel.mmprojBytes && (withImagePart ? withImagePart(sel) : true)
  const fit = computeFit(selSize, vramGb)
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

  // What the Get button says it fetches. With an image part that comes along
  // the two halves are named, so the sum on the tile is not a surprise.
  const downloadTitle = !selSize
    ? 'Download'
    : partComes
      ? `Download ${selSize} GB (model ${sel.sizeGB} GB, ${partInputWord(sel)} ${gbOf(sel.mmprojBytes)} GB)`
      : `Download ${selSize} GB`

  return { pickerOpen, setPickerOpen, setChosen, pickerRef, variantListRef, variantList, sel, groupTitle, dl, downloading, fit, action, sizeOf, selSize, downloadTitle }
}

export function ModelTile(props: ModelTileProps) {
  const { variants, vramGb, sharedMemory = false, isInstalled, dlState, onDownload, onInfo, onOpenUrl, onUse, highlight } = props
  const { pickerOpen, setPickerOpen, setChosen, pickerRef, variantListRef, variantList, sel, groupTitle, dl, downloading, fit, action, sizeOf, selSize, downloadTitle } = useModelTile(props)

  // A model past what this machine can give it keeps its Get, without the
  // tint that recommends it, and its name steps back one tone.
  const fitsHere = fit !== 'big'

  return (
    <div
      className={`lu-tile relative flex h-full flex-col p-3.5 ${highlight ? 'lu-tile--lead' : ''}`}
      data-model-tile={groupTitle}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className={tileTitle(fitsHere)}>{groupTitle}</h3>
            <CapIcons model={sel} sharedMemory={sharedMemory} />
          </div>
          <p className={TILE_TEXT}>{shortBlurb(sel, sharedMemory)}</p>
        </div>
        <button
          onClick={() => onInfo(sel)}
          className="lu-control lu-control--icon -mr-1.5 -mt-1"
          title="Details"
          aria-label={`Details for ${groupTitle}`}
        >
          <Info size={ICON_SM} />
        </button>
      </div>

      {isBelowChatMinimum(sel) && (
        <p data-testid="small-chat-model-warning" className="mt-2 text-xs leading-relaxed text-gray-700 dark:text-gray-200">
          {SMALL_CHAT_MODEL_WARNING}
        </p>
      )}

      {/* The verdict has a line of its own, as on the media tiles. It stood in
          the footer between the picker and Get, where it was the first thing
          a narrow tile squeezed. */}
      {fit !== 'unknown' && (
        <p className="mt-2 flex">
          <FitHint fit={fit} sharedMemory={sharedMemory} />
        </p>
      )}
      {/* Too big for this machine and not here yet: the one place LU Cloud
          is named on a chat tile (lib/cloud-offer.ts). */}
      {fit === 'big' && action === 'get' && <CloudOfferLine task="chat" sharedMemory={sharedMemory} />}

      <div className="flex items-center gap-2 mt-auto pt-3 min-h-[var(--control-h-sm)]">
        {/* Variant / size selector — only when the family ships several quants */}
        {variants.length > 1 ? (
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen(o => !o)}
              className="lu-control lu-control--outline tabular-nums"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-label={`Size and quality for ${groupTitle}`}
              title="Choose a size / quality"
            >
              {variantLabel(sel)} · {selSize} GB
              <ChevronDown size={ICON_SM} className={`transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
            </button>
            {pickerOpen && (
              <div
                role="listbox"
                aria-label={`Size and quality for ${groupTitle}`}
                ref={variantListRef}
                style={variantList.style}
                className={`absolute z-30 left-0 w-56 rounded-lg lu-elevated p-1 overflow-y-auto scrollbar-thin ${variantList.nachOben ? 'bottom-full mb-1' : 'top-full mt-1'}`}
              >
                {variants.map(v => {
                  const vFit = computeFit(sizeOf(v), vramGb)
                  const vInst = isInstalled(v) || dlState(v)?.status === 'complete'
                  return (
                    <button
                      key={v.name}
                      role="option"
                      aria-selected={v.name === sel.name}
                      onClick={() => { setChosen(v.name); setPickerOpen(false) }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06] ${v.name === sel.name ? 'bg-gray-100 dark:bg-white/[0.06]' : ''}`}
                    >
                      <FitHint fit={vFit} compact sharedMemory={sharedMemory} />
                      <span className="flex-1 t-micro text-gray-800 dark:text-gray-200">{variantLabel(v)}</span>
                      <span className="t-micro text-gray-400 tabular-nums">{sizeOf(v)} GB</span>
                      {vInst && <Check size={ICON_SM} className="text-emerald-700 dark:text-emerald-400" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <TileSize sizeGB={selSize} />
        )}

        {/* Popularity is the one thing in this row that may go. The box takes
            the room that is left and is one line high; when the count does
            not fit beside its zero-width anchor it wraps to a second line,
            and that line is cut off. So in a narrow tile the count is gone as
            a whole, and neither the picker nor Get is squeezed or pushed out
            (1024 px, two columns: Get stood outside the tile). */}
        <div className="flex flex-1 min-w-0 flex-wrap justify-end gap-x-1.5 h-[var(--control-h-sm)] overflow-hidden" data-tile-popularity>
          <span className="w-0 h-full" aria-hidden="true" />
          {(sel.hot || sel.pulls) && (
            <span className="flex items-center gap-1.5 h-full whitespace-nowrap">
              {sel.hot && <HotMark />}
              {sel.pulls && <span className={TILE_META}>{sel.pulls}</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">

          {/* Ein Zustand, ein Ausgang: die Leiter kommt aus `modelTileAction`
              (GH #118), die Optik aus den Rezepten dieser Datei. `installed`,
              `downloading` und `externalOnly` stehen deshalb nicht mehr
              einzeln in dieser Kette, sie gehen oben in `action` ein. */}
          {props.onCheck && (action === 'use' || action === 'installed') && (!props.canCheck || props.canCheck(sel)) && (
            <CheckFilesButton onClick={() => props.onCheck!(sel)} label={false} name={sel.name} />
          )}
          {action === 'view' ? (
            sel.url ? (
              <button
                onClick={() => onOpenUrl(sel.url!)}
                className={TILE_CONTROL}
                title="View on HuggingFace"
                aria-label={`View ${groupTitle} on HuggingFace`}
              >
                <ExternalLink size={ICON_SM} /> View
              </button>
            ) : null
          ) : action === 'use' ? (
            // Installed and loadable: Use is this tile's action now, so it
            // takes the tint Get had.
            <button
              onClick={() => onUse!(sel)}
              className={TILE_ACTION}
              title="Installed. Load it in the chat and start the engine if it is not running."
              aria-label={`Use ${sel.name}`}
            >
              <Check size={ICON_SM} /> Use
            </button>
          ) : action === 'using' ? (
            <span className={TILE_BUSY}>
              <Loader2 size={ICON_SM} className="animate-spin" /> Loading…
            </span>
          ) : action === 'installed' ? (
            <span className={TILE_STATE}>
              <Check size={ICON_SM} /> Installed
            </span>
          ) : action === 'downloading' ? (
            <span className={TILE_BUSY}>
              <Loader2 size={ICON_SM} className="animate-spin" /> Downloading…
            </span>
          ) : (
            <button
              onClick={() => onDownload(sel)}
              className={fitsHere ? TILE_ACTION : TILE_ACTION_QUIET}
              title={downloadTitle}
            >
              <Download size={ICON_SM} /> Get
            </button>
          )}
        </div>
      </div>

      {/* Slim inline progress — the header badge stays the full control center */}
      {downloading && dl && dl.total > 0 && (
        <div className="mt-2.5">
          <div className={TILE_BAR}>
            <div className={TILE_BAR_FILL} style={{ width: `${Math.min(100, (dl.progress / dl.total) * 100)}%` }} />
          </div>
          <div className={`flex justify-between mt-1 ${TILE_META}`}>
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
  /** Which Create lane a non-video bundle belongs to (Music, Lip sync, Motion). */
  lane?: string
  vramGb: number | null
  /** True where graphics unit and processor share one memory pool (a Mac).
   *  There is no card to name there, so the tile keeps the general hint. */
  sharedMemory?: boolean
  complete: boolean
  /** The bundle's files that are on disk already (bundles share files). The
   *  card announces only what Get will really fetch. */
  filesOnDisk?: ReadonlySet<string>
  downloading: boolean
  hasErrors: boolean
  onInstall: () => void
  onRetry: () => void
  onClear: () => void
  onOpenUrl: (url: string) => void
  /** Check files (GH #113): compare the bundle's files with the catalog and
   *  repair the broken ones. Absent: no button. */
  onCheck?: () => void
  /** The Create tab this bundle serves, for the LU Cloud line on a bundle
   *  that does not fit (lib/cloud-offer.ts). Absent: no line. */
  cloudTask?: CloudOfferTask
}

/** Whether a bundle tile names LU Cloud: its model does not fit and it is
 *  neither here, nor on its way, nor broken. An add-on never does: it has no
 *  verdict of its own, its model's tile speaks for it. Both faces ask this. */
export function bundleOffersCloud(fit: Fit, p: Pick<BundleTileProps, 'bundle' | 'cloudTask' | 'complete' | 'downloading' | 'hasErrors'>): boolean {
  return fit === 'big' && !p.bundle.addonFor && !!p.cloudTask && !p.complete && !p.downloading && !p.hasErrors
}

const NO_FILES: ReadonlySet<string> = new Set()

/** Whether a bundle tile offers Check files: something of it is on disk
 *  (installed, failed, or some files already here) and nothing is moving.
 *  A bundle with nothing on disk has nothing to check. Both faces ask this. */
export function bundleOffersCheck(p: Pick<BundleTileProps, 'onCheck' | 'complete' | 'downloading' | 'hasErrors'>, present: number): boolean {
  return !!p.onCheck && !p.downloading && (p.complete || p.hasErrors || present > 0)
}

/** The Check files button of a tile. With a label where the tile has room
 *  (an installed bundle shows only its pill), an icon where Retry and Clear
 *  stand already. */
export function CheckFilesButton({ onClick, label, name, className = TILE_CONTROL }: { onClick: () => void; label: boolean; name: string; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={label ? className : 'lu-control lu-control--icon'}
      title="Check files: compare every file with the catalog and repair the broken ones"
      aria-label={`Check files of ${name}`}
      data-check-files={name}
    >
      <FileCheck size={ICON_SM} />{label && ' Check files'}
    </button>
  )
}

/** What a bundle tile says, without its look: the verdict, the line that
 *  names the card or the model an add-on belongs to, and what Get still has to
 *  fetch. Both faces of the tile read it from here. */
export function bundleTileFacts({ bundle, vramGb, sharedMemory = false, filesOnDisk = NO_FILES }: Pick<BundleTileProps, 'bundle' | 'vramGb' | 'sharedMemory' | 'filesOnDisk'>) {
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
  // One rule for every bundle (lib/vram-fit): below the catalogue's minimum the
  // card needs more, from the comfortable value up it fits, between the two it
  // is tight. The add-ons say "any" and fit every card, the companion files
  // name no number and get no verdict.
  const fit: Fit = vramFit(bundle, vramGb)
  // With a detected card the tile names it and says what tight costs: the
  // owner's 12 GB box sat five minutes in a load the old "10-16 GB" never
  // announced. Shared memory has no card to name and keeps the general hint.
  // An add-on carries no verdict of its own: it says what it belongs to, and
  // that model's card says whether it runs here. The box, 03.10.2026, read
  // "Needs more than your 12 GB card" under the 1.82 GB H3 turbo LoRA.
  const addonLine = bundle.addonFor ? `For ${bundle.addonFor}` : ''
  const cardLine = sharedMemory || addonLine ? '' : vramFitLine(fit, vramGb)
  // Sizes come from the files' own byte counts, and Get names what is still
  // missing: the box, 03.10.2026, read "Get · 16.1 GB" on a card whose click
  // fetched one file of 8.7 GB, the other two being shared and already there.
  const plan = bundleGetPlan(bundle, filesOnDisk)
  const fetchSize = formatBytes(plan.fetchBytes)
  const alreadyHere = plan.present > 0 ? `, ${plan.present} already here` : ''
  return { fit, addonLine, cardLine, plan, fetchSize, alreadyHere }
}

export function BundleTile(props: BundleTileProps) {
  const { bundle, lane, complete, downloading, hasErrors, onInstall, onRetry, onClear, onOpenUrl } = props
  const { fit, addonLine, cardLine, plan, fetchSize, alreadyHere } = bundleTileFacts(props)

  const fitsHere = fit !== 'big'

  return (
    <div className="lu-tile relative flex h-full flex-col p-3.5" data-bundle-tile={bundle.name}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className={tileTitle(fitsHere)}>{bundle.name}</h3>
            {bundle.hot && !complete && <HotMark />}
            {lane && (
              <span data-bundle-lane={lane} className="shrink-0 rounded px-1.5 py-0.5 t-micro font-semibold bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-300">{lane}</span>
            )}
            {/* The accent mark takes the ink in the light: the accent itself
                stands 2.60:1 on a light tile and cannot carry a word there. */}
            {tierMarks(bundle).map((t) => (
              <span key={t.label} className={`shrink-0 rounded px-1.5 py-0.5 t-micro font-semibold ${t.tone === 'accent' ? 'bg-lu-accent-soft text-lu-accent-ink dark:text-lu-accent' : 'text-gray-500 dark:text-gray-600'}`}>{t.label}</span>
            ))}
          </div>
          {bundle.description && (
            <p className={TILE_TEXT}>{bundle.description}</p>
          )}
          {addonLine && (
            <p className="mt-2 t-micro text-gray-500 dark:text-gray-400" data-bundle-addon-for={bundle.addonFor}>{addonLine}</p>
          )}
          {cardLine && (
            <p
              className="flex items-center gap-1.5 mt-2 t-micro text-gray-500 dark:text-gray-400"
              data-bundle-fit={fit}
              title={vramNeedTitle(bundle)}
            >
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${FIT_META[fit].dot}`} />
              <span>{cardLine}</span>
            </p>
          )}
          {/* The general verdict, where no card is named and the tile is no
              add-on. Same line as the card verdict, never both. */}
          {!cardLine && !addonLine && fit !== 'unknown' && (
            <p className="mt-2 flex">
              <FitHint fit={fit} />
            </p>
          )}
          {bundleOffersCloud(fit, props) && <CloudOfferLine task={props.cloudTask!} sharedMemory={props.sharedMemory} />}
        </div>
        {bundle.url && (
          <button
            onClick={() => onOpenUrl(bundle.url!)}
            className="lu-control lu-control--icon -mr-1.5 -mt-1"
            title="View on HuggingFace"
            aria-label={`View ${bundle.name} on HuggingFace`}
          >
            <ExternalLink size={ICON_SM} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-auto pt-3 min-h-[var(--control-h-sm)]">
        {/* The size of the whole bundle and its file count: what the card is.
            Get, on the right, names what a click still has to fetch. */}
        <div className="flex flex-1 min-w-0 items-center overflow-hidden">
          <TileSize bytes={plan.totalBytes} /><span className={`${TILE_META} before:mx-1.5 before:content-['·']`}>{countLabel(bundle.files.length, 'file')}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {bundleOffersCheck(props, plan.present) && (
            <CheckFilesButton onClick={props.onCheck!} label={complete} name={bundle.name} />
          )}
          {complete ? (
            <span className={TILE_STATE}>
              <Check size={ICON_SM} /> Installed
            </span>
          ) : downloading ? (
            <span className={TILE_BUSY}>
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
                className={TILE_CONTROL}
                title="Clear this failed download so you can start over or pick another model"
              >
                <X size={ICON_SM} /> Clear
              </button>
            </>
          ) : (
            <button
              onClick={onInstall}
              className={fitsHere ? TILE_ACTION : TILE_ACTION_QUIET}
              title={`Install ${countLabel(plan.fetchFiles, 'file')} (${fetchSize})${alreadyHere}`}
            >
              <Download size={ICON_SM} /> Get · {fetchSize}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── This machine ───────────────────────────────────────────────────
//
// One reading, two settings. On a wide window it stands at the foot of the
// Models rail (`HardwareFoot`), where it holds for every lane and view. Where
// the rail is only icons it is the chip in the filter row (`HardwareChip`).
// The rules are the same in both and stand at the chip.

const CHIP =
  'inline-flex items-center gap-1.5 h-[var(--control-h-sm)] px-2 rounded-lg border t-micro whitespace-nowrap '
  + 'border-gray-200 dark:border-white/[0.08] text-gray-600 dark:text-gray-300'

export function HardwareChip({ vramGb, ramGb, sharedMemory = false, surface = CHIP }: { vramGb: number | null; ramGb: number | null; sharedMemory?: boolean; /** The chip's own chain of classes. The classic face brings its own. */ surface?: string }) {
  if (!vramGb && !ramGb) return null
  // A Mac has one pool for processor and graphics unit. Two numbers side by
  // side would name a card nobody owns.
  if (sharedMemory) {
    const pool = ramGb ?? vramGb
    return (
      <span
        className={surface}
        title="The memory of this Mac, shared by processor and graphics. Used for the 'runs on this Mac' hints. Models are never hidden because of it."
        data-hardware-chip="shared"
      >
        <HardDrive size={ICON_SM} className="text-gray-400" />
        <span className="tabular-nums">{Math.round(pool!)} GB memory</span>
      </span>
    )
  }
  return (
    <span
      className={surface}
      title="Detected hardware. Used for the 'runs on your PC' hints. Models are never hidden because of it."
    >
      <HardDrive size={ICON_SM} className="text-gray-400" />
      {/* A side we could not measure says so. A user (GH #123) read "62 GB GPU"
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

/** The figure a verdict is measured against, large, with its unit beside it. */
function Figure({ gb, unit }: { gb: number; unit: string }) {
  return (
    <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
      <span className="t-display text-gray-900 dark:text-white">{Math.round(gb)}</span> GB {unit}
    </span>
  )
}

/** The same reading as `HardwareChip`, set as the foot of the Models rail.
 *  The first figure is the one the verdicts compare with: the pool on a Mac,
 *  the card on a PC. An unmeasured side says so here too. */
export function HardwareFoot({ vramGb, ramGb, sharedMemory = false }: { vramGb: number | null; ramGb: number | null; sharedMemory?: boolean }) {
  if (!vramGb && !ramGb) return null
  if (sharedMemory) {
    const pool = ramGb ?? vramGb
    return (
      <div title="The memory of this Mac, shared by processor and graphics. Used for the 'runs on this Mac' hints. Models are never hidden because of it.">
        <p className="t-label text-gray-500 dark:text-gray-400">This Mac</p>
        <p className="mt-2" data-hardware-chip="shared"><Figure gb={pool!} unit="memory" /></p>
      </div>
    )
  }
  return (
    <div title="Detected hardware. Used for the 'runs on your PC' hints. Models are never hidden because of it.">
      <p className="t-label text-gray-500 dark:text-gray-400">This PC</p>
      <p className="mt-2">
        {vramGb ? <Figure gb={vramGb} unit="GPU" /> : <span className="text-xs text-gray-500 dark:text-gray-400">GPU unknown</span>}
      </p>
      <p className="mt-1 text-xs tabular-nums text-gray-500 dark:text-gray-400">
        {ramGb ? <span>{Math.round(ramGb)} GB RAM</span> : <span>RAM unknown</span>}
      </p>
    </div>
  )
}
