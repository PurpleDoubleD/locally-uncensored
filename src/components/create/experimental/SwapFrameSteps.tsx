import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ImageIcon, RotateCcw } from 'lucide-react'
import { useCreateStore, type SwapFigure } from '../../../stores/createStore'
import { cancelJob, pollJob, submitCloudJob, uploadInput } from '../../../api/cloud/jobs'
import { describeSubmitError, failedJobText } from '../../../lib/create/engine'
import { runSwapFrame, swapFrameCredits, swapKeyOf } from '../../../lib/create/swap-frame'
import { swapFigureRoles, swapMaxPeople, swapShortCredits, SWAP_TAP_TEXT } from '../../../lib/render/swap'
import { signalCreditsExhausted } from '../../../lib/credits-exhausted'
import { HINWEIS_TEXT } from '../../../lib/hinweis'
import { useCreateExp } from './CreateContext'
import { cn } from '../ui/cn'

// Swap Character in two steps (14.11.2026, part A of the Character Hub, port
// of the web's SwapFrameSteps). First the customer taps each person to
// replace in the first frame of the video. Then Nano Banana Pro builds that
// frame with the new people ("Build first frame"), the customer checks it
// ("Does this look right?") and confirms with Continue. Only then does Create
// arm for the video.

/** The first frame of a video as a JPEG, drawn in the WebView (<video> at the
 *  start, painted onto a canvas). At most 2048 pixels on the long side. The
 *  desktop's video is a `blob:` URL of the picked file (mediaRef.ts), same
 *  origin, so the canvas stays readable. */
export function firstVideoFrame(url: string, maxSide = 2048): Promise<{ url: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    let done = false
    const fail = () => reject(new Error('Could not read the first frame of your video.'))
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
      video.removeAttribute('src')
      video.load()
    }
    const timer = setTimeout(() => finish(fail), 15_000)
    const draw = () => finish(() => {
      const w = video.videoWidth, h = video.videoHeight
      if (!w || !h) { fail(); return }
      const scale = Math.min(1, maxSide / Math.max(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { fail(); return }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        resolve({ url: canvas.toDataURL('image/jpeg', 0.92), width: canvas.width, height: canvas.height })
      } catch {
        fail()
      }
    })
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => { if (video.currentTime === 0) draw() }
    video.onseeked = draw
    video.onloadedmetadata = () => { try { video.currentTime = 0 } catch { /* the first frame comes with loadeddata */ } }
    video.onerror = () => finish(fail)
    video.src = url
  })
}

/** Draws the first frame as soon as a video is there and puts it in the store. */
export function useSwapFirstFrame(): void {
  const videoInput = useCreateStore((s) => s.videoInput)
  const swapFrame = useCreateStore((s) => s.swapFrame)
  const setSwapFrame = useCreateStore((s) => s.setSwapFrame)
  useEffect(() => {
    if (!videoInput) { if (swapFrame) setSwapFrame(null); return }
    if (swapFrame?.videoUrl === videoInput.url) return
    let alive = true
    void firstVideoFrame(videoInput.url)
      .then((f) => { if (alive) setSwapFrame({ ...f, videoUrl: videoInput.url }) })
      .catch(() => { if (alive) setSwapFrame(null) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoInput?.url])
}

/** The first frame, large, with a numbered mark per tapped person. A tap sets
 *  a mark, a tap on the mark takes it away again. */
export function SwapFramePicker({ max, onCount }: { max: number; onCount: (people: number) => void }) {
  const frame = useCreateStore((s) => s.swapFrame)
  const figures = useCreateStore((s) => s.swapFigures)
  const setFigures = useCreateStore((s) => s.setSwapFigures)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const box = useRef<HTMLDivElement>(null)
  if (!frame) {
    return (
      <div className="hub-dim flex h-24 w-full items-center justify-center hub-fs-125" data-swap-frame="loading">
        Reading the first frame…
      </div>
    )
  }
  const marked = figures.filter((f) => f.mark).length

  const add = (x: number, y: number) => {
    if (isGenerating || marked >= max) return
    const mark = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    // The first person without a mark gets it, else a new one joins.
    const free = figures.findIndex((f) => !f.mark)
    const next: SwapFigure[] = free >= 0
      ? figures.map((f, i) => (i === free ? { ...f, mark } : f))
      : [...figures, { image: null, role: '', mark }]
    onCount(next.length)
    setFigures(next)
  }
  const remove = (index: number) => {
    if (isGenerating) return
    // The last person stays and only loses the mark (then: the main person).
    const next = figures.length > 1 ? figures.filter((_, i) => i !== index) : figures.map((f) => ({ ...f, mark: null }))
    onCount(next.length)
    setFigures(next)
  }

  // The Character area (sketches v2): the frame large and without a border,
  // a small numbered mark per person, the one line under it says what to do.
  return (
    <div className="flex w-full flex-col items-center gap-2 pt-3" data-swap-frame="picker">
      <div
        ref={box}
        role="group"
        aria-label={`First frame of your video. ${SWAP_TAP_TEXT}.`}
        onClick={(e) => {
          const r = box.current?.getBoundingClientRect()
          if (!r || !r.width || !r.height) return
          add((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
        }}
        className={cn('relative max-w-full overflow-hidden rounded-lg bg-black', marked < max && 'cursor-crosshair')}
        style={{ aspectRatio: `${frame.width} / ${frame.height}`, height: `min(40vh, 300px, calc(min(100vw - 40px, 490px) * ${(frame.height / frame.width).toFixed(4)}))` }}
      >
        <img src={frame.url} alt="" draggable={false} className="pointer-events-none h-full w-full select-none object-cover" />
        {figures.map((f, i) => f.mark && (
          <button
            key={i}
            type="button"
            aria-label={`Remove mark ${i + 1}`}
            data-swap-mark={i + 1}
            onClick={(e) => { e.stopPropagation(); remove(i) }}
            // 44 px to hit with a finger or a trackpad, the circle inside is
            // what shows: 22 px, on a phone 26 px.
            className="absolute grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
            style={{ left: `${f.mark.x * 100}%`, top: `${f.mark.y * 100}%` }}
          >
            <span className="grid h-[19px] w-[19px] place-items-center rounded-full bg-lu-accent hub-fs-12 font-semibold text-gray-900 shadow-[0_0_0_1.5px_rgba(255,255,255,0.95),0_1px_6px_rgba(0,0,0,0.45)] max-[520px]:h-[23px] max-[520px]:w-[23px]">{i + 1}</span>
          </button>
        ))}
      </div>
      <p className="hub-dim text-center hub-fs-12" data-swap-frame-count={marked}>
        {marked === 0
          ? `${SWAP_TAP_TEXT}. Without a mark the main person is replaced.`
          : marked >= max ? `${marked} of ${max} people marked. Tap a number to remove it.` : `${SWAP_TAP_TEXT}. Tap a number to remove it.`}
      </p>
    </div>
  )
}

const QUIET_BUTTON = 't-control inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-white/[0.1] px-3 text-gray-300 hover:border-white/20 hover:text-gray-100 disabled:opacity-40'
const PRIMARY_BUTTON = 'lu-primary t-control inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-4 font-medium disabled:opacity-40'

/** Build, check, confirm the frame. Stands below the consent box. */
export function SwapFrameBuild({ model }: { model: string }) {
  const { refreshQuota } = useCreateExp()
  const videoInput = useCreateStore((s) => s.videoInput)
  const frame = useCreateStore((s) => s.swapFrame)
  const figures = useCreateStore((s) => s.swapFigures)
  const consent = useCreateStore((s) => s.swapConsent)
  const built = useCreateStore((s) => s.swapBuilt)
  const setBuilt = useCreateStore((s) => s.setSwapBuilt)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [extra, setExtra] = useState('')
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  const key = useMemo(() => swapKeyOf(videoInput?.url, figures), [videoInput?.url, figures])
  // When video, photo, mark or role change, the built frame expires.
  useEffect(() => {
    if (built && built.key !== key) setBuilt(null)
  }, [built, key, setBuilt])
  const current = built && built.key === key ? built : null
  const credits = swapFrameCredits(frame?.width ?? 9, frame?.height ?? 16, figures.length)
  const price = credits != null ? `${swapShortCredits(credits)} credits` : ''
  const ready = !!frame && figures.every((f) => !!f.image) && figures.length <= swapMaxPeople(model) && consent && !busy && !isGenerating

  const build = async (retry: boolean) => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const ac = new AbortController()
    abort.current = ac
    try {
      const job = await runSwapFrame({
        frame,
        figures: figures.map((f) => ({ imageUrl: f.image?.url ?? null, role: f.role, mark: f.mark ?? null })),
        model,
        consent,
        extra: retry ? extra : undefined,
        credits,
      }, { uploadInput: (file, role) => uploadInput(file, role, { signal: ac.signal }), submitCloudJob, pollJob, cancelJob, signal: ac.signal, onStep: setStep })
      if (job.status === 'succeeded' && job.result_url) {
        setBuilt({ jobId: job.id, url: job.result_url, key, confirmed: false })
        setExtra('')
      } else if (job.status !== 'canceled') {
        setError(failedJobText(job))
      }
    } catch (err) {
      const failure = describeSubmitError(err, signalCreditsExhausted)
      if (failure.text) setError(failure.text === 'Canceled.' ? null : failure.text)
    } finally {
      setBusy(false)
      setStep('')
      void refreshQuota()
    }
  }

  const roles = swapFigureRoles(figures)
  const who = figures.length > 1 ? `${figures.length} people` : roles[0] || 'the main person'

  if (current?.confirmed) {
    return (
      <div className="flex w-full items-center gap-2 rounded-lg border border-white/[0.08] px-2 py-1.5" data-swap-built="confirmed">
        <img src={current.url} alt="New first frame" className="h-10 w-10 shrink-0 rounded-md object-cover" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 t-body text-gray-200">
          <Check size={14} className="shrink-0 text-lu-accent" /> First frame ready. Create starts the video.
        </span>
        <button type="button" disabled={isGenerating} onClick={() => setBuilt({ ...current, confirmed: false })}
          className="t-control h-11 shrink-0 rounded-md px-2 text-gray-500 hover:text-gray-200 disabled:opacity-40">
          Change
        </button>
      </div>
    )
  }

  if (current) {
    return (
      <div className="w-full space-y-2 rounded-lg border border-white/[0.08] p-2.5" data-swap-built="review">
        <p className="t-control font-semibold text-gray-100">Does this look right?</p>
        <div className="grid grid-cols-2 gap-2">
          {[{ src: frame?.url, label: 'Original' }, { src: current.url, label: 'New first frame' }].map((p) => (
            <figure key={p.label} className="flex flex-col items-center gap-1">
              {p.src ? <img src={p.src} alt={p.label} className="max-h-[38vh] w-full rounded-md bg-white/[0.03] object-contain" /> : <ImageIcon size={18} />}
              <figcaption className="t-control text-gray-500">{p.label}</figcaption>
            </figure>
          ))}
        </div>
        <input
          type="text"
          value={extra}
          maxLength={500}
          disabled={busy}
          aria-label="What's wrong?"
          placeholder="What's wrong? (optional)"
          onChange={(e) => setExtra(e.target.value)}
          className="t-control h-11 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-gray-200 placeholder:text-gray-500"
        />
        {error && <p className={cn('t-body', HINWEIS_TEXT.fehler)} role="alert">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" disabled={!ready} onClick={() => void build(true)} data-swap-retry className={QUIET_BUTTON}>
            <RotateCcw size={13} /> {busy ? step || 'Building…' : `Try again · ${price}`}
          </button>
          <button type="button" disabled={busy} onClick={() => setBuilt({ ...current, confirmed: true })} data-swap-continue className={PRIMARY_BUTTON}>
            <Check size={14} /> Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-1.5" data-swap-built="none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="t-body min-w-0 flex-1 text-gray-500">
          Step 1: put {who} into the first frame. You check it before the video starts.
        </span>
        <button type="button" disabled={!ready} onClick={() => void build(false)} data-swap-build
          title={price ? `Build first frame · ${credits!.toLocaleString('en-US')} credits` : 'Build first frame'}
          className={ready ? PRIMARY_BUTTON : cn(QUIET_BUTTON, 'cursor-not-allowed text-gray-500')}>
          <ImageIcon size={14} />
          {busy ? step || 'Building…' : 'Build first frame'}
          {!busy && price && <span className="t-micro tabular-nums rounded-md bg-black/10 px-1.5 py-0.5 leading-none">{swapShortCredits(credits!)}</span>}
        </button>
      </div>
      {error && <p className={cn('t-body', HINWEIS_TEXT.fehler)} role="alert">{error}</p>}
    </div>
  )
}
