// Scene to Video (3.1.3, port of the web's SceneStage of 16.11.2026): the
// stage of the tab until a result is on it. Without a clip the drop field;
// with one the scene and its first frame side by side, centred on the axis of
// the prompt window, and right below them the open field for the customer's
// own first frame: an image dropped or picked, or (on LU Cloud) one generated
// from the prompt on the frame taken from the clip, so the layout stays. An
// own frame takes the place of the taken one; its X brings the taken one back.
//
// Local mode never runs the cloud frame step: the field offers the upload
// only and says that generating a frame is a cloud step. No silent switch.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Film, ImagePlus, Wand2, X } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import {
  SCENE_MAX_SECONDS, sceneFormatProblem, sceneLengthProblem, sceneLocalTrimNote, sceneReadsFrame, sceneSizeProblem,
} from '../../../lib/render/scene'
import { createRunModel } from '../../../lib/render/create-studio'
import { modelLabel } from '../../../lib/render/preset-models'
import { swapShortCredits } from '../../../lib/render/swap'
import { runSceneFrame, sceneFrameFor, sceneFramePrice } from '../../../lib/create/scene-frame'
import { cancelJob, pollJob, submitCloudJob, uploadInput } from '../../../api/cloud/jobs'
import { describeSubmitError, failedJobText } from '../../../lib/create/engine'
import { signalCreditsExhausted } from '../../../lib/credits-exhausted'
import { SCENE_VIDEO_ACCEPT, SCENE_VIDEO_TYPES, sceneAspect, useSceneClip } from './SceneControls'
import { loadImageRef } from './loadImage'
import { mediaRefFrom } from './mediaRef'
import { useCreateExp } from './CreateContext'
import { cn } from '../ui/cn'
import { ICON_STROKE_MARK } from '../../ui/icon-size'

const DASHED_IDLE = 'border-white/15 hover:border-white/25'
const DASHED_DRAG = 'border-white/35'
const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,image/avif'

function Media({ caption, children, ratio }: { caption: ReactNode; children: ReactNode; ratio?: string }) {
  return (
    <figure className="flex min-w-0 flex-none flex-col items-center gap-1">
      <div className="relative max-w-[40vw] md:max-w-[340px] [&>img]:rounded-md [&>video]:rounded-md" style={{ aspectRatio: ratio ?? '16 / 9', height: 'var(--scene-h)' }}>
        {children}
      </div>
      <figcaption className="t-control max-w-full shrink-0 truncate text-gray-500">{caption}</figcaption>
    </figure>
  )
}

/** The open field under the previews: the customer's own first frame,
 *  dropped, picked or (on LU Cloud) generated from the prompt. */
function OwnFrame({ videoUrl, first, model }: {
  videoUrl: string
  first: { videoUrl: string; url: string; width: number; height: number } | null
  model: string | null
}) {
  const { refreshQuota } = useCreateExp()
  const backend = useCreateStore((s) => s.backend)
  const setScene = useCreateStore((s) => s.setScene)
  const prompt = useCreateStore((s) => s.prompt)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  // videoUrl '' is the field before any clip: a picked picture waits there
  // and goes with the first clip (createStore setVideoInput).
  const own = useCreateStore((s) => (videoUrl ? sceneFrameFor(s.scene, videoUrl) : s.scene.frame?.videoUrl === '' ? s.scene.frame : null))
  const pick = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  const cloud = backend === 'cloud'
  const credits = cloud ? sceneFramePrice(first) : null
  const noPrompt = !prompt.trim()
  const locked = busy || isGenerating

  const take = (f: File | undefined) => {
    if (!f || locked) return
    if (!f.type.startsWith('image/')) { setError('That file type is not supported. Use PNG, JPG or WebP.'); return }
    setError(null)
    void loadImageRef(f).then(
      (img) => setScene({ frame: { kind: 'upload', url: img.url, width: img.width ?? 0, height: img.height ?? 0, videoUrl } }),
      (err: unknown) => setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  const generate = async () => {
    if (!cloud || !first || noPrompt || locked) return
    setBusy(true)
    setScene({ frameBusy: true })
    setError(null)
    const ac = new AbortController()
    abort.current = ac
    try {
      const job = await runSceneFrame(
        { first, look: prompt, credits },
        { uploadInput: (file, role) => uploadInput(file, role), submitCloudJob, pollJob, cancelJob, signal: ac.signal, onStep: setStep },
      )
      if (job.status === 'succeeded' && job.result_url) {
        setScene({ frame: { kind: 'designed', jobId: job.id, url: job.result_url, model: job.model, videoUrl } })
      } else if (job.status !== 'canceled') {
        setError(failedJobText(job))
      }
    } catch (err) {
      const failure = describeSubmitError(err, signalCreditsExhausted)
      if (failure.text && failure.text !== 'Canceled.') setError(failure.text)
    } finally {
      abort.current = null
      setBusy(false)
      setScene({ frameBusy: false })
      setStep('')
      void refreshQuota()
    }
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!locked) setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files[0]) }}
      // A click anywhere in the field picks an image, except on its buttons.
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button, input') && !locked) pick.current?.click() }}
      className={cn('flex w-fit min-w-[min(100%,420px)] max-w-full flex-col items-center gap-1 rounded-[var(--radius-panel)] border border-dashed px-6 py-3 text-center', !locked && 'cursor-pointer', drag ? DASHED_DRAG : DASHED_IDLE)}
      data-scene-own
    >
      <input ref={pick} type="file" accept={PICTURE_ACCEPT} className="hidden" data-testid="scene-frame-input"
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
      <p className="t-control font-medium text-gray-200">Your own first frame</p>
      {busy ? (
        <div className="flex items-center gap-3" data-scene-own-busy>
          <span className="t-body text-gray-500" role="status">{step || 'Generating…'}</span>
          <button type="button" onClick={() => abort.current?.abort()} className="t-control text-gray-500 underline-offset-[5px] hover:text-gray-200 hover:underline">Cancel</button>
        </div>
      ) : (
        <div className="flex flex-row items-center gap-4">
          <button type="button" disabled={locked} onClick={() => pick.current?.click()}
            className="t-control inline-flex min-h-[32px] items-center gap-1.5 text-gray-300 hover:text-white disabled:opacity-40" data-scene-own-upload>
            <ImagePlus size={14} /> Drop an image or click
          </button>
          {cloud && (
            <>
              <span className="h-4 w-px bg-white/10" aria-hidden />
              <button type="button" disabled={!first || noPrompt || locked} onClick={() => void generate()}
                className="t-control inline-flex min-h-[32px] items-center gap-1.5 text-gray-300 hover:text-white disabled:opacity-40" data-scene-own-generate>
                <Wand2 size={14} /> Generate from prompt
                {credits != null && <span className="tabular-nums text-gray-500" data-scene-own-credits>{swapShortCredits(credits)}</span>}
              </button>
            </>
          )}
        </div>
      )}
      {!busy && !videoUrl && (own
        ? <p className="t-body flex items-center gap-2 text-gray-500" data-scene-own-pending>
            <img src={own.url} alt="Your first frame" className="h-8 w-auto rounded-sm" />
            Goes with your scene.
            <button type="button" onClick={() => setScene({ frame: null })} className="underline underline-offset-[5px] hover:text-gray-200" data-scene-own-remove>Remove</button>
          </p>
        : <p className="t-body text-gray-500" data-scene-own-hint>{cloud ? 'Add your scene to generate one.' : 'Optional. Your PC starts the clip from it.'}</p>)}
      {!busy && videoUrl && cloud && noPrompt && <p className="t-body text-gray-500" data-scene-own-hint>Write a prompt to generate.</p>}
      {!cloud && videoUrl && !own && <p className="t-body text-gray-500" data-scene-own-hint>Generating a first frame runs on LU Cloud. Switch to Cloud for it.</p>}
      {own && model && cloud && !sceneReadsFrame(model) && <p className="t-body text-gray-500">{modelLabel(model)} reads no first frame.</p>}
      {error && <p className="t-body text-red-300" role="alert">{error}</p>}
    </div>
  )
}

export function SceneStage() {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  const setError = useCreateStore((s) => s.setError)
  const scene = useCreateStore((s) => s.scene)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const backend = useCreateStore((s) => s.backend)
  const setScene = useCreateStore((s) => s.setScene)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const pick = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const { error: readError, firstFailed, retryFirst } = useSceneClip()

  const url = videoInput?.url
  const clip = scene.clip?.videoUrl === url ? scene.clip : null
  const first = scene.first?.videoUrl === url ? scene.first : null
  const frame = sceneFrameFor(scene, url)
  const ratio = clip ? `${clip.width} / ${clip.height}` : first ? `${first.width} / ${first.height}` : undefined
  const cloud = backend === 'cloud'
  const model = cloud ? createRunModel('scene', { image: '', video: '', op: cloudOpModel }) : null
  const problem = readError
    ?? (clip ? sceneLengthProblem(clip.seconds) : null)
    ?? (videoInput && model ? sceneFormatProblem(model, videoInput.name) ?? sceneSizeProblem(model, videoInput.blob.size) : null)
  const note = problem ? null
    : !cloud ? sceneLocalTrimNote(clip?.seconds)
      : clip && clip.seconds > SCENE_MAX_SECONDS + 0.05 ? `Longer than ${SCENE_MAX_SECONDS} s: the first ${SCENE_MAX_SECONDS} s are used.` : null

  const take = (f: File | undefined) => {
    if (!f) return
    if (f.type && !SCENE_VIDEO_TYPES.includes(f.type)) { setError('Use an MP4, MOV or WebM video.'); return }
    setError(null)
    setVideoInput(mediaRefFrom(f))
  }

  const input = (
    <input ref={pick} type="file" accept={SCENE_VIDEO_ACCEPT} className="hidden" data-testid="scene-stage-input"
      onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
  )

  if (!videoInput) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scrollbar-thin p-6" data-scene-stage>
        <div className="m-auto flex w-full flex-col items-center">
          <div
            role="button"
            tabIndex={0}
            onClick={() => pick.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.current?.click() } }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files[0]) }}
            className={cn(
              'flex aspect-[5/4] max-h-[36vh] min-h-[200px] w-full max-w-sm cursor-pointer flex-col items-center justify-center gap-3 rounded-[var(--radius-panel)] border-2 border-dashed bg-white/[0.02] transition-colors',
              drag ? 'border-white/30' : 'border-white/10 hover:border-white/20',
            )}
            data-scene-empty
          >
            <Film className="text-lu-accent drop-shadow-[0_0_7px_var(--color-lu-accent-ring)]" size={30} strokeWidth={ICON_STROKE_MARK} />
            <div className="text-center">
              <div className="t-title text-gray-300">Replace any scene with its camera move.</div>
              <div className="t-body text-gray-500">Drop a video or click · MP4, MOV, WebM · 2 to 10 s</div>
            </div>
            {input}
          </div>
          {/* The own first frame stays in sight before the clip too. */}
          <div className="mt-3 flex w-full justify-center"><OwnFrame videoUrl="" first={null} model={model} /></div>
        </div>
      </div>
    )
  }

  // Centred in the free space while it fits, from the top once it does not.
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scrollbar-thin px-4 py-3" data-scene-stage>
      <div className="my-auto flex w-full max-w-[760px] flex-col items-center gap-3 [--scene-h:min(24vh,240px)]" data-scene-column>
        <div className="flex items-start justify-center gap-3" data-scene-previews>
          <Media caption={clip ? `Scene · ${clip.seconds.toFixed(1)} s · ${sceneAspect(clip.width, clip.height)}` : 'Scene'} ratio={ratio}>
            <video src={videoInput.url} muted loop autoPlay playsInline className="h-full w-full object-contain" data-scene-video />
          </Media>
          <Media caption={frame ? 'Your first frame' : 'First frame'} ratio={ratio}>
            {(frame ?? first) && <img src={(frame ?? first)!.url} alt={frame ? 'Your first frame' : 'First frame of your scene'} className="h-full w-full object-contain" data-scene-frame={frame ? 'own' : 'taken'} />}
            {!frame && !first && firstFailed && (
              <div className="t-label absolute inset-0 grid place-items-center p-2 text-center text-gray-500">
                <button type="button" onClick={retryFirst} className="underline underline-offset-[5px] hover:text-gray-200">The first frame did not come. Try again</button>
              </div>
            )}
            {frame && (
              <button type="button" disabled={isGenerating} onClick={() => setScene({ frame: null })}
                aria-label="Back to the first frame of the scene" title="Back to the first frame of the scene"
                className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-[#1e1e1e] text-gray-100 hover:bg-[#2a2a2a] disabled:opacity-40"
                data-scene-own-remove>
                <X size={14} />
              </button>
            )}
          </Media>
        </div>
        <OwnFrame videoUrl={videoInput.url} first={first} model={model} />
        {(problem || note) && (
          <p className={cn('t-body text-center', problem ? 'text-red-300' : 'text-gray-500')} role={problem ? 'alert' : undefined} data-scene-note>
            {problem ?? note}
          </p>
        )}
      </div>
      {input}
    </div>
  )
}
