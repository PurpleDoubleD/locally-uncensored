// The tile of one Mac media model (image or video, run by the MLX engines).
// It lives beside ModelTiles and not in it: these are catalogue names like
// "SD Turbo", not chat models with a provider slot in front, so the name is
// printed as it stands.
import { Download, ExternalLink, Check, Loader2, X, Trash2 } from 'lucide-react'
import { formatBytes } from '../../lib/formatters'
import { ICON_SM } from '../ui/icon-size'
import {
  FIT_META, TileSize, tileTitle, TILE_ACTION, TILE_ACTION_QUIET, TILE_BAR, TILE_BAR_FILL, TILE_BUSY,
  TILE_CONTROL, TILE_META, TILE_STATE, TILE_TEXT, type Fit,
} from './ModelTiles'
import { splitTileNotes } from './macTileNotes'
import { fitsMacMemory, memoryNeedGb } from '../../lib/mac-memory-fit'
import { macGetBytes } from '../../lib/mac-setup-sizes'
import { CloudOfferLine } from '../cloud/CloudOffer'
import { DescriptionDetails } from './DescriptionDetails'
import type { CloudOfferTask } from '../../lib/cloud-offer'

// ─── Mac media tile ─────────────────────────────────────────────────

/** How a Mac media model sits against the memory this Mac has. There is no
 *  graphics card to overflow: processor and graphics unit share one pool, and
 *  the catalogue names the smallest pool a model runs in. So the ladder has
 *  two rungs here, and no "tight". */
export function memoryFit(minRamGB: number, memoryGb: number | null): Fit {
  const fits = fitsMacMemory(minRamGB, memoryGb)
  return fits === null ? 'unknown' : fits ? 'fits' : 'big'
}

export function memoryFitLine(minRamGB: number, memoryGb: number | null): string {
  const fit = memoryFit(minRamGB, memoryGb)
  if (fit === 'fits') return 'Runs on this Mac'
  if (fit === 'big') return `Needs a Mac with ${minRamGB} GB memory`
  return ''
}

export type MacMediaTileState =
  | { kind: 'idle' }
  | { kind: 'installed' }
  /** Its own download is running. `percent` is null while only the log talks. */
  | { kind: 'installing'; percent: number | null; detail: string }
  /** Clicked, and the engine under it is being set up first. */
  | { kind: 'queued' }
  /** Another model of this lane holds the one install slot. */
  | { kind: 'blocked'; by: string }

export interface MacMediaTileProps {
  model: { id: string; name: string; repo: string; sizeBytes: number; minRamGB: number; recommendedRamGB?: number; textEncoderGB?: number; unfiltered: boolean; description: string }
  /** The memory this Mac has, in GB. Null until it is measured. */
  memoryGb: number | null
  state: MacMediaTileState
  onGet: () => void
  onCancel: () => void
  onRemove: () => void
  onOpenUrl: (url: string) => void
  /** The Create tab this model serves, for the LU Cloud line on a model
   *  this Mac has no room for (lib/cloud-offer.ts). Absent: no line. */
  cloudTask?: CloudOfferTask
}

export function MacMediaTile({ model, memoryGb, state, onGet, onCancel, onRemove, onOpenUrl, cloudTask }: MacMediaTileProps) {
  // The memory the catalogue recommends. For the small Wan entries that is
  // more than the least a run is let through with: such a tile says so and
  // keeps its Get, as every tile above this Mac's memory does.
  const needGb = memoryNeedGb(model)
  const fit = memoryFit(needGb, memoryGb)
  // A model this Mac has no room for keeps its Get: the download is never
  // held back. It loses the tint that recommends it and says "anyway".
  const fitsHere = fit !== 'big'
  const size = formatBytes(model.sizeBytes)
  // What the footer says. Installed, that is the model as it lies here. Not
  // installed, it is what a Get fetches: a video model whose text encoder is
  // not on this Mac yet brings it along, and the tile of LTX-2.3 Distilled
  // 4-bit said 19.1 GB for a download of 26.6.
  const withEncoder = state.kind !== 'installed' && (model.textEncoderGB ?? 0) > 0
  const shownBytes = macGetBytes({ ...model, installed: state.kind === 'installed' })
  const getSize = formatBytes(shownBytes)
  // The sentences a description ends on (experimental, licence, token) are
  // marks of their own: two lines of text cut exactly them off.
  const { text, notes } = splitTileNotes(model.description)
  const memoryTitle = memoryGb
    ? `Needs ${needGb} GB of memory. This Mac has ${Math.round(memoryGb)} GB.`
    : `Needs ${needGb} GB of memory.`
  return (
    <div
      // Full height of its grid row, with the footer at the bottom: a one-line
      // description beside a two-line one left a ragged row otherwise.
      className="lu-tile relative flex h-full flex-col p-3.5"
      data-mac-media-tile={model.id}
      data-state={state.kind}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h3 className={tileTitle(fitsHere)}>{model.name}</h3>
          <p className={TILE_TEXT} title={model.description}>{text}</p>
          {/* Unmeasured memory gets no verdict: the number stands in the
              footer either way. */}
          {fit !== 'unknown' && (
            <p
              className="flex items-center gap-1.5 mt-2 t-micro text-gray-500 dark:text-gray-400"
              data-memory-fit={fit}
              title={memoryTitle}
            >
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${FIT_META[fit].dot}`} />
              <span>{memoryFitLine(needGb, memoryGb)}</span>
            </p>
          )}
          {/* No room for it on this Mac, and not here or on its way: the
              one place this tile names LU Cloud. */}
          {fit === 'big' && cloudTask && (state.kind === 'idle' || state.kind === 'blocked') && (
            <CloudOfferLine task={cloudTask} sharedMemory />
          )}
          {notes.length > 0 && (
            <p className="flex flex-wrap items-center gap-1 mt-2" data-tile-notes>
              {notes.map((note) => (
                <span key={note.id} className="t-micro lu-picker-tag" title={note.sentence} data-tile-note={note.id}>
                  {note.label}
                </span>
              ))}
            </p>
          )}
        </div>
        {model.description && (
          <DescriptionDetails name={model.name} description={model.description} className="lu-control lu-control--icon -mt-1" />
        )}
        <button
          onClick={() => onOpenUrl(`https://huggingface.co/${model.repo}`)}
          className="lu-control lu-control--icon -mr-1.5 -mt-1"
          title="View on HuggingFace"
          aria-label={`View ${model.name} on HuggingFace`}
        >
          <ExternalLink size={ICON_SM} />
        </button>
      </div>

      <div className="flex items-center gap-2 mt-auto pt-3 min-h-[var(--control-h-sm)]">
        {/* Left: what the model is while nothing happens, how far it is while
            it downloads. Same place, so the footer does not jump. */}
        {state.kind === 'installing' ? (
          <div className="flex-1 min-w-0" role="status" title={state.detail || undefined}>
            <p className={`flex items-center gap-1.5 ${TILE_META}`}>
              {state.percent === null && <Loader2 size={ICON_SM} className="shrink-0 animate-spin" />}
              <span className="truncate">
                {state.percent === null ? 'Installing…' : `${state.percent}%`}
                {state.detail && ` · ${state.detail}`}
              </span>
            </p>
            {state.percent !== null && (
              <div className={`mt-1.5 ${TILE_BAR}`} aria-hidden="true">
                <div className={TILE_BAR_FILL} style={{ width: `${state.percent}%` }} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 min-w-0 items-center overflow-hidden" title={memoryTitle}>
            <TileSize bytes={shownBytes} /><span className={`${TILE_META} truncate before:mx-1.5 before:content-['·']`}>needs {needGb} GB memory</span>
          </div>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          {state.kind === 'installed' ? (
            <>
              <span className={TILE_STATE}>
                <Check size={ICON_SM} /> Installed
              </span>
              <button
                onClick={onRemove}
                className={`${TILE_CONTROL} lu-control--icon`}
                title={`Remove ${model.name} and free ${size}`}
                aria-label={`Remove ${model.name}`}
              >
                <Trash2 size={ICON_SM} />
              </button>
            </>
          ) : state.kind === 'installing' ? (
            <button
              onClick={onCancel}
              className={TILE_CONTROL}
              title="Stop this download. What is already here is kept, so Get picks up where it stopped."
              aria-label={`Stop installing ${model.name}`}
            >
              <X size={ICON_SM} /> Stop
            </button>
          ) : state.kind === 'queued' ? (
            <span className={TILE_BUSY} role="status">
              <Loader2 size={ICON_SM} className="animate-spin" /> Engine first…
            </span>
          ) : (
            <button
              onClick={onGet}
              disabled={state.kind === 'blocked'}
              className={fitsHere ? TILE_ACTION : TILE_ACTION_QUIET}
              title={state.kind === 'blocked' ? `${state.by} is installing. One download at a time.` : `Install ${model.name} (${getSize}${withEncoder ? ', its text encoder included' : ''})`}
            >
              <Download size={ICON_SM} /> {fitsHere ? 'Get' : 'Get anyway'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
