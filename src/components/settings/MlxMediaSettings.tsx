// MAC-3 (2.6.0) — the install surface for local media on macOS.
//
// Every Rust command this drives (install_mlx_diffusion, mlx_image_install_model,
// video_install_mlx, video_install_model, …) already existed and was reachable
// from nowhere: a fresh Mac had no way to set up the MLX engine or pull a model,
// so Create's local lanes failed with a setup error the user couldn't act on.
// This panel is that missing path. ComfyUI is never involved on macOS.
//
// Install state lives in Rust (one slot per install kind), so the panel polls
// while something runs instead of holding progress in React.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Cpu, Download, Trash2, Loader2, Check, AlertTriangle, Film, Image as ImageIcon } from 'lucide-react'
import {
  mlxStatus,
  listMlxImageModels,
  installMlxImageModel,
  getMlxImageInstallStatus,
  deleteMlxImageModel,
  installMlxImageEngine,
  getMlxImageEngineStatus,
  type MlxStatus,
  type MlxImageModel,
} from '../../api/mlx-image'
import {
  getVideoStatus,
  listVideoModels,
  installMlxVideo,
  getMlxInstallStatus,
  installVideoModel,
  getModelInstallStatus,
  deleteVideoModel,
  type VideoStatus,
  type VideoModel,
} from '../../api/mlx-video'
import { formatBytes } from '../../lib/formatters'
import { useMlxInstallStore } from '../../stores/mlxInstallStore'

const POLL_MS = 1500

type Busy =
  | { kind: 'image-engine' }
  | { kind: 'video-engine' }
  | { kind: 'image-model'; id: string }
  | { kind: 'video-model'; id: string }
  | null

const rowCls =
  'flex items-start justify-between gap-3 p-2.5 rounded-lg border border-gray-200 dark:border-white/8'
const btnCls =
  'inline-flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const primaryCls = `${btnCls} bg-purple-600/90 hover:bg-purple-600 text-white`
const ghostCls = `${btnCls} text-gray-500 hover:text-gray-700 dark:hover:text-gray-300`

/** Download line for the video installer, which reports real byte counts. */
function progressLine(p: { download_progress: number; download_total: number; download_speed: number }): string | null {
  if (!p.download_total) return null
  const pct = Math.min(100, Math.round((p.download_progress / p.download_total) * 100))
  const speed = p.download_speed > 0 ? ` · ${formatBytes(p.download_speed)}/s` : ''
  return `${pct}% — ${formatBytes(p.download_progress)} of ${formatBytes(p.download_total)}${speed}`
}

/** `only` lets the Model Manager show just one half under its Image / Video
 *  rail; Settings passes nothing and gets both. */
export function MlxMediaSettings({ only }: { only?: 'image' | 'video' } = {}) {
  const showImage = only !== 'video'
  const showVideo = only !== 'image'
  const [engine, setEngine] = useState<MlxStatus | null>(null)
  const [images, setImages] = useState<MlxImageModel[]>([])
  const [video, setVideo] = useState<VideoStatus | null>(null)
  const [videos, setVideos] = useState<VideoModel[]>([])

  const [busy, setBusy] = useState<Busy>(null)
  const [log, setLog] = useState<string[]>([])
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // Keep the latest busy kind readable from inside the interval callback
  // without re-arming the timer on every state change.
  const busyRef = useRef<Busy>(null)
  useEffect(() => { busyRef.current = busy }, [busy])

  const refresh = useCallback(async () => {
    const [e, i, v, vm] = await Promise.all([
      mlxStatus().catch(() => null),
      listMlxImageModels().catch(() => [] as MlxImageModel[]),
      getVideoStatus().catch(() => null),
      listVideoModels().catch(() => [] as VideoModel[]),
    ])
    setEngine(e)
    setImages(i)
    setVideo(v)
    setVideos(vm)
  }, [])

  // The state writes sit behind four awaits inside `refresh`; the compiler
  // lint reads through the callback and calls them synchronous anyway.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // Poll the Rust install slot for whichever install is running.
  useEffect(() => {
    if (!busy) return
    let cancelled = false
    const tick = async () => {
      const current = busyRef.current
      if (!current) return
      try {
        if (current.kind === 'image-engine' || current.kind === 'image-model') {
          const s = current.kind === 'image-engine'
            ? await getMlxImageEngineStatus()
            : await getMlxImageInstallStatus()
          if (cancelled) return
          setLog(s.logs.slice(-6))
          if (s.status === 'error') {
            setError(s.error || 'Install failed.')
            setBusy(null)
            void refresh()
          } else if (s.status === 'complete') {
            setBusy(null)
            setProgress(null)
            void refresh()
          }
        } else {
          const s = current.kind === 'video-engine'
            ? await getMlxInstallStatus()
            : await getModelInstallStatus()
          if (cancelled) return
          setLog(s.logs.slice(-6))
          setProgress(progressLine(s))
          if (s.status === 'error') {
            setError(s.error || 'Install failed.')
            setBusy(null)
            void refresh()
          } else if (s.status === 'complete') {
            setBusy(null)
            setProgress(null)
            void refresh()
          }
        }
      } catch {
        /* transient — the next tick retries */
      }
    }
    const id = setInterval(tick, POLL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [busy, refresh])

  const start = async (next: NonNullable<Busy>, fn: () => Promise<unknown>, trayLabel: string) => {
    setError(null)
    setLog([])
    setProgress(null)
    setBusy(next)
    try {
      await fn()
      // Mirror the install into the titlebar download tray, which keeps
      // following it after this panel unmounts.
      useMlxInstallStore.getState().watch(next.kind, trayLabel)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  const remove = async (kind: 'image' | 'video', id: string) => {
    setError(null)
    try {
      if (kind === 'image') await deleteMlxImageModel(id)
      else await deleteVideoModel(id)
      setConfirmDelete(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const imageEngineReady = !!engine?.installed
  const videoEngineReady = !!video?.mlxInstalled
  const anyBusy = busy !== null

  const modelRow = (
    kind: 'image' | 'video',
    m: { id: string; name: string; sizeGB: number; minRamGB: number; unfiltered: boolean; description: string; installed: boolean },
    engineReady: boolean,
  ) => {
    const installing = busy?.kind === `${kind}-model` && 'id' in busy && busy.id === m.id
    return (
      <div key={m.id} className={rowCls}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[0.7rem] text-gray-800 dark:text-gray-200">{m.name}</span>
            {m.installed && <Check size={11} className="text-green-500 shrink-0" />}
            {m.unfiltered && (
              <span className="px-1 rounded text-[0.55rem] bg-purple-500/15 text-purple-500 dark:text-purple-300">unfiltered</span>
            )}
          </div>
          <div className="text-[0.6rem] text-gray-500 leading-relaxed mt-0.5">{m.description}</div>
          <div className="text-[0.55rem] text-gray-500 mt-0.5 font-mono">
            {m.sizeGB} GB download · needs {m.minRamGB} GB unified memory
          </div>
        </div>
        <div className="shrink-0">
          {m.installed ? (
            confirmDelete === `${kind}:${m.id}` ? (
              <div className="flex gap-1">
                <button className={`${btnCls} text-red-500 hover:text-red-400`} onClick={() => remove(kind, m.id)}>
                  Delete
                </button>
                <button className={ghostCls} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className={ghostCls} onClick={() => setConfirmDelete(`${kind}:${m.id}`)} disabled={anyBusy}>
                <Trash2 size={11} /> Remove
              </button>
            )
          ) : (
            <button
              className={primaryCls}
              disabled={anyBusy || !engineReady}
              title={engineReady ? undefined : 'Install the engine first'}
              onClick={() =>
                start(
                  { kind: kind === 'image' ? 'image-model' : 'video-model', id: m.id },
                  () => (kind === 'image' ? installMlxImageModel(m.id) : installVideoModel(m.id)),
                  m.name,
                )
              }
            >
              {installing ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
              {installing ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 p-2.5 rounded-lg border border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-white/[0.03]">
        <Cpu size={14} className="mt-0.5 shrink-0 text-purple-500" />
        <div className="text-[0.65rem] leading-relaxed text-gray-600 dark:text-gray-400">
          <strong className="text-gray-800 dark:text-gray-200">Local media on this Mac runs on Apple MLX.</strong> Images
          and video generate on the GPU with no server involved. The engine is a one-time setup; each model is a separate
          download you can remove again.
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg border border-red-300 dark:border-red-500/25 bg-red-50 dark:bg-red-500/[0.08] text-red-700 dark:text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div className="text-[0.65rem] leading-relaxed break-words">{error}</div>
        </div>
      )}

      {/* ── Image ─────────────────────────────────────────── */}
      {showImage && (<>
      <div className="flex items-center gap-1.5 pt-1">
        <ImageIcon size={12} className="text-gray-500" />
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-300">Images</span>
      </div>

      <div className={rowCls}>
        <div>
          <div className="text-[0.7rem] text-gray-800 dark:text-gray-200">Image engine</div>
          <div className="text-[0.6rem] text-gray-500 mt-0.5">
            {imageEngineReady
              ? `Installed${engine?.running ? ' · running' : ''}${engine?.modelRepo ? ` · ${engine.modelRepo}` : ''}`
              : 'Not installed — about 3 GB of Python packages (torch, diffusers).'}
          </div>
        </div>
        {!imageEngineReady && (
          <button className={primaryCls} disabled={anyBusy} onClick={() => start({ kind: 'image-engine' }, installMlxImageEngine, 'MLX image engine')}>
            {busy?.kind === 'image-engine' ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            {busy?.kind === 'image-engine' ? 'Installing…' : 'Install engine'}
          </button>
        )}
      </div>

      {images.map((m) => modelRow('image', m, imageEngineReady))}
      </>)}

      {/* ── Video ─────────────────────────────────────────── */}
      {showVideo && (<>
      <div className="flex items-center gap-1.5 pt-1">
        <Film size={12} className="text-gray-500" />
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-300">Video</span>
      </div>

      {video && !video.appleSilicon && (
        <div className="text-[0.6rem] text-gray-500">
          Local video needs Apple Silicon. Video generation is available in LU Cloud on this machine.
        </div>
      )}

      <div className={rowCls}>
        <div>
          <div className="text-[0.7rem] text-gray-800 dark:text-gray-200">Video engine</div>
          <div className="text-[0.6rem] text-gray-500 mt-0.5">
            {videoEngineReady
              ? `Installed${video?.mlxVersion ? ` · mlx ${video.mlxVersion}` : ''}`
              : 'Not installed — MLX video packages.'}
          </div>
        </div>
        {!videoEngineReady && (
          <button
            className={primaryCls}
            disabled={anyBusy || (video ? !video.appleSilicon : false)}
            onClick={() => start({ kind: 'video-engine' }, installMlxVideo, 'MLX video engine')}
          >
            {busy?.kind === 'video-engine' ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            {busy?.kind === 'video-engine' ? 'Installing…' : 'Install engine'}
          </button>
        )}
      </div>

      {videos.map((m) => modelRow('video', m, videoEngineReady))}

      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        Video models are large and generation is slow — minutes per clip, not seconds. Start with the smallest model.
      </div>
      </>)}

      {/* ── Live install output ───────────────────────────── */}
      {(anyBusy || log.length > 0) && (
        <div className="p-2.5 rounded-lg border border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-black/20">
          {progress && <div className="text-[0.6rem] text-gray-600 dark:text-gray-300 font-mono mb-1">{progress}</div>}
          <div className="text-[0.55rem] text-gray-500 font-mono space-y-0.5 max-h-24 overflow-y-auto">
            {log.map((l, i) => (
              <div key={i} className="truncate">{l}</div>
            ))}
          </div>
          {anyBusy && (
            <div className="text-[0.6rem] text-gray-500 mt-1.5">
              This keeps running if you close Settings. Large downloads can take a while.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
