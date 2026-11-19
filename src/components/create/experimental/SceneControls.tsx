// Scene to Video (3.1.3, port of the web's SceneControls of 16.11.2026). The
// prompt window is the one of every tab: the scene video goes up on the stage
// or with the one upload icon of the window (SceneVideoButton); the look and
// the style stand at the head of the settings (SceneSettings, AdvancedDrawer),
// the own first frame on the stage (SceneStage). The rules live in
// lib/render/scene.ts, the cloud frame step in lib/create/scene-frame.ts.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Film } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { SCENE_STYLES, SCENE_TEMPLATES, sceneControlOptions, sceneLookPrompt } from '../../../lib/render/scene'
import { firstVideoFrame } from './SwapFrameSteps'
import { mediaRefFrom } from './mediaRef'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'

export const SCENE_VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm'
export const SCENE_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm']
const UNREADABLE = 'This video could not be read. Try an MP4, MOV or WebM.'

/** The ratio of a clip in the plainest words: 9:16, 16:9, 1:1, else w:h. */
export function sceneAspect(width: number, height: number): string {
  if (!width || !height) return ''
  const known: [number, number][] = [[9, 16], [16, 9], [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [21, 9]]
  const r = width / height
  const hit = known.find(([w, h]) => Math.abs(r - w / h) < 0.02)
  if (hit) return `${hit[0]}:${hit[1]}`
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(width, height)
  return `${width / g}:${height / g}`
}

/** Length and size of a clip, read in the WebView. */
function readClip(url: string): Promise<{ seconds: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    let done = false
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); v.removeAttribute('src'); v.load() }
    const timer = setTimeout(() => finish(() => reject(new Error(UNREADABLE))), 10_000)
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => finish(() => (Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0
      ? resolve({ seconds: v.duration, width: v.videoWidth, height: v.videoHeight })
      : reject(new Error(UNREADABLE))))
    v.onerror = () => finish(() => reject(new Error(UNREADABLE)))
    v.src = url
  })
}

/** Reads length, size and the first frame of the scene video once per video.
 *  When the first frame does not come, `firstFailed` says so and
 *  `retryFirst` reads it again (never "Reading" forever). */
export function useSceneClip(): { error: string | null; firstFailed: boolean; retryFirst: () => void } {
  const videoInput = useCreateStore((s) => s.videoInput)
  const clip = useCreateStore((s) => s.scene.clip)
  const first = useCreateStore((s) => s.scene.first)
  const setScene = useCreateStore((s) => s.setScene)
  const [error, setError] = useState<{ url: string; text: string } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!videoInput) return
    const url = videoInput.url
    let alive = true
    if (clip?.videoUrl !== url) {
      void readClip(url).then((c) => { if (alive) { setError(null); setScene({ clip: { videoUrl: url, ...c } }) } })
        .catch((e: Error) => { if (alive) setError({ url, text: e.message }) })
    }
    if (first?.videoUrl !== url) {
      void firstVideoFrame(url).then((f) => { if (alive) { setFailedFor(null); setScene({ first: { videoUrl: url, ...f } }) } })
        .catch(() => { if (alive) setFailedFor(url) })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoInput?.url, attempt])
  return {
    error: error && videoInput && error.url === videoInput.url ? error.text : null,
    firstFailed: !!videoInput && failedFor === videoInput.url,
    retryFirst: () => { setFailedFor(null); setAttempt((n) => n + 1) },
  }
}

/** The one upload icon of the prompt window on Scene to Video. */
export function SceneVideoButton() {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  const setError = useCreateStore((s) => s.setError)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const ref = useRef<HTMLInputElement>(null)
  const label = videoInput ? 'Change scene video' : 'Add scene video'
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={SCENE_VIDEO_ACCEPT}
        className="hidden"
        aria-label={label}
        data-testid="scene-video-input"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          if (f.type && !SCENE_VIDEO_TYPES.includes(f.type)) { setError('Use an MP4, MOV or WebM video.'); return }
          setError(null)
          setVideoInput(mediaRefFrom(f))
        }}
      />
      <Tooltip content="Your grey 3D scene as a video: MP4, MOV or WebM, 2 to 10 s.">
        <Button variant="ghost" size="sm" icon={Film} iconOnly disabled={isGenerating} onClick={() => ref.current?.click()} title={label} ariaLabel={label} />
      </Tooltip>
    </>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5" data-scene-setting={label}>
      <span className="t-control w-[56px] shrink-0 text-gray-400">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** At the head of the settings (the web's rows of 18.11.2026): Look and
 *  Style, each a list. Picking one sets the model (on the cloud) and writes
 *  the prompt from both, which the customer may then edit. */
export function SceneSettings() {
  const backend = useCreateStore((s) => s.backend)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const setCloudOpModel = useCreateStore((s) => s.setCloudOpModel)
  const setCloudStudioOptions = useCreateStore((s) => s.setCloudStudioOptions)
  const [look, setLook] = useState('')
  const [style, setStyle] = useState('')

  const write = (lookId: string, styleId: string) => {
    if (isGenerating) return
    const t = SCENE_TEMPLATES.find((x) => x.id === lookId)
    // A look carries the cloud model it was made for. In Local mode the run
    // stays on the local model: only the words change.
    if (t && backend === 'cloud') {
      setCloudOpModel(t.model)
      setCloudStudioOptions(sceneControlOptions(t.model, t.control, t.strength))
    }
    const text = sceneLookPrompt(lookId || null, styleId || null)
    if (text) setPrompt(text)
  }
  const summary = SCENE_TEMPLATES.find((t) => t.id === look)?.summary

  return (
    <div className="space-y-1 border-b border-white/10 pb-3 mb-3" data-scene-settings>
      <Row label="Look">
        <Select
          size="sm"
          ariaLabel="Look"
          className="w-full"
          value={look}
          options={[{ value: '', label: 'Your own' }, ...SCENE_TEMPLATES.map((t) => ({ value: t.id, label: t.title, sublabel: t.word }))]}
          onChange={(v) => { setLook(v); write(v, style) }}
        />
      </Row>
      <Row label="Style">
        <Select
          size="sm"
          ariaLabel="Style"
          className="w-full"
          value={style}
          options={[{ value: '', label: 'None' }, ...SCENE_STYLES.map((st) => ({ value: st.id, label: st.label }))]}
          onChange={(v) => { setStyle(v); write(look, v) }}
        />
      </Row>
      {summary && <p className="t-body pl-[66px] text-gray-500" data-scene-look-note>{summary}</p>}
    </div>
  )
}
