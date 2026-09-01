import { useRef, useState, useSyncExternalStore } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { UploadCloud, ImagePlus, Scissors, Wand2, Sparkles, X, Loader2, Download, AlertTriangle, Image as ImageIcon, Film } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { INTENT_MAP } from './intents'
import { GeneratingView, ResultView } from './OutputView'
import { EmptyState } from '../ui/EmptyState'
import { ICON_STROKE_MARK } from '../../ui/icon-size'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { loadImageRef } from './loadImage'
import {
  subscribeInstallRuns, getInstallRun, startInstallRun, cancelInstallRun, clearInstallRun,
} from '../../../lib/model-install-runs'
import { galleryItemUrl, fetchGalleryItemBlob, recoverGalleryUrl } from './galleryUrl'
import { InstallCancelled } from '../../../lib/bundle-install'
import { isMlxImageHost } from '../../../api/mlx-image'
import { videoLaneModels, bundleForVideoIntent } from '../../../api/comfyui'
import { getVideoBundles } from '../../../api/discover'

interface Props {
  displayed?: GalleryItem
  onOpenMaskEditor: () => void
  /** Adopt a finished result as the edit source, THEN open the mask editor —
   *  a t2i run leaves `source` empty, and the editor always reads `source`.
   *  Absent where the Edit intent has no working local lane (the MLX Mac),
   *  so the button only shows where inpainting actually runs. */
  onEditResult?: (item: GalleryItem) => void
  onFullscreen: (item: GalleryItem) => void
}

export function Stage({ displayed, onOpenMaskEditor, onEditResult, onFullscreen }: Props) {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const source = useCreateStore((s) => s.source)
  const sourceSetAt = useCreateStore((s) => s.sourceSetAt)
  const setPrompt = useCreateStore((s) => s.setPrompt)
  const caps = useCreateStore((s) => s.caps)
  const backend = useCreateStore((s) => s.backend)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const audioModelList = useCreateStore((s) => s.audioModelList)
  const lipsyncModelList = useCreateStore((s) => s.lipsyncModelList)
  const motionModelList = useCreateStore((s) => s.motionModelList)
  const { connected, modelsLoaded, mlxMissing } = useCreateExp()
  // On the cloud backend the utility ops (background removal, …) run on
  // WaveSpeed's hosted endpoints — there's no local ComfyUI node to install,
  // so the capability is always ready. Only the local backend gates on the
  // node probe (which never runs without a local ComfyUI and would strand
  // cloud users on a dead "Open Model Manager" card).
  const capReady = !meta.capability || backend === 'cloud' || !!caps[meta.capability]
  // Local model files missing for this intent (fresh PC): gate the stage on a
  // one-click starter-bundle card. connected === false also gates — the same
  // button installs ComfyUI itself first. connected === null (still probing)
  // gates nothing, so the card never flashes during startup.
  // "Missing" for the video lane must use the same op-gating as the picker:
  // SVD and FramePack are i2v-only, so a box whose only video model was SVD
  // passed a bare length check and never offered the starter bundle, while
  // the T2V picker showed "No matches" (David 2026-08-01).
  const videoLaneList = videoLaneModels(videoModelList, intent)
  const listForKind: Record<NonNullable<typeof meta.requiresModels>, unknown[]> = {
    image: imageModelList,
    video: videoLaneList,
    audio: audioModelList,
    lipsync: lipsyncModelList,
    motion: motionModelList,
  }
  // macOS answers this from MLX, not from ComfyUI: `connected` is deliberately
  // pinned to null there (there is nothing to connect to), so the rule below
  // would never fire and a Mac with no model installed got an empty stage and
  // no way to fix it — the setup lived in Settings, where nothing pointed.
  const macMissing =
    backend === 'local' && !!mlxMissing &&
    (meta.requiresModels === 'image' ? mlxMissing.image
      : meta.requiresModels === 'video' ? mlxMissing.video
        : false)
  const modelsMissing = macMissing || (mlxMissing === null && backend === 'local' && !!meta.requiresModels && (
    connected === false ||
    (connected === true && modelsLoaded && listForKind[meta.requiresModels].length === 0)
  ))

  // A result counts for the current source only if it was generated after the
  // source was loaded — otherwise an older gallery item would hijack the stage.
  const freshResult = displayed && displayed.createdAt >= sourceSetAt

  const characterTab = useCreateStore((s) => s.characterTab)
  const characterTrain = intent === 'character' && characterTab === 'train'

  // A bundle is not usable until ALL of its files are down, and the lane list
  // refills the moment the diffusion model alone lands. Measured on the box
  // 2026-08-15: at 88 percent the card vanished and Wan 2.2 TI2V was pickable
  // while its VAE was still at 2 percent, so Create was one click away from a
  // ComfyUI error about a file that was on its way. The card stays until the
  // run it started is finished, which is also where its progress, its Cancel
  // and its error message live.
  const installRun = useSyncExternalStore(
    subscribeInstallRuns,
    () => (meta.requiresModels ? getInstallRun(meta.requiresModels).running : false),
  )

  let body: React.ReactNode
  if (isGenerating) {
    body = <GeneratingView />
  } else if (modelsMissing || installRun) {
    body = <ModelInstallCard kind={meta.requiresModels!} />
  } else if (meta.capability && !capReady) {
    body = <CapabilityCard cap={meta.capability} />
  } else if (characterTrain) {
    // Character-Studio training board: the image SET lives here (4-30 photos);
    // trigger word + train button sit in the composer below.
    body = <TrainSetBoard />
  } else if (meta.needsSource && !source) {
    body = <InputSlot />
  } else if (meta.needsSource && source && !freshResult) {
    body = <SourcePreview onOpenMaskEditor={onOpenMaskEditor} />
  } else if (displayed) {
    body = (
      <ResultView
        item={displayed}
        onFullscreen={() => onFullscreen(displayed)}
        onSendToEditor={displayed.type === 'image' && onEditResult ? () => onEditResult(displayed) : undefined}
      />
    )
  } else {
    body = (
      <EmptyState icon={Sparkles} logoSrc="/LU-monogram-white.png" title={teachTitle(intent)}>
        {meta.examples.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5 pt-1">
            {meta.examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="t-control text-gray-400 px-2.5 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.06] hover:border-white/15 hover:text-gray-200 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </EmptyState>
    )
  }

  return (
    // The viewer canvas: ONE fixed, centred frame that is identical on every tab
    // (Image / Edit / Cutout / Video) — same height and width — so switching
    // modes no longer resizes or shifts the stage. It shares the Gallery bubble's
    // surface + radius so the two read as a matched pair, and it sits in the same
    // row as the Gallery (see CreateExperimental) so both are always equal height.
    // Whatever the mode renders (empty state, dropzone, result, install card) is
    // centred inside this frame.
    <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden p-2">
      <div className="flex-1 min-w-0 rounded-xl bg-gray-50 dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col overflow-hidden relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={intent + (isGenerating ? ':gen' : '')}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            {body}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function teachTitle(intent: string): string {
  switch (intent) {
    case 'image': return 'What do you want to create?'
    case 'video': return 'Describe a scene to animate'
    case 'edit': return 'Edit or restyle your image'
    default: return 'Get started'
  }
}

// ── Source upload dropzone ──
function InputSlot() {
  const setSource = useCreateStore((s) => s.setSource)
  const setError = useCreateStore((s) => s.setError)
  const intent = useCreateStore((s) => s.intent())
  const gallery = useCreateStore((s) => s.gallery)
  const meta = INTENT_MAP[intent]
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [loading, setLoading] = useState(false)

  // David 2026-07-10: ops never auto-adopt a gallery image — instead the slot
  // offers the recent gallery images as an EXPLICIT pick, next to drag&drop
  // and the file picker ("aus Galerie ODER vom Desktop").
  const galleryImages = gallery.filter((g) => g.type === 'image' && !g.unavailable).slice(0, 8)

  const adoptFromGallery = async (item: GalleryItem) => {
    setLoading(true)
    setError(null)
    try {
      const blob = await fetchGalleryItemBlob(item)
      const file = new File([blob], item.filename || 'source.png', { type: blob.type || 'image/png' })
      setSource(await loadImageRef(file))
    } catch (err) {
      setError(`Could not load that gallery image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleFile = async (file: File) => {
    // Drag&drop bypasses the input's accept filter — validate here so a
    // stray .txt/.pdf gets a message instead of a silent no-op. Exotic image
    // containers (HEIC/AVIF/GIF) pass: loadImageRef re-encodes them to PNG,
    // and throws honestly when the WebView can't decode them.
    if (!file.type.startsWith('image/')) {
      setError('That file type is not supported. Use PNG, JPG or WebP.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      setSource(await loadImageRef(file))
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    // Scroll-safe centering: `m-auto` centres the column when there's room and
    // collapses to a scroll when the dropzone + gallery strip exceed a short
    // window (e.g. a 1366×768 laptop) — previously the parent's overflow-hidden
    // clipped the "or pick from your gallery" strip.
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col">
      <div className="m-auto w-full max-w-sm flex flex-col items-center p-6">
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
          className={cn(
            // max-h trimmed 44vh→36vh so the "or pick from your gallery" strip
            // below stays visible without scrolling at typical window heights
            // (the 44vh drop target scaled with the window and always shoved the
            // strip just past the fold). Still scrolls gracefully on tiny windows.
            'w-full aspect-[5/4] min-h-[200px] max-h-[36vh] rounded-[var(--radius-panel)] border-2 border-dashed flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors',
            drag ? 'border-blue-400 bg-blue-500/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20',
          )}
        >
          {loading ? <Loader2 className="animate-spin text-lu-accent" size={30} /> : (
            meta.id === 'removebg'
              ? <Scissors className="text-lu-accent drop-shadow-[0_0_7px_var(--color-lu-accent-ring)]" size={30} strokeWidth={ICON_STROKE_MARK} />
              : <UploadCloud className="text-lu-accent drop-shadow-[0_0_7px_var(--color-lu-accent-ring)]" size={30} strokeWidth={ICON_STROKE_MARK} />
          )}
          <div className="text-center">
            <div className="t-title text-gray-300">{meta.id === 'removebg' ? 'Drop an image to cut out' : meta.id === 'animate' ? 'Drop an image to animate' : 'Drop an image to edit'}</div>
            <div className="t-body text-gray-600">or click to browse · PNG, JPG, WebP</div>
          </div>
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
        </div>
        {galleryImages.length > 0 && (
          <div className="mt-4 w-full">
            <div className="t-label text-gray-600 mb-2 text-center">or pick from your gallery</div>
            <div className="flex justify-center gap-1.5 overflow-x-auto pb-1">
              {galleryImages.map((g) => (
                <button
                  key={g.id}
                  onClick={() => { if (!loading) void adoptFromGallery(g) }}
                  className="shrink-0 w-12 h-12 rounded-md overflow-hidden border border-white/10 hover:border-white/30 transition-colors"
                  title="Use this image as the source"
                  aria-label="Use this gallery image as the source"
                >
                  <img src={galleryItemUrl(g)} alt="" className="w-full h-full object-cover" onError={() => recoverGalleryUrl(g)} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Source loaded, awaiting generation ──
function SourcePreview({ onOpenMaskEditor }: { onOpenMaskEditor: () => void }) {
  const source = useCreateStore((s) => s.source)
  const mask = useCreateStore((s) => s.mask)
  const setSource = useCreateStore((s) => s.setSource)
  const setMask = useCreateStore((s) => s.setMask)
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]

  // Zombie render: an intent switch drops the source in the same store update
  // that swaps this component out, but the child subscription can fire first.
  if (!source) return null

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col">
      <div className="m-auto flex flex-col items-center p-6">
        <div className="relative">
          <img src={source.url} alt="source" className={cn('max-h-[52vh] max-w-full object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', intent === 'removebg' && 'lu-checker')} />
          {mask && (
            <div className="absolute top-2 left-2 t-label text-gray-300 bg-black/50 px-2 py-1 rounded-md">mask painted</div>
          )}
          <button
            onClick={() => { setSource(null); setMask(null) }}
            className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 text-gray-300 hover:text-white"
            title="Remove image"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-4">
          {meta.allowsMask && (
            <Button variant="secondary" icon={Wand2} onClick={onOpenMaskEditor}>{mask ? 'Edit mask' : 'Paint mask'}</Button>
          )}
          <ChangeImageButton onChange={(r) => setSource(r)} />
        </div>
        <p className="t-body text-gray-600 mt-3 text-center max-w-sm">
          {meta.id === 'removebg' ? 'Hit Create to cut out the subject and export a transparent PNG.'
            : meta.id === 'upscale' ? 'Hit Create to upscale the image.'
            : meta.id === 'eraser' ? 'Paint a mask over the object to remove, then hit Create.'
            : meta.allowsMask ? 'Leave the mask empty to restyle the whole image, or paint an area to change just that. Write your prompt below, then Create.'
            : 'Describe the motion below, then Create.'}
        </p>
      </div>
    </div>
  )
}

function ChangeImageButton({ onChange }: { onChange: (r: Awaited<ReturnType<typeof loadImageRef>>) => void }) {
  const setError = useCreateStore((s) => s.setError)
  const inputRef = useRef<HTMLInputElement>(null)
  // Same validation + error surface as the drop zone — this picker used to
  // hand the raw file straight to loadImageRef, so a .heic/.avif previewed
  // fine and then 415ed at submit (and a decode failure rejected unhandled).
  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('That file type is not supported. Use PNG, JPG or WebP.')
      return
    }
    setError(null)
    try {
      onChange(await loadImageRef(file))
    } catch (err) {
      setError(`Could not load the image: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return (
    <>
      <Button variant="ghost" icon={ImagePlus} onClick={() => inputRef.current?.click()}>Change image</Button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }} />
    </>
  )
}

// ── Shared install-card chrome: spinner + streamed status + dismissible error ──
// The Cancel button is not optional chrome. David 2026-07-25 clicked Download &
// install on Motion Control, got a spinner, and had no way to stop or even see
// a 10.5 GB transfer. Cancel here aborts the install loop and kills the running
// download in Rust; the partial file stays, so a later run resumes.
function InstallCardBody({ run, installing, status, err, onDismiss, onCancel, cancelTitle }: {
  run: () => void; installing: boolean; status: string; err: string | null
  onDismiss: () => void; onCancel: () => void
  /** What Cancel actually does here. The MLX installer on macOS runs in Rust
   *  and outlives this view, so its Cancel stops watching, not downloading —
   *  claiming otherwise would be a lie the next screen exposes. */
  cancelTitle?: string
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 pt-1">
      {installing ? (
        <div className="flex flex-col items-center gap-1.5">
          <div className="t-control text-gray-400 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin shrink-0" />
            <span>{status || 'Installing…'}</span>
          </div>
          <button
            onClick={onCancel}
            title={cancelTitle ?? 'Stops the setup. A download in flight is dropped, finished files stay.'}
            className="t-control text-gray-500 hover:text-gray-300 underline underline-offset-2 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <Button variant="primary" icon={Download} onClick={run}>Download &amp; install</Button>
      )}
      {err && (
        <div className="relative t-control text-gray-300 bg-white/[0.03] rounded-[var(--radius-control)] px-2.5 py-2 pr-7 max-w-sm text-left">
          <div className="flex items-start gap-2">
            <AlertTriangle size={13} className="text-gray-400 shrink-0 mt-px" />
            <span className="min-w-0 break-words">{err}</span>
          </div>
          <button onClick={onDismiss} className="absolute top-1.5 right-1.5 text-gray-500 hover:text-gray-300 transition-colors" title="Dismiss" aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Capability missing → one-click install right here ──
const CAP_COPY = {
  rmbg: {
    icon: Scissors,
    title: 'Background removal needs a one-time download',
    description: 'The AI cutout runs fully locally (ComfyUI-RMBG). This installs the node now. The ~300 MB cutout model downloads automatically on your first cutout.',
  },
  'inpaint-nodes': {
    icon: Wand2,
    title: 'Image editing needs ComfyUI up and running',
    description: 'Local Edit repaints the masked area with ComfyUI’s built-in inpaint nodes. This starts ComfyUI (installing it first if needed) and verifies the nodes.',
  },
  dwpose: {
    icon: Film,
    title: 'Motion control needs the pose extractor',
    description: 'DWPose reads the skeleton out of your driving video so the character can copy it. This installs the controlnet aux node pack; the pose models download automatically on your first run.',
  },
} as const

/** While an install runs, the card must not keep saying "needs a one-time
 *  download" with a bare spinner under it, which is what made David ask whether
 *  anything was happening at all. Title and description both switch. */
const BUSY_DESCRIPTION = {
  capability: 'This installs a small node pack and restarts ComfyUI. Cancel any time.',
  // Cancel really does throw the partial file away (cancel_download deletes the
  // .download temp), so the copy says that rather than the friendlier thing.
  // A connection that DROPS is the opposite case: that partial survives and the
  // next try resumes from it, which is what the retry line promises.
  bundle: 'Follow it in the Downloads tray up top. You can cancel any time, which stops the download and drops what it had so far.',
  // The MLX installer runs inside Rust and keeps going without this view, so
  // this line must not promise the Downloads tray or a real cancel.
  macBundle: 'This runs in the background and survives leaving this tab. Settings → AI Backends → Local Media shows the same progress.',
} as const

function CapabilityCard({ cap }: { cap: 'rmbg' | 'inpaint-nodes' | 'dwpose' }) {
  const { installCapability } = useCreateExp()
  const [installing, setInstalling] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const copy = CAP_COPY[cap]

  const run = async () => {
    const ac = new AbortController()
    abortRef.current = ac
    setInstalling(true); setErr(null); setStatus('Starting…')
    try {
      // On success the capability flips true and Stage swaps this card for the input slot.
      await installCapability(cap, setStatus, ac.signal)
    } catch (e) {
      // A cancel is a decision, not a failure: say so plainly and add the one
      // thing that is not obvious, that the node install itself finishes in the
      // background because there is nothing to roll back.
      setErr(e instanceof InstallCancelled
        ? 'Cancelled. Any node install already running finishes on its own in the background.'
        : e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
      abortRef.current = null
    }
  }

  return (
    <EmptyState
      icon={copy.icon}
      tone="accent"
      title={installing ? 'Setting this up for you' : copy.title}
      description={installing ? BUSY_DESCRIPTION.capability : copy.description}
    >
      <InstallCardBody
        run={run} installing={installing} status={status} err={err}
        onDismiss={() => setErr(null)}
        onCancel={() => abortRef.current?.abort()}
      />
    </EmptyState>
  )
}

// macOS runs local media on Apple MLX, so the Mac card must not promise a
// ComfyUI download or quote VRAM figures — unified memory is the constraint
// there, and the sizes are the MLX catalog's, not ComfyUI's.
const MAC_BUNDLE_COPY = {
  image: {
    icon: ImageIcon,
    title: 'Local image generation needs a one-time setup',
    description: 'This sets up Apple MLX on this Mac and downloads the smallest image model to start with. More models — including unfiltered ones — are in Settings → AI Backends → Local Media.',
  },
  video: {
    icon: Film,
    title: 'Local video generation needs a one-time setup',
    description: 'This sets up Apple MLX video on this Mac and downloads the smallest video model. Video renders take minutes per clip, not seconds.',
  },
} as const

// ── Local model files missing → one-click starter bundle (fresh-PC path) ──
const BUNDLE_COPY = {
  image: {
    icon: ImageIcon,
    title: 'Local image generation needs a one-time download',
    description: 'This sets up everything for a fully local run: ComfyUI itself if it’s missing, plus the Juggernaut XL starter checkpoint (~6.5 GB). That same model also powers the local Edit tab.',
  },
  video: {
    icon: Film,
    title: 'Local video generation needs a one-time download',
    // Filled in per lane below: Animate and Extend need an image-to-video
    // model and get a different bundle than the plain Video tab, so a fixed
    // sentence here named a download the user was not going to get.
    description: 'This sets up everything for a fully local run: ComfyUI itself if it’s missing, plus the starter model files.',
  },
  audio: {
    icon: ImageIcon,
    title: 'Local music needs a one-time download',
    description: 'This sets up everything for fully local music: ComfyUI itself if it’s missing, plus the ACE Step 1.5 music model (~9.3 GB, runs from 6 GB VRAM). Local music is never filtered.',
  },
  lipsync: {
    icon: Film,
    title: 'Local talking characters need a one-time download',
    description: 'This sets up the Wan 2.2 S2V model plus its audio encoder (~20 GB total). Comfortable on 12 GB VRAM; smaller cards offload and render slower.',
  },
  motion: {
    icon: Film,
    title: 'Local motion control needs a one-time download',
    description: 'This sets up the Wan VACE motion model plus its support files (~10.5 GB, runs from 8 GB VRAM). The bigger Wan Animate variant is in the Model Manager.',
  },
} as const

/** What the video card promises has to be the bundle the button installs.
 *  Same pick as the installer, so the two cannot drift apart again. */
function videoBundleLine(intent: string): string {
  const b = bundleForVideoIntent(getVideoBundles(), intent)
  if (!b) return ''
  // Bundle names carry their own parenthetical ("Wan 2.2 · TI2V 5B (Image +
  // Text to Video)"), and two brackets in a row read as a typo.
  const name = b.name.replace(/\s*\([^)]*\)\s*$/, '')
  return ` The lane needs ${intent === 'animate' || intent === 'extend' ? 'an image-to-video' : 'a text-to-video'} model, so this installs ${name} (~${b.totalSizeGB} GB, ${b.vramRequired} VRAM).`
}

function ModelInstallCard({ kind }: { kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion' }) {
  const { installModelBundle } = useCreateExp()
  const intent = useCreateStore((s) => s.intent())
  // The run outlives this card on purpose. Stage swaps the card away as soon as
  // a render starts or the lane list refills, and a 12 GB install must not lose
  // its status line, its Cancel button and its error message to that.
  const runState = useSyncExternalStore(subscribeInstallRuns, () => getInstallRun(kind))
  const { status, err, running: installing } = runState
  const mac = isMlxImageHost()
  const copy = (mac && (kind === 'image' || kind === 'video')) ? MAC_BUNDLE_COPY[kind] : BUNDLE_COPY[kind]
  // The Mac lane runs its own MLX stack and has no ComfyUI bundle to name.
  const description = (kind === 'video' && !mac)
    ? copy.description + videoBundleLine(intent)
    : copy.description

  const run = () => startInstallRun(kind, (onStatus, signal) =>
    installModelBundle(kind, onStatus, signal).catch((e: unknown) => {
      throw e instanceof InstallCancelled
        ? new Error('Cancelled. Files that finished are kept, the one in flight was dropped.')
        : e
    }))

  return (
    <EmptyState
      icon={copy.icon}
      tone="accent"
      title={installing ? 'Setting this up for you' : copy.title}
      description={installing ? (mac ? BUSY_DESCRIPTION.macBundle : BUSY_DESCRIPTION.bundle) : description}
    >
      <InstallCardBody
        run={run} installing={installing} status={status} err={err}
        onDismiss={() => clearInstallRun(kind)}
        onCancel={() => cancelInstallRun(kind)}
        cancelTitle={mac ? 'Stops showing progress here. The download itself keeps running — pick it up in Settings → AI Backends → Local Media.' : undefined}
      />
    </EmptyState>
  )
}

// ── Character-Studio training board (2.5.8): the 4-30 photo set. Trigger word
// and the Create (train) button live in the composer; this is the visual home
// of the image set with add/remove + drag&drop. ──
function TrainSetBoard() {
  const trainImages = useCreateStore((s) => s.trainImages)
  const addTrainImages = useCreateStore((s) => s.addTrainImages)
  const removeTrainImage = useCreateStore((s) => s.removeTrainImage)
  const backend = useCreateStore((s) => s.backend)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = (files: FileList | File[]) => {
    const imgs = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({ name: f.name, url: URL.createObjectURL(f), blob: f as Blob }))
    if (imgs.length > 0) addTrainImages(imgs)
  }

  return (
    <div
      className="flex-1 min-h-0 flex flex-col p-4 gap-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
      />
      {trainImages.length === 0 ? (
        <button
          onClick={() => inputRef.current?.click()}
          className="flex-1 rounded-xl border-2 border-dashed border-white/10 hover:border-white/25 transition-colors flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-gray-300"
        >
          <UploadCloud size={28} />
          <div className="t-body">Drop 4 to 30 photos of your character here</div>
          <div className="t-label text-gray-600">
            One person or character, varied angles and lighting works best
          </div>
        </button>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {trainImages.map((img) => (
                <div key={img.name} className="relative group aspect-square rounded-lg overflow-hidden bg-white/[0.03] border border-white/[0.06]">
                  <img src={img.url} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeTrainImage(img.name)}
                    className="absolute top-1 right-1 p-1 rounded-md bg-black/60 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-white transition-opacity"
                    title="Remove"
                    aria-label="Remove"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => inputRef.current?.click()}
                className="aspect-square rounded-lg border-2 border-dashed border-white/10 hover:border-white/25 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-colors"
                title="Add photos"
                aria-label="Add photos"
              >
                <ImagePlus size={18} />
              </button>
            </div>
          </div>
          <div className="t-label text-gray-500 text-center shrink-0">
            {trainImages.length}/30 photos. {backend === 'cloud'
              ? 'Training runs in the cloud and lands the character on your shelf.'
              : 'Training runs on your GPU and lands the character in your local LoRAs.'}
          </div>
        </>
      )}
    </div>
  )
}
