import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Cpu, Sparkles, ImageDown, Maximize2, Download, Wand2, MonitorOff, AudioLines } from 'lucide-react'
import { coldLoadHint } from '../../../lib/cold-load-notice'
import { useCreateStore, type GalleryItem, type ProgressPhase } from '../../../stores/createStore'
import { backendCall, downloadComfyFile, isTauri } from '../../../api/backend'
import { isMlxImageHost } from '../../../api/mlx-image'
import { refreshResultUrl } from '../../../api/cloud/jobs'
import { ICON_LG, ICON_STROKE_MARK } from '../../ui/icon-size'
import { markGalleryItemAvailable } from './galleryUrl'
import { useComfyMedia } from './useComfyMedia'
import { cn } from '../ui/cn'

// The icon in the waiting circle says which PHASE the render is in, never
// which device it runs on. The chip is the loading phase, the spark is
// sampling. R14 Nebenbefund 2 read the chip as a CPU marker that had gone
// missing, because the R13 screenshot caught a load and the R14 pair caught
// two samplings. Checked in git: this mapping has not changed since the
// surface was ported (eaeff304, 2026-07-04), so nothing was lost. The device
// is said in words, by the yellow banner in the Create tab.
function phaseIcon(phase: ProgressPhase) {
  if (phase === 'loading-model' || phase === 'loading-clip' || phase === 'loading-vae') return <Cpu size={20} className="text-amber-300" />
  if (phase === 'sampling') return <Sparkles size={20} className="text-green-300" />
  if (phase === 'decoding') return <ImageDown size={20} className="text-lu-accent" />
  return <Sparkles size={20} className="text-gray-400" />
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
  const hint = coldLoadHint(true, elapsedMs)
  if (!hint) return null
  return <p className="t-body text-gray-500 text-center max-w-[22rem]">{hint}</p>
}

// Generation progress — phase-aware animation.
export function GeneratingView() {
  const progressPhase = useCreateStore((s) => s.progressPhase)
  const progressText = useCreateStore((s) => s.progressText)
  const progress = useCreateStore((s) => s.progress)
  const isLoading = progressPhase === 'loading-model' || progressPhase === 'loading-clip' || progressPhase === 'loading-vae'

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="space-y-6 flex flex-col items-center">
        <div className="relative w-16 h-16">
          {isLoading ? (
            <>
              <motion.div className="absolute inset-0 rounded-full border border-amber-400/30" animate={{ scale: [1, 1.6], opacity: [0.5, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeOut' }} />
              <div className="absolute inset-0 rounded-full border border-amber-400/20 flex items-center justify-center">
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}>{phaseIcon(progressPhase)}</motion.div>
              </div>
            </>
          ) : progressPhase === 'sampling' ? (
            <>
              <motion.div className="absolute inset-0 rounded-full border border-green-400/30" animate={{ scale: [1, 1.8], opacity: [0.4, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }} />
              <motion.div className="absolute inset-0 rounded-full border border-green-400/20" animate={{ scale: [1, 1.5], opacity: [0.3, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut', delay: 0.3 }} />
              <div className="absolute inset-0 rounded-full border border-green-400/10 flex items-center justify-center">{phaseIcon(progressPhase)}</div>
            </>
          ) : (
            <>
              <motion.div className="absolute inset-0 rounded-full border border-white/20" animate={{ scale: [1, 1.8], opacity: [0.4, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }} />
              <motion.div className="absolute inset-0 rounded-full border border-white/15" animate={{ scale: [1, 1.5], opacity: [0.3, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeOut', delay: 0.5 }} />
              <div className="absolute inset-0 rounded-full border border-white/10 flex items-center justify-center">{phaseIcon(progressPhase)}</div>
            </>
          )}
        </div>
        <p className="t-body text-gray-400 tracking-wide">{progressText || 'Generating…'}</p>
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
  onSendToEditor?: () => void
}

function extFor(contentType: string, kind: 'image' | 'video' | 'audio'): string {
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('mp4')) return 'mp4'
  if (contentType.includes('webm')) return 'webm'
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3'
  if (contentType.includes('wav')) return 'wav'
  if (contentType.includes('ogg')) return 'ogg'
  return kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png'
}

// Save a gallery item. Local ComfyUI outputs (non-empty filename) go through
// downloadComfyFile's proxy + native dialog. Cloud items have filename '' —
// fetch their bytes directly (re-signed first: the stored URL expires ~1 h
// after the last read); dataUrl items decode in place. Tauri gets the native
// Save-As dialog (WebView2 blob-anchors are unreliable); failures surface via
// setError instead of a silent no-op.
/** Hand bytes to the user. Tauri gets the native Save-As dialog (WebView2
 *  blob-anchors are unreliable); the browser build gets an anchor click. */
async function saveBytes(bytes: Uint8Array, name: string, ext: string): Promise<void> {
  if (!isTauri()) {
    const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart]))
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  // Returns the chosen path, or null if the user cancelled — nothing to do then.
  await invoke('save_binary_file_dialog', {
    bytes: Array.from(bytes),
    defaultName: name,
    extension: ext,
    extLabel: ext.toUpperCase(),
  })
}

async function downloadGalleryItem(item: GalleryItem): Promise<void> {
  // A local MLX render (Mac) carries BOTH a filename and a real file on disk.
  // The filename is ours, not a ComfyUI output name — routing on its mere
  // presence sent every Mac render into the ComfyUI proxy below, which cannot
  // answer here, and downloadComfyFile swallows the failure. Disk first.
  if (item.localPath) {
    try {
      const b64 = await backendCall<string>('read_media_file', { path: item.localPath })
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const ext = item.localPath.toLowerCase().endsWith('.mp4') ? 'mp4' : 'png'
      await saveBytes(bytes, `lu-${item.id}.${ext}`, ext)
    } catch (err) {
      useCreateStore
        .getState()
        .setError(`Download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  if (item.filename && item.unavailable) {
    // The item's media already failed to load — the ComfyUI fetch would only
    // fail again (and downloadComfyFile swallows its errors). Be honest.
    // Only reachable for a ComfyUI-backed item. On a Mac that can only be a
    // pre-2.6.0 leftover whose file was never written — there is no engine to
    // start there, so "start it" would be the last piece of advice a Mac user
    // could still be given about software they never had.
    useCreateStore.getState().setError(
      isMlxImageHost()
        ? 'This render is not on disk any more, so there is nothing to save.'
        : 'Download needs the local engine. Start it and try again.',
    )
    return
  }
  try {
    if (item.filename) {
      await downloadComfyFile(item.filename, item.subfolder)
      return
    }
    let url = item.dataUrl ?? item.remoteUrl
    if (!item.dataUrl && item.jobId) {
      url = (await refreshResultUrl(item.jobId)) ?? url
    }
    if (!url) throw new Error('no source available for this item')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch failed (${res.status})`)
    const ext = extFor(res.headers.get('content-type') ?? '', item.type)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await saveBytes(bytes, `lu-${item.id}.${ext}`, ext)
  } catch (err) {
    useCreateStore
      .getState()
      .setError(`Download failed: ${err instanceof Error ? err.message : String(err)}`)
  }
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

export function ResultView({ item, onFullscreen, onSendToEditor }: ResultProps) {
  const { src: url, onError } = useComfyMedia(item)
  const download = () => void downloadGalleryItem(item)
  const isVideo = item.type === 'video'
  const isAudio = item.type === 'audio'
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col">
     <div className="m-auto flex flex-col items-center p-6">
      <div className="relative group max-w-full max-h-full">
        {isAudio ? (
          <div className="w-[420px] max-w-full flex flex-col items-center gap-3 p-6 rounded-[var(--radius-panel)] border border-white/[0.06] bg-white/[0.02]">
            <AudioLines size={26} className="text-gray-400" strokeWidth={ICON_STROKE_MARK} />
            {item.prompt && (
              <p className="t-body text-gray-400 text-center line-clamp-2">{item.prompt}</p>
            )}
            <audio src={url} controls onError={onError} className="w-full" onLoadedData={() => markGalleryItemAvailable(item)} />
          </div>
        ) : isVideo ? (
          <video
            src={url}
            controls
            loop
            autoPlay
            muted
            onError={onError}
            onLoadedData={(e) => { markGalleryItemAvailable(item); reconcileDims(item, e.currentTarget.videoWidth, e.currentTarget.videoHeight) }}
            className="max-w-full max-h-[62vh] object-contain rounded-[var(--radius-panel)] border border-white/[0.06]"
          />
        ) : (
          <img
            src={url}
            alt={item.prompt}
            onError={onError}
            onLoad={(e) => { markGalleryItemAvailable(item); reconcileDims(item, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) }}
            className={cn('max-w-full max-h-[62vh] object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', item.intent === 'removebg' && 'lu-checker')}
          />
        )}
        {item.unavailable && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[var(--radius-panel)] bg-black/60 text-gray-400 p-6 text-center">
            <MonitorOff size={ICON_LG} />
            <span className="t-body">This render lives on the local engine, which isn't reachable right now.</span>
          </div>
        )}
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onSendToEditor && item.type === 'image' && !item.unavailable && (
            <IconBtn title="Edit with mask" onClick={onSendToEditor}><Wand2 size={14} /></IconBtn>
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
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3 t-mono text-gray-600">
        {!isAudio && (
          <>
            <span>{item.width}×{item.height}</span>
            <span>·</span>
            <span>seed {item.seed}</span>
            <span>·</span>
          </>
        )}
        <span className="truncate max-w-[280px]">{prettyModel(item.model)}</span>
      </div>
     </div>
    </div>
  )
}

function IconBtn({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 backdrop-blur transition-colors',
        disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-200 hover:text-white hover:bg-black/70',
      )}
    >
      {children}
    </button>
  )
}

function prettyModel(f: string): string { return f.replace(/\.(safetensors|ckpt|pt)$/i, '').replace(/[_]+/g, ' ') }
