import { useRef } from 'react'
import { ArrowRight, Film, ImagePlus, Sparkles } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { loadImageRef } from './loadImage'
import { mediaRefFrom } from './mediaRef'
import { cn } from '../ui/cn'

// The Stage of Swap Character while no swap lies on it (port of the web's
// SwapStage, C52). One look says what happens here: the original, the new
// people, the result. What is already added stands in its place, the rest as
// an empty frame. The empty frames are upload fields themselves, the bigger
// target. Several people show as small numbered tiles; photo and role are set
// in the panel below.

const CARD = 'relative flex aspect-[9/16] h-[clamp(44px,calc(100cqh-64px),240px)] max-w-[28vw] shrink-0 flex-col items-center justify-center overflow-hidden rounded-xl border'
const EMPTY = 'border-dashed border-white/15 bg-white/[0.02] text-gray-500'
const FILLED = 'border-white/10 bg-white/5'

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="t-control text-gray-400">{children}</span>
}

function Pick({ accept, label, onFile, children, className }: {
  accept: string; label: string; onFile: (file: File) => void; children: React.ReactNode; className: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <button type="button" aria-label={label} onClick={() => ref.current?.click()} className={cn(className, 'cursor-pointer hover:border-lu-accent/60')}>
      {children}
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }}
      />
    </button>
  )
}

export function SwapStage() {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  const figures = useCreateStore((s) => s.swapFigures)
  const setFigures = useCreateStore((s) => s.setSwapFigures)
  const first = figures[0]?.image ?? null
  const many = figures.length > 1

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-4 py-2 [container-type:size]" data-swap-stage>
      <div className="flex items-center gap-2 sm:gap-3">
        <figure className="flex flex-col items-center gap-1.5">
          <Pick
            accept="video/mp4,video/webm,video/quicktime"
            label={videoInput ? 'Change original video' : 'Add original video'}
            onFile={(f) => setVideoInput(mediaRefFrom(f))}
            className={cn(CARD, videoInput ? FILLED : EMPTY)}
          >
            {videoInput
              ? <video src={videoInput.url} muted loop autoPlay playsInline className="h-full w-full object-cover" />
              : <><Film size={20} /><span className="t-control mt-1.5 px-2 text-center">Your video</span></>}
          </Pick>
          <Caption>Original</Caption>
        </figure>

        <span className="text-gray-500" aria-hidden>+</span>

        <figure className="flex flex-col items-center gap-1.5">
          {many ? (
            <div className={cn(CARD, FILLED, 'grid grid-cols-2 gap-1 p-1')} data-swap-figure-grid>
              {figures.map((f, i) => (
                <div key={i} className="relative h-full w-full overflow-hidden rounded-md bg-white/5">
                  {f.image
                    ? <img src={f.image.url} alt={`New person ${i + 1}`} className="h-full w-full object-cover" />
                    : <ImagePlus size={12} className="m-auto mt-[40%] text-gray-500" />}
                  <span className="absolute left-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-lu-accent t-micro font-semibold text-gray-950">{i + 1}</span>
                </div>
              ))}
            </div>
          ) : (
            <Pick
              accept="image/*"
              label={first ? 'Change photo of the new person' : 'Add photo of the new person'}
              onFile={(f) => { void loadImageRef(f).then((image) => setFigures(figures.map((g, i) => (i === 0 ? { ...g, image } : g)))) }}
              className={cn(CARD, first ? FILLED : EMPTY)}
            >
              {first
                ? <img src={first.url} alt="New person" className="h-full w-full object-cover" />
                : <><ImagePlus size={20} /><span className="t-control mt-1.5 px-2 text-center">New person</span></>}
            </Pick>
          )}
          <Caption>{many ? `${figures.length} new people` : 'New person'}</Caption>
        </figure>

        <ArrowRight size={16} className="text-gray-500" aria-hidden />

        <figure className="flex flex-col items-center gap-1.5">
          <div className={cn(CARD, 'border-lu-accent/40 bg-lu-accent/[0.06] text-lu-accent')}>
            <Sparkles size={20} />
          </div>
          <Caption>Result</Caption>
        </figure>
      </div>
      <p className="t-body max-w-[420px] truncate text-center text-gray-500">Same scene and motion, a different person.</p>
    </div>
  )
}
