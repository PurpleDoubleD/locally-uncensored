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
import type { DiscoverModel, DownloadProgress, ModelBundle } from '../../api/discover'
import { formatBytes } from '../../lib/formatters'
import { bundleVramNeedGb } from '../../lib/hardware'

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
const FIT_META: Record<Fit, { dot: string; label: string; title: string }> = {
  fits: { dot: 'bg-emerald-500/80', label: 'Runs on your PC', title: 'Fits fully in your GPU memory. Fast.' },
  tight: { dot: 'bg-amber-500/80', label: 'Tight fit', title: 'Barely fits. Parts may spill to RAM and slow it down.' },
  big: { dot: 'bg-red-400/80', label: 'Too big for your GPU', title: 'Bigger than your GPU memory. Runs mostly on CPU/RAM, slow. You can still try it.' },
  unknown: { dot: 'bg-gray-400 dark:bg-gray-600', label: '', title: 'Hardware not detected yet.' },
}

export function FitHint({ fit, compact = false }: { fit: Fit; compact?: boolean }) {
  if (fit === 'unknown') return null
  const meta = FIT_META[fit]
  return (
    <span className="inline-flex items-center gap-1" title={meta.title}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {!compact && (
        <span className="text-[0.58rem] text-gray-500 dark:text-gray-400">
          {meta.label}
        </span>
      )}
    </span>
  )
}

// ─── Small chips ────────────────────────────────────────────────────

export function SizePill({ sizeGB }: { sizeGB?: number }) {
  if (!sizeGB) return null
  return (
    <span className="text-[0.58rem] px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 font-medium tabular-nums">
      {sizeGB} GB
    </span>
  )
}

// Capability icons with tooltips replace the old text badges (AGENT /
// CPU-FRIENDLY / Vision tag soup) — same information, far less noise.
// Deliberately monochrome: the info lives in the tooltip, not in a rainbow.
export function CapIcons({ model }: { model: DiscoverModel }) {
  const vision = model.tags.some(t => /vision/i.test(t))
  const c = 'p-0.5 rounded text-gray-400 dark:text-gray-500'
  return (
    <span className="inline-flex items-center gap-1">
      {model.hot && (
        <span title="Hot right now" className={c}><Flame size={11} /></span>
      )}
      {model.agent && (
        <span title="Tool calling. Works in Agent Mode" className={c}><Wrench size={11} /></span>
      )}
      {vision && (
        <span title="Understands images (vision)" className={c}><Eye size={11} /></span>
      )}
      {model.lightweight && (
        <span title="Runs on 8 GB RAM, CPU only. No GPU needed" className={c}><Feather size={11} /></span>
      )}
    </span>
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
  highlight?: boolean
}

export function ModelTile({ variants, vramGb, isInstalled, dlState, onDownload, onInfo, onOpenUrl, highlight }: ModelTileProps) {
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

  useEffect(() => {
    if (!pickerOpen) return
    const close = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
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
          <p className="text-[0.62rem] text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{shortBlurb(sel)}</p>
        </div>
        <button
          onClick={() => onInfo(sel)}
          className="shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          title="Details"
          aria-label={`Details for ${groupTitle}`}
        >
          <Info size={12} />
        </button>
      </div>

      <div className="flex items-center gap-2 mt-2.5">
        {/* Variant / size selector — only when the family ships several quants */}
        {variants.length > 1 ? (
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen(o => !o)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-[0.58rem] font-medium text-gray-700 dark:text-gray-200 transition-colors"
              title="Choose a size / quality"
            >
              <span className="tabular-nums">{variantLabel(sel)} · {sel.sizeGB} GB</span>
              <ChevronDown size={10} className={`transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
            </button>
            {pickerOpen && (
              <div className="absolute z-30 left-0 top-full mt-1 w-56 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#17171c] shadow-xl p-1">
                {variants.map(v => {
                  const vFit = computeFit(v.sizeGB, vramGb)
                  const vInst = isInstalled(v) || dlState(v)?.status === 'complete'
                  return (
                    <button
                      key={v.name}
                      onClick={() => { setChosen(v.name); setPickerOpen(false) }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06] ${v.name === sel.name ? 'bg-gray-100 dark:bg-white/[0.06]' : ''}`}
                    >
                      <FitHint fit={vFit} compact />
                      <span className="flex-1 text-[0.62rem] text-gray-800 dark:text-gray-200">{variantLabel(v)}</span>
                      <span className="text-[0.58rem] text-gray-400 tabular-nums">{v.sizeGB} GB</span>
                      {vInst && <Check size={11} className="text-emerald-500/80" />}
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
        {sel.pulls && <span className="text-[0.55rem] text-gray-400 dark:text-gray-500 ml-auto mr-1">{sel.pulls}</span>}

        <div className={`flex items-center gap-1 shrink-0 ${sel.pulls ? '' : 'ml-auto'}`}>
          {externalOnly ? (
            sel.url ? (
              <button
                onClick={() => onOpenUrl(sel.url!)}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-[0.62rem] font-medium text-gray-700 dark:text-gray-200 transition-colors"
                title="View on HuggingFace"
              >
                <ExternalLink size={11} /> View
              </button>
            ) : null
          ) : installed ? (
            <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 text-[0.62rem] font-medium">
              <Check size={11} className="text-emerald-500/80" /> Installed
            </span>
          ) : downloading ? (
            <span className="flex items-center gap-1.5 px-2 py-1 text-[0.62rem] text-gray-500 dark:text-gray-400">
              <Loader2 size={11} className="animate-spin" /> Downloading…
            </span>
          ) : (
            <button
              onClick={() => onDownload(sel)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/[0.16] border border-gray-200 dark:border-white/[0.08] text-gray-800 dark:text-gray-100 text-[0.62rem] font-semibold shadow-sm transition-colors"
              title={sel.sizeGB ? `Download ${sel.sizeGB} GB` : 'Download'}
            >
              <Download size={11} /> Get
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
            {bundle.hot && !complete && <span title="Hot right now" className="text-gray-400 dark:text-gray-500 shrink-0"><Flame size={11} /></span>}
          </div>
          {bundle.description && (
            <p className="text-[0.62rem] text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{bundle.description}</p>
          )}
        </div>
        {bundle.url && (
          <button
            onClick={() => onOpenUrl(bundle.url!)}
            className="shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            title="View on HuggingFace"
            aria-label={`View ${bundle.name} on HuggingFace`}
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2.5">
        <SizePill sizeGB={bundle.totalSizeGB} />
        <span className="text-[0.55rem] text-gray-400 dark:text-gray-500">{bundle.files.length} files</span>
        <FitHint fit={fit} />

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {complete ? (
            <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 text-[0.62rem] font-medium">
              <Check size={11} className="text-emerald-500/80" /> Installed
            </span>
          ) : downloading ? (
            <span className="flex items-center gap-1.5 px-2 py-1 text-[0.62rem] text-gray-500 dark:text-gray-400">
              <Loader2 size={11} className="animate-spin" /> Installing…
            </span>
          ) : hasErrors ? (
            <>
              <button
                onClick={onRetry}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-red-100 dark:bg-red-500/15 hover:bg-red-200 dark:hover:bg-red-500/25 text-red-700 dark:text-red-400 text-[0.62rem] font-medium transition-colors"
                title="Retry failed downloads"
              >
                <RefreshCw size={11} /> Retry
              </button>
              <button
                onClick={onClear}
                className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 text-[0.62rem] transition-colors"
                title="Clear this failed download so you can start over or pick another model"
              >
                <X size={11} /> Clear
              </button>
            </>
          ) : (
            <button
              onClick={onInstall}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/[0.16] border border-gray-200 dark:border-white/[0.08] text-gray-800 dark:text-gray-100 text-[0.62rem] font-semibold shadow-sm transition-colors"
              title={`Install all ${bundle.files.length} files (${bundle.totalSizeGB} GB)`}
            >
              <Download size={11} /> Get · {bundle.totalSizeGB} GB
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
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] text-[0.6rem] text-gray-600 dark:text-gray-300"
      title="Detected hardware. Used for the 'runs on your PC' hints. Models are never hidden because of it."
    >
      <HardDrive size={11} className="text-gray-400" />
      {/* A side we could not measure says so. Zhorts (GH #123) read "62 GB GPU"
          off this chip on a 16 GB card, because the number behind it was his
          system RAM; the source of that is fixed in api/comfyui.ts, and this is
          the other half. Leaving the half out entirely reads as "no GPU", and
          an unmeasured GPU is not the same thing as an absent one. */}
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
