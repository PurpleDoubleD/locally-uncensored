// The 3D tab's own row in the Composer (C3D-PLAN 1.2): the way (text, image,
// video), the cutout switch, the detail step, the further sides of a model
// that takes several views, and the still frames of a video.
//
// The video never leaves the device. LU reads still frames of it here, the
// first one becomes the picture on the Stage (the "Front"), the others the
// further sides. From there "From video" runs exactly like "From image".
import { useEffect, useRef, useState } from 'react'
import { Film, Plus, X } from 'lucide-react'
import { useCreateStore, type ImageRef, type ThreeDDetail, type ThreeDWay } from '../../../stores/createStore'
import { framesAcrossVideo } from '../../../lib/video-frames'
import { THREE_D_TEXT as T } from '../../../lib/three/three-d-text'
import { loadImageRef } from './loadImage'
import { Segmented } from '../ui/Segmented'
import { cn } from '../ui/cn'
import { cloudDetailOf, threeDDetailField } from '../../../lib/three/three-d-models'

const WAYS: ThreeDWay[] = ['text', 'image', 'video']
const DETAILS: ThreeDDetail[] = ['draft', 'standard', 'fine']
/** How many moments of a video are offered to pick from. */
const FRAME_CHOICES = 8

export interface ThreeDControlsProps {
  /** How many pictures the picked model takes: 1, or up to 4 sides. */
  maxViews: number
  /** Whether the picked model has a detail step at all. */
  hasDetail: boolean
  /** Whether the cutout switch applies (it does wherever LU cuts out itself). */
  hasCutout: boolean
  /** The cloud model that will run, when there is one. */
  studioId?: string
}

export function ThreeDControls({ maxViews, hasDetail, hasCutout, studioId }: ThreeDControlsProps) {
  const way = useCreateStore((s) => s.threeDWay)
  const setWay = useCreateStore((s) => s.setThreeDWay)
  const cutout = useCreateStore((s) => s.threeDCutout)
  const setCutout = useCreateStore((s) => s.setThreeDCutout)
  const detail = useCreateStore((s) => s.threeDDetail)
  const setDetail = useCreateStore((s) => s.setThreeDDetail)
  const backend = useCreateStore((s) => s.backend)
  const studioOptions = useCreateStore((s) => s.cloudStudioOptions)
  const setStudioOptions = useCreateStore((s) => s.setCloudStudioOptions)
  // In the cloud the step IS the model's own field (its resolution or its
  // texture quality), written where the price and the booking read it.
  const cloudField = backend === 'cloud' ? threeDDetailField(studioId) : null
  const shownDetail = cloudField ? cloudDetailOf(cloudField, studioOptions[cloudField.field], studioId) : detail
  const pickDetail = (d: ThreeDDetail) => {
    setDetail(d)
    if (cloudField) setStudioOptions({ ...studioOptions, [cloudField.field]: cloudField.values[d] })
  }
  return (
    <div className="flex flex-col gap-3" data-testid="three-d-controls">
      <Segmented
        ariaLabel="How to make the model"
        layoutId="three-d-way"
        value={way}
        onChange={setWay}
        options={WAYS.map((w) => ({ value: w, label: T.ways[w] }))}
      />
      {way === 'text' && backend === 'local' && <p className="t-meta text-gray-400" data-testid="three-d-picture-first">{T.pictureFirst}</p>}
      {way === 'image' && maxViews > 1 && <SideStrip maxViews={maxViews} />}
      {way === 'video' && <VideoFrames maxViews={maxViews} />}
      <div className="flex flex-wrap items-center gap-4">
        {hasCutout && way !== 'text' && (
          <label className="flex items-center gap-2 t-control text-gray-300 cursor-pointer">
            <input type="checkbox" checked={cutout} onChange={(e) => setCutout(e.target.checked)} data-testid="three-d-cutout" />
            {T.cutout}
          </label>
        )}
        {hasDetail && (
          <div className="flex items-center gap-2">
            <span className="t-control text-gray-400">{T.detail}</span>
            <Segmented
              size="sm"
              ariaLabel={T.detail}
              layoutId="three-d-detail"
              value={shownDetail}
              onChange={pickDetail}
              options={DETAILS.map((d) => ({ value: d, label: T.details[d] }))}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** Left, Back, Right for a model that takes several views. Front is the
 *  picture on the Stage. */
function SideStrip({ maxViews }: { maxViews: number }) {
  const views = useCreateStore((s) => s.threeDViews)
  const setViews = useCreateStore((s) => s.setThreeDViews)
  const setError = useCreateStore((s) => s.setError)
  const inputRef = useRef<HTMLInputElement>(null)
  const [slot, setSlot] = useState(0)
  const sides = T.sides.slice(1, maxViews)
  const pick = (i: number) => {
    setSlot(i)
    inputRef.current?.click()
  }
  const onFile = async (f: File | undefined) => {
    if (!f) return
    try {
      const ref = await loadImageRef(f)
      const next = [...views]
      next[slot] = ref
      setViews(next.filter(Boolean))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="three-d-sides">
      <span className="t-control text-gray-300">{T.moreSides}</span>
      <div className="flex gap-2">
        {sides.map((name, i) => (
          <Slot key={name} name={name} image={views[i]} onPick={() => pick(i)} onClear={() => setViews(views.filter((_, k) => k !== i))} />
        ))}
      </div>
      <span className="t-meta text-gray-500">{T.moreSidesSub}</span>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

function Slot({ name, image, onPick, onClear, active }: { name: string; image?: ImageRef; onPick: () => void; onClear?: () => void; active?: boolean }) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onPick}
        title={name}
        className={cn(
          'w-16 h-16 rounded-lg border overflow-hidden flex flex-col items-center justify-center gap-0.5 t-label text-gray-400',
          active ? 'border-lu-accent' : 'border-white/10 hover:border-white/25',
        )}
      >
        {image ? <img src={image.url} alt={name} className="w-full h-full object-cover" /> : <><Plus size={14} />{name}</>}
      </button>
      {image && onClear && (
        <button type="button" aria-label={`Remove ${name}`} onClick={onClear} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-gray-200 flex items-center justify-center">
          <X size={11} />
        </button>
      )}
    </div>
  )
}

/** A video in, still frames out. The user picks which moments become the
 *  sides: one for a model that takes one picture, up to four otherwise. */
function VideoFrames({ maxViews }: { maxViews: number }) {
  const setSource = useCreateStore((s) => s.setSource)
  const setViews = useCreateStore((s) => s.setThreeDViews)
  const setError = useCreateStore((s) => s.setError)
  const inputRef = useRef<HTMLInputElement>(null)
  const [frames, setFrames] = useState<ImageRef[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [reading, setReading] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const want = Math.max(1, Math.min(4, maxViews))

  // The picked moments, in order, become the Stage source and the sides.
  useEffect(() => {
    if (!frames.length) return
    const chosen = picked.map((i) => frames[i]).filter(Boolean)
    setSource(chosen[0] ?? null)
    setViews(chosen.slice(1))
  }, [frames, picked, setSource, setViews])

  const onFile = async (f: File | undefined) => {
    if (!f) return
    setReading(true)
    setName(f.name)
    const url = URL.createObjectURL(f)
    try {
      const blobs = await framesAcrossVideo(url, FRAME_CHOICES)
      const refs: ImageRef[] = []
      for (const [i, b] of blobs.entries()) {
        refs.push(await loadImageRef(new File([b], `${f.name.replace(/\.[^.]+$/, '')}-frame-${i + 1}.jpg`, { type: b.type || 'image/jpeg' })))
      }
      setFrames(refs)
      setPicked(evenPick(refs.length, want))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      URL.revokeObjectURL(url)
      setReading(false)
    }
  }

  const toggle = (i: number) => {
    setPicked((p) => {
      if (want === 1) return [i]
      if (p.includes(i)) return p.length > 1 ? p.filter((k) => k !== i) : p
      return p.length >= want ? [...p.slice(1), i] : [...p, i].sort((a, b) => a - b)
    })
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="three-d-video">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="self-start flex items-center gap-2 h-[var(--control-h-md)] px-3 rounded-lg border border-white/10 hover:border-white/25 t-control text-gray-200"
        data-testid="three-d-video-pick"
      >
        <Film size={14} />
        {name ?? T.dropVideo}
      </button>
      {!frames.length && !reading && <span className="t-meta text-gray-500">{T.dropVideoSub}</span>}
      {reading && <span className="t-meta text-gray-400">{T.framesReading}</span>}
      {frames.length > 0 && (
        <>
          <span className="t-meta text-gray-400">{want > 1 ? T.framesMany : T.framesOne}</span>
          <div className="flex flex-wrap gap-2" data-testid="three-d-frames">
            {frames.map((fr, i) => (
              <Slot key={fr.url} name={`${i + 1}`} image={fr} active={picked.includes(i)} onPick={() => toggle(i)} />
            ))}
          </div>
          <span className="t-meta text-gray-500">{T.videoHonest}</span>
        </>
      )}
      <input ref={inputRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

/** `want` indices spread evenly over `n` frames: 0, 2, 4, 6 of eight. */
export function evenPick(n: number, want: number): number[] {
  if (n <= 0) return []
  const k = Math.min(want, n)
  if (k === 1) return [Math.floor((n - 1) / 2)]
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / k))
}
