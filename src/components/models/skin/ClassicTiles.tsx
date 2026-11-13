// The classic face of the Model Manager tiles: Windows and Linux.
//
// The build is the one the tiles had before the redesign (commit 9339daa7):
// one row with the size, the verdict and the button. The colours are the
// Mac's since 10.10.2026 (see skin/classic.tsx). This file holds no rules of
// its own: which variant is chosen, whether a model fits and what the button
// does come from the hooks in ../ModelTiles.tsx, which the Mac face stands on
// as well. Which face is drawn is decided in one place, skin/which.ts.
//
// Pictures of this face: proof/design-pill/win/model-manager/.
import {
  Download, ExternalLink, Info, Check, ChevronDown, Loader2, RefreshCw, X,
} from 'lucide-react'
import { isBelowChatMinimum, SMALL_CHAT_MODEL_WARNING } from '../../../lib/chat-model-minimum'
import { formatBytes, countLabel } from '../../../lib/formatters'
import { vramNeedTitle } from '../../../lib/vram-fit'
import { tierMarks } from '../../../lib/render/model-tier'
import { ICON_SM } from '../../ui/icon-size'
import {
  FIT_META, FitHint, CapIcons, HotMark, computeFit, shortBlurb, variantLabel,
  useModelTile, bundleTileFacts, bundleOffersCloud, bundleOffersCheck, CheckFilesButton,
  type ModelTileProps, type BundleTileProps,
} from '../ModelTiles'
import { CloudOfferLine } from '../../cloud/CloudOffer'
import { DescriptionDetails } from '../DescriptionDetails'

// ─── Drei Rollen, drei Erscheinungen ────────────────────────────────
//
// D-S23: „Quant-Dropdown und statischer Groessen-Chip haben identische
// Klassen an identischer Position, Unterschied ist nur ein 10px-Chevron."
// Beide trugen `px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.06]`
// und dieselbe Schriftgroesse, ein Bedienelement, das aussah wie eine
// Anzeige. Das Chevron war die ganze Unterscheidung, und ein Chevron ist
// eine Fussnote, keine Formsprache.
//
// Die Kachelzeile kennt jetzt drei Rollen, und jede sieht anders aus:
//
//   ANZEIGE   `SizePill`, „Installed", die Fortschrittszeile.
//             Kein Rand, kein Hover, kein Fokus, kein Zustand.
//   CONTROL   der Varianten-Aufklapper, „View" und „Clear" →
//             `.lu-control lu-control--outline`, das neutrale Hausrezept
//             aus index.css mit sichtbarer Kante. Es liest seinen offenen
//             Zustand aus `aria-expanded`, die Anzeige des Zustands kann
//             damit gar nicht mehr neben der Barrierefreiheit herlaufen.
//   AKTION    genau ein Knopf pro Kachel: „Get" oder „Use" → `.lu-tonal`.
//
// Warum die Aktion NICHT `.lu-primary` traegt, obwohl sie die Hauptaktion
// der Kachel ist: es sind 53 Kacheln gleichzeitig sichtbar, und 53 gefuellte
// Akzentflaechen waeren eine Wand. `.lu-tonal` ist der Akzent als Toenung:
// er fuehrt zum Knopf und bleibt im Raster ruhig (index.css).
//
// Geometrie: alle drei Rollen stehen auf `--control-h-sm` (26px) und
// `--radius-control` (8px), also in derselben Zeilenhoehe. `.lu-tonal`
// bringt genau die Masse mit, die der Knopf hier schon hatte (26px hoch,
// 10px Polster, 4px Luecke, die Mikro-Schrift halbfett).

/** AKTION, der eine getoente Knopf einer Kachel. */
export const TILE_ACTION = 'lu-tonal'

/** CONTROL, neutral und mit Kante. */
export const TILE_CONTROL = 'lu-control lu-control--outline'

/** ANZEIGE, ein Zustand, den man lesen und nicht druecken kann. Gruen sagt
 *  „ist da", ohne Flaeche: eine Flaeche waere wieder ein Knopf. */
export const TILE_STATE =
  'flex items-center gap-1 h-[var(--control-h-sm)] px-2 '
  + 'text-emerald-700 dark:text-emerald-400 t-micro font-medium'

/** The busy line and the small print of a tile. */
const TILE_BUSY = 'flex items-center gap-1.5 h-[var(--control-h-sm)] px-2 t-micro text-gray-500 dark:text-gray-400'
const TILE_META = 'text-[0.55rem] text-gray-500 dark:text-gray-400'

// ─── Small chips ────────────────────────────────────────────────────

/** ANZEIGE. Bleibt bewusst flach und ohne Hover: sie ist die Groesse, nicht
 *  die Wahl der Groesse. Wo es etwas zu waehlen gibt, steht an derselben
 *  Stelle das Control (siehe `ModelTile`). */
export function SizePill({ sizeGB, bytes }: { sizeGB?: number; bytes?: number }) {
  if (!sizeGB && !bytes) return null
  return (
    <span className="t-micro px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 font-medium tabular-nums">
      {bytes ? formatBytes(bytes) : `${sizeGB} GB`}
    </span>
  )
}

// ─── Model tile ─────────────────────────────────────────────────────

export function ClassicModelTile(props: ModelTileProps) {
  const { variants, vramGb, sharedMemory = false, isInstalled, dlState, onDownload, onInfo, onOpenUrl, onUse, highlight } = props
  const { pickerOpen, setPickerOpen, setChosen, pickerRef, variantListRef, variantList, sel, groupTitle, dl, downloading, fit, action, sizeOf, selSize, downloadTitle, target } = useModelTile(props)

  return (
    <div
      className={highlight ? 'lu-tile lu-tile--lead relative p-3' : 'lu-tile relative p-3'}
      data-model-tile={groupTitle}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-[0.78rem] font-semibold text-gray-900 dark:text-white truncate">{groupTitle}</h3>
            <CapIcons model={sel} sharedMemory={sharedMemory} />
          </div>
          <p className="t-micro text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{shortBlurb(sel, sharedMemory)}</p>
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

      {isBelowChatMinimum(sel) && (
        <p data-testid="small-chat-model-warning" className="mt-2 text-xs leading-relaxed text-gray-700 dark:text-gray-200">
          {SMALL_CHAT_MODEL_WARNING}
        </p>
      )}

      {/* The row wraps. Picker, verdict, download count and button need more
          than a tile has in a three-column grid at 1296 px, and nothing in
          the row gives way: the button stood out over the tile's edge and
          the list got a sideways scroll bar (real Windows build,
          10.10.2026). When they do not fit, the count and the button take a
          second line and stay at the right edge. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-2.5 min-h-[var(--control-h-sm)]">
        {/* Variant / size selector, only when the family ships several quants */}
        {variants.length > 1 ? (
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen(o => !o)}
              className={`${TILE_CONTROL} tabular-nums`}
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
                      <span className="t-micro text-gray-500 dark:text-gray-400 tabular-nums">{sizeOf(v)} GB</span>
                      {vInst && <Check size={ICON_SM} className="text-emerald-700 dark:text-emerald-400" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <SizePill sizeGB={selSize} />
        )}

        <FitHint fit={fit} sharedMemory={sharedMemory} />
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {sel.hot && <HotMark />}
          {sel.pulls && <span className={`${TILE_META} mr-1`}>{sel.pulls}</span>}

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
              className={TILE_ACTION}
              title={downloadTitle}
            >
              <Download size={ICON_SM} /> Get{target && <span className="opacity-70">→ {target}</span>}
            </button>
          )}
        </div>
      </div>

      {/* Too big for this machine and not here yet: the one place LU Cloud
          is named on a chat tile (lib/cloud-offer.ts). */}
      {fit === 'big' && action === 'get' && <CloudOfferLine task="chat" sharedMemory={sharedMemory} />}

      {/* Slim inline progress, the header badge stays the full control center */}
      {downloading && dl && dl.total > 0 && (
        <div className="mt-2">
          <div className="h-1 rounded-full bg-gray-200 dark:bg-white/[0.08] overflow-hidden">
            <div className="h-full rounded-full bg-lu-accent transition-[width]" style={{ width: `${Math.min(100, (dl.progress / dl.total) * 100)}%` }} />
          </div>
          <div className={`flex justify-between mt-0.5 ${TILE_META} tabular-nums`}>
            <span>{formatBytes(dl.progress)} / {formatBytes(dl.total)}</span>
            <span>{Math.round((dl.progress / dl.total) * 100)}%</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Bundle tile (image / video) ────────────────────────────────────

export function ClassicBundleTile(props: BundleTileProps) {
  const { bundle, lane, complete, downloading, hasErrors, onInstall, onRetry, onClear, onOpenUrl } = props
  const { fit, addonLine, cardLine, plan, fetchSize, alreadyHere } = bundleTileFacts(props)

  return (
    <div
      className="lu-tile relative p-3 overflow-hidden"
      data-bundle-tile={bundle.name}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="text-[0.78rem] font-semibold text-gray-900 dark:text-white truncate">{bundle.name}</h3>
            {bundle.hot && !complete && <HotMark />}
            {lane && (
              <span data-bundle-lane={lane} className="shrink-0 rounded px-1.5 py-0.5 t-micro font-semibold bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-300">{lane}</span>
            )}
            {tierMarks(bundle).map((t) => (
              <span key={t.label} className={`shrink-0 rounded px-1.5 py-0.5 t-micro font-semibold ${t.tone === 'accent' ? 'bg-lu-accent-soft text-lu-accent-ink dark:text-lu-accent' : 'text-gray-500 dark:text-gray-600'}`}>{t.label}</span>
            ))}
          </div>
          {bundle.description && (
            <p className="t-micro text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{bundle.description}</p>
          )}
          {addonLine && (
            <p className="mt-1.5 t-micro text-gray-500 dark:text-gray-400" data-bundle-addon-for={bundle.addonFor}>{addonLine}</p>
          )}
          {cardLine && (
            <p
              className="flex items-center gap-1.5 mt-1.5 t-micro text-gray-500 dark:text-gray-400"
              data-bundle-fit={fit}
              title={vramNeedTitle(bundle)}
            >
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${FIT_META[fit].dot}`} />
              <span>{cardLine}</span>
            </p>
          )}
          {bundleOffersCloud(fit, props) && <CloudOfferLine task={props.cloudTask!} sharedMemory={props.sharedMemory} />}
        </div>
        {bundle.description && (
          <DescriptionDetails
            name={bundle.name}
            description={bundle.description}
            className="shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          />
        )}
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
        <SizePill bytes={plan.totalBytes} />
        <span className={TILE_META}>{countLabel(bundle.files.length, 'file')}</span>
        {!cardLine && !addonLine && <FitHint fit={fit} />}

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {bundleOffersCheck(props, plan.present) && (
            <CheckFilesButton onClick={props.onCheck!} label={complete} name={bundle.name} className={TILE_CONTROL} />
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
            // Ton-Pass an FIT_META, dort hiess Rot „langsam", hier heisst es
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
              className={TILE_ACTION}
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

/** The classic surface of the hardware chip and the classic type of the
 *  capability legend. The pieces themselves are shared (../ModelTiles.tsx),
 *  only these two chains differ between the faces. */
export const CLASSIC_HARDWARE_CHIP =
  'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-200 dark:border-white/[0.08] t-micro text-gray-600 dark:text-gray-300'
export const CLASSIC_CAP_LEGEND = 'text-[0.55rem] text-gray-500 dark:text-gray-400'
