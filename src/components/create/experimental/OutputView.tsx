import { itemHasAlpha } from '../../../lib/transparent-image'
import { useRenderPreviewStore } from '../../../stores/renderPreviewStore'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Cpu, Sparkles, ImageDown, Maximize2, Download, Wand2, MonitorOff, AudioLines, Film, Trash2, UserRoundPlus } from 'lucide-react'
import { coldLoadHint } from '../../../lib/cold-load-notice'
import { slowLoadHint } from '../../../lib/vram-fit'
import { useLocalModelFits } from '../../../hooks/useLocalModelFit'
import { useLocalPick } from './localPick'
import { useCreateStore, type GalleryItem, type ProgressPhase } from '../../../stores/createStore'
import { isMlxImageHost } from '../../../api/mlx-image'
import { ICON_LG, ICON_STROKE_MARK } from '../../ui/icon-size'
import { PromptDetails } from './PromptDetails'
import { hasPromptPanel } from '../../../lib/render/ran-prompt'
import { markGalleryItemAvailable, playsAsVideo } from './galleryUrl'
import { deleteTitle, unavailableLine, playerHasControls, UNAVAILABLE_VIDEO_BOX } from './galleryWording'
import { downloadGalleryItem } from './galleryDownload'
import { galleryLabel } from '../../../lib/render/gallery-label'
import { resultFacts } from '../../../lib/render/result-facts'
import { useComfyMedia } from './useComfyMedia'
import { BatchQueue } from './BatchStrip'
import { FitStage } from './FitStage'
import { cn } from '../ui/cn'

// The icon in the waiting circle says which PHASE the render is in, never
// which device it runs on. The chip is the loading phase, the spark is
// sampling/idle, the arrow is decoding. R14 Nebenbefund 2 read the chip as a
// CPU marker that had gone missing, because the R13 screenshot caught a load
// and the R14 pair caught two samplings. The device is said in words, by the
// line at the top of the Create tab.
//
// 19.09.2026, Entscheid des Inhabers: das Warten traegt dasselbe Lila wie der
// Rest der App, damit sichtbar ist, dass da etwas passiert. Sky fuer Laden,
// Gruen fuer Sampling waren Schmuck fuer eine Phase, keine Warnung, und genau
// solche Stellen haben Farbe in der App bedeutungslos gemacht. Die Phase sagt
// jetzt allein das Symbol, nicht mehr die Farbe.
function phaseIcon(phase: ProgressPhase) {
  if (phase === 'loading-model' || phase === 'loading-clip' || phase === 'loading-vae') return <Cpu size={20} className="text-lu-accent" />
  if (phase === 'decoding') return <ImageDown size={20} className="text-lu-accent" />
  return <Sparkles size={20} className="text-lu-accent" />
}

// Wie schnell die Wellen laufen, sagt die Phase weiterhin. Laden ist der
// laengste, unbestimmte Schritt (der langsamste Takt), Sampling der
// sichtbarste Fortschritt (der schnellste).
function phaseBeat(phase: ProgressPhase): number {
  if (phase === 'loading-model' || phase === 'loading-clip' || phase === 'loading-vae') return 3
  if (phase === 'sampling') return 1.2
  return 2
}

/**
 * The line that explains a long load phase (R14 Nebenbefund 3: the first
 * render after a ComfyUI start sat 57 s in `Loading model...` with nothing on
 * screen saying why).
 *
 * Its own component on purpose. It is mounted only while the load phase runs,
 * so its clock starts with the phase and is thrown away with it, and there is
 * no reset to get wrong. The three loader phases are one stretch to the parent,
 * so a checkpoint handing over to the text encoder does not restart the count.
 * coldLoadHint stays silent until the wait is long enough to be worth a word.
 *
 * The line names ComfyUI, so the Mac never draws it: local media there is MLX
 * in the app's own process, and its short load phase has no ComfyUI behind it.
 */
function ColdLoadLine() {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setElapsedMs((ms) => ms + 1000), 1000)
    return () => clearInterval(id)
  }, [])
  // After a minute a model that does not sit comfortably on the card gets the
  // reason for the wait (the owner's 12 GB box, October 2026: Z-Image stood
  // here for more than 300 s and the line said nothing about why). Same clock,
  // same place, and silent for a model that fits or a card nobody detected.
  const { list, value } = useLocalPick()
  const picked = useMemo(() => list.filter((m) => m.name === value), [list, value])
  const { fitOf } = useLocalModelFits(picked)
  const hint = coldLoadHint(true, elapsedMs)
  if (!hint) return null
  const slow = slowLoadHint(fitOf(value), elapsedMs)
  return (
    <div className="space-y-1 text-center max-w-[22rem]">
      <p className="t-body text-gray-500">{hint}</p>
      {slow && <p className="t-body text-gray-500" data-testid="slow-load-hint">{slow}</p>}
    </div>
  )
}

// Generation progress — phase-aware animation.
export function GeneratingView() {
  const progressPhase = useCreateStore((s) => s.progressPhase)
  const progressText = useCreateStore((s) => s.progressText)
  const progress = useCreateStore((s) => s.progress)
  // B28: the sampler's newest picture while a video renders.
  const preview = useRenderPreviewStore((s) => s.url)
  const isLoading = progressPhase === 'loading-model' || progressPhase === 'loading-clip' || progressPhase === 'loading-vae'
  const beat = phaseBeat(progressPhase)

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="space-y-6 flex flex-col items-center">
        <div className="relative w-16 h-16">
          {/* Der Schein dahinter. Er atmet langsamer als die Wellen, sonst
              flackert die ganze Flaeche im Takt mit. */}
          <motion.div
            aria-hidden
            className="absolute -inset-8 rounded-full bg-lu-accent/25 blur-2xl"
            animate={{ opacity: [0.3, 0.7, 0.3] }}
            transition={{ duration: beat * 2, repeat: Infinity, ease: 'easeInOut' }}
          />
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              aria-hidden
              className="absolute inset-0 rounded-full border border-lu-accent/45"
              style={{ boxShadow: '0 0 16px rgba(160, 148, 248, 0.45)' }}
              animate={{ scale: [1, 1.95], opacity: [0.6, 0] }}
              transition={{ duration: beat, repeat: Infinity, ease: 'easeOut', delay: (beat / 3) * i }}
            />
          ))}
          <div className="absolute inset-0 rounded-full border border-lu-accent/30 bg-lu-accent/[0.07] flex items-center justify-center" style={{ boxShadow: '0 0 24px rgba(160, 148, 248, 0.3) inset' }}>
            {isLoading ? (
              <motion.div animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}>{phaseIcon(progressPhase)}</motion.div>
            ) : phaseIcon(progressPhase)}
          </div>
        </div>
        <BatchQueue />
        {preview && (
          <figure className="flex flex-col items-center gap-1" data-testid="render-live-preview">
            <img src={preview} alt="Live preview of the video being rendered" className="max-h-56 max-w-[22rem] rounded-lg border border-white/10 object-contain" />
            <figcaption className="t-micro text-gray-500 text-center max-w-[22rem]">
              Rough preview of the first frame, sharper with every step. Cancel if it is going the wrong way.
            </figcaption>
          </figure>
        )}
        <p className="t-body text-gray-300 tracking-wide">{progressText || 'Generating…'}</p>
        {isLoading && !isMlxImageHost() && <ColdLoadLine />}
        {progress > 0 && (
          <div className="w-56 h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div className="h-full rounded-full bg-lu-accent" initial={{ width: 0 }} animate={{ width: `${Math.min(progress, 100)}%` }} transition={{ duration: 0.3 }} />
          </div>
        )}
      </div>
    </div>
  )
}

interface ResultProps {
  item: GalleryItem
  onFullscreen: () => void
  /** The Prompt word in the facts: the large view with the prompt unfolded. */
  onShowPrompt?: () => void
  onSendToEditor?: () => void
  /** C1: adopt this finished image as the Animate intent's source, matching
   *  web's OutputView (the web app,
   *  createStore.animateFrom). Absent where the Animate lane cannot actually
   *  run (see isIntentAvailable('animate', ...) in Stage's caller), same gating
   *  pattern as onSendToEditor above it. */
  onAnimate?: () => void
  /** Pick frames of this finished video and save them as a character. */
  onSaveCharacter?: () => void
  /** On a tool that works from a source image: the source, its references
   *  and the way to the next image (Stage's ResultInputs). They stand beside
   *  the result in a wide stage and under it in a narrow one, with the result
   *  given the height that is left (FitStage). */
  side?: ReactNode
}


// The stored width/height are the generation *request* dims (the sliders).
// Utility ops (upscale/removebg/eraser) and edit ignore those — their real
// output is whatever the engine produced (an upscale of a 848×480 source lands
// at 5444×3082, not the slider size). Once the media has decoded we know the
// true pixel dims, so correct the stored values in place. No-ops when they
// already match (which also breaks any re-render loop) or the item was since
// removed. Self-heals older gallery items the first time they're viewed.
function reconcileDims(item: GalleryItem, w: number, h: number) {
  if (w > 0 && h > 0 && (w !== item.width || h !== item.height)) {
    useCreateStore.getState().updateGalleryItem(item.id, { width: w, height: h })
  }
}

export function ResultView({ item, onFullscreen, onShowPrompt, onSendToEditor, onAnimate, onSaveCharacter, side }: ResultProps) {
  const { src: url, onError } = useComfyMedia(item)
  const download = () => void downloadGalleryItem(item)
  const isVideo = item.type === 'video'
  // An old animated .webp clip shows as a picture, which still moves (A19).
  const inPlayer = playsAsVideo(item)
  const isAudio = item.type === 'audio'
  // `maxHeight` is the height the stage has left for the result (FitStage).
  // Until the stage is measured it keeps the share of the window it always had.
  const media = (maxHeight?: string) => (
      <div className="relative group max-w-full max-h-full">
        {isAudio ? (
          <div className="w-[420px] max-w-full flex flex-col items-center gap-3 p-6 rounded-[var(--radius-panel)] border border-white/[0.06] bg-white/[0.02]">
            <AudioLines size={26} className="text-gray-400" strokeWidth={ICON_STROKE_MARK} />
            <p className="t-body text-gray-400 text-center line-clamp-2">{galleryLabel(item)}</p>
            <audio src={url} controls onError={onError} className="w-full" onLoadedData={() => markGalleryItemAvailable(item)} />
          </div>
        ) : inPlayer ? (
          <video
            src={url}
            controls={playerHasControls(!!item.unavailable)}
            loop
            autoPlay
            muted
            onError={onError}
            onLoadedData={(e) => { markGalleryItemAvailable(item); reconcileDims(item, e.currentTarget.videoWidth, e.currentTarget.videoHeight) }}
            className={cn(!maxHeight && 'max-h-[62vh]', 'max-w-full object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', !playerHasControls(!!item.unavailable) && UNAVAILABLE_VIDEO_BOX)}
            style={maxHeight ? { maxHeight } : undefined}
          />
        ) : (
          <img
            src={url}
            alt={item.prompt}
            onError={onError}
            onLoad={(e) => { markGalleryItemAvailable(item); reconcileDims(item, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) }}
            // A click on the picture opens the large view, where its prompt
            // stands unfolded.
            onClick={onFullscreen}
            className={cn(!maxHeight && 'max-h-[62vh]', 'max-w-full cursor-zoom-in object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', itemHasAlpha(item) && 'lu-checker')}
            style={maxHeight ? { maxHeight } : undefined}
          />
        )}
        {item.unavailable && (
          <div className="lu-on-dark absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[var(--radius-panel)] bg-black/60 text-gray-400 p-6 text-center">
            <MonitorOff size={ICON_LG} />
            <span className="t-body">
              {unavailableLine(item.unavailableReason === 'gone', isMlxImageHost())}
            </span>
          </div>
        )}
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onSendToEditor && item.type === 'image' && !item.unavailable && (
            <IconBtn title="Edit with mask" onClick={onSendToEditor}><Wand2 size={14} /></IconBtn>
          )}
          {onAnimate && item.type === 'image' && !item.unavailable && (
            <IconBtn title="Animate this image" onClick={onAnimate}><Film size={14} /></IconBtn>
          )}
          {onSaveCharacter && isVideo && !item.unavailable && (
            <IconBtn title="Use frames of this video for a character" onClick={onSaveCharacter}><UserRoundPlus size={14} /></IconBtn>
          )}
          <IconBtn
            title={item.unavailable ? 'Download needs the local engine' : 'Download'}
            disabled={item.unavailable}
            onClick={download}
          >
            <Download size={14} />
          </IconBtn>
          {!isAudio && (
            <IconBtn title="Fullscreen" onClick={onFullscreen}><Maximize2 size={14} /></IconBtn>
          )}
          {/* Discord 2026-09-28 (#feature-requests "DELETE BUTTON"):
              delete from the big view too, not only from the tile's corner.
              The file goes to the Recycle Bin, on a Mac to the Trash
              (lib/gallery-trash.ts). */}
          <IconBtn title={deleteTitle(isMlxImageHost())} onClick={() => useCreateStore.getState().removeFromGallery(item.id)}>
            <Trash2 size={14} />
          </IconBtn>
        </div>
      </div>
  )
  const facts = (
    <>
      <div className="flex items-center gap-3 mt-3 t-mono text-gray-600" data-testid="result-facts">
        {resultFacts(item).map((fact, i, all) => (
          <Fragment key={fact}>
            <span className={i === all.length - 1 ? 'truncate max-w-[280px]' : undefined}>{fact}</span>
            {i < all.length - 1 && <span>·</span>}
          </Fragment>
        ))}
        {/* The fitted stage (a tool that works from a source) has no height to give:
            in a narrow window the picture is already at its smallest, and a
            panel under it pushed the stage into a scroll. There the prompt
            costs no line of its own. This opens the large view, where it
            stands unfolded with its copy button. */}
        {side && hasPromptPanel(item) && !isAudio && (
          <>
            <span>·</span>
            <button
              type="button"
              onClick={onShowPrompt ?? onFullscreen}
              title="Show the prompt and settings of this result"
              className="shrink-0 underline underline-offset-2 hover:text-gray-300"
              data-testid="result-prompt-open"
            >
              Prompt
            </button>
          </>
        )}
      </div>
      {item.sourceName && (
        <div className="mt-1 t-mono text-gray-500 truncate max-w-[420px]" data-testid="source-name">from {item.sourceName}</div>
      )}
      {item.runNote && (
        <div className="mt-1 t-mono text-gray-500" data-testid="run-note">{item.runNote}</div>
      )}
      {!side && <PromptDetails item={item} className="mt-2" />}
    </>
  )
  // With no source beside it the result is fitted all the same: the stage is
  // lower than 62 % of the window (451 px in a 1440 × 900 window), so a wide
  // result and the prompt fold under it ran below its edge.
  return <FitStage picture={media} under={facts} side={side} capVh={62} />
}

function IconBtn({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'lu-on-dark w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 backdrop-blur transition-colors',
        disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-200 hover:text-white hover:bg-black/70',
      )}
    >
      {children}
    </button>
  )
}

