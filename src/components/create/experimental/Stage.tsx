import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { motion, AnimatePresence, useIsPresent } from 'framer-motion'
import { UploadCloud, ImagePlus, Scissors, Wand2, Sparkles, X, Loader2, Download, AlertTriangle, Image as ImageIcon, Film, Maximize2 } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useModelStore } from '../../../stores/modelStore'
import { createRunModel } from '../../../lib/render/create-studio'
import { musicText } from '../../../lib/render/music-ui'
import { useCreateExp } from './CreateContext'
import { INTENT_MAP } from './intents'
import { editNeedsMask, defaultCloudModel, modelForOp } from '../../../stores/cloudCatalogStore'
import { stageShowsSetupCard, laneModelCount } from './stageGate'
import { needsMaskFor } from './maskGate'
import { GeneratingView, ResultView } from './OutputView'
import { EmptyState } from '../ui/EmptyState'
import { MONOGRAM, MONOGRAM_INVERT } from '../../layout/brand'
import { ICON_STROKE_MARK } from '../../ui/icon-size'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { loadImageRef } from './loadImage'
import { mediaRefFrom } from './mediaRef'
import {
  subscribeInstallRuns, getInstallRun, startInstallRun, cancelInstallRun, clearInstallRun,
} from '../../../lib/model-install-runs'
import { GALLERY_DRAG_TYPE, galleryItemUrl, fetchGalleryItemBlob, recoverGalleryUrl } from './galleryUrl'
import { InstallCancelled } from '../../../lib/bundle-install'
import { isMlxImageHost } from '../../../api/mlx-image'
import { bundleForVideoIntent } from '../../../api/comfyui'
import { getVideoBundles } from '../../../api/discover'
import { lipsyncFitLine } from './lipsyncFit'
import { useGraphicsCardGb } from '../../../hooks/useGraphicsMemory'
import { ReferenceStrip } from './ReferenceStrip'
import { FitStage, FIT_SIDE_FROM } from './FitStage'
import { BatchStrip, UseOriginalButton, useBatchPickers } from './BatchStrip'
import { addBatchFiles, useBatchOffered, useBatchOriginalOffer } from './batchRun'
import { filesFromDrop } from './batchFiles'
import { DEFAULT_CUTOUT_MODEL_SIZE } from '../../../api/cutout-model'
import { useReferenceSlots } from './referenceSlots'
import { SavedCharacterChips } from './SavedCharacters'
import { loadPhotosAsReferences, sendPhotosToStudio } from './characterPhotos'
import { MIN_TRAIN_IMAGES, maxTrainImages } from '../../../lib/train-image-cap'
import { TRAIN_CAPTION_HELP, TRAIN_CAPTION_MAX, TRAIN_CAPTION_PLACEHOLDER } from '../../../lib/train-captions'
import { describeAvailability, describeTrainPhoto, type DescribeAvailability } from '../../../lib/render/describe-train-photos'
import { MAC_IMAGE_SETUP_SIZE, macVideoSetupCopy } from '../../../lib/mac-setup-sizes'
import { macVideoSetupPlan, type MacVideoSetupPlan } from '../../../api/mlx-starter'
import { HowItWorks } from '../../ui/HowItWorks'
import { stageHowtoTopic } from '../../../lib/howto'

interface Props {
  displayed?: GalleryItem
  onOpenMaskEditor: () => void
  /** Adopt a finished result as the edit source, THEN open the mask editor —
   *  a t2i run leaves `source` empty, and the editor always reads `source`.
   *  Absent where the Edit intent has no working local lane (the MLX Mac),
   *  so the button only shows where inpainting actually runs. */
  onEditResult?: (item: GalleryItem) => void
  /** C1: adopt a finished image as the Animate intent's source. Absent where
   *  the Animate lane has no working local pipeline (MLX Mac), same reasoning
   *  as onEditResult above. */
  onAnimateResult?: (item: GalleryItem) => void
  onFullscreen: (item: GalleryItem) => void
  /** The large view with the prompt unfolded (the Prompt word in the facts). */
  onShowPrompt?: (item: GalleryItem) => void
  /** Pick frames of a finished video and save them as a character. */
  onSaveCharacter?: (item: GalleryItem) => void
  /** ComfyUI is coming up: no setup card in that window (./stageGate). */
  comfyStarting?: boolean
}

export function Stage({ displayed, onOpenMaskEditor, onEditResult, onAnimateResult, onFullscreen, onShowPrompt, onSaveCharacter, comfyStarting }: Props) {
  const intent = useCreateStore((s) => s.intent())
  const meta = INTENT_MAP[intent]
  // The width of the stage, for the how-to line at its foot (footLine below).
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStageWidth((was) => (was === el.clientWidth ? was : el.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  // A batch over several source images is one stretch of work: between two of
  // its images nothing is rendering, and the Stage must not flash back.
  const isGenerating = useCreateStore((s) => s.isGenerating || s.batchRun !== null)
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
  const upscaleModelList = useCreateStore((s) => s.upscaleModelList)
  const { connected, modelsLoaded, mlxMissing } = useCreateExp()
  // On the cloud backend the utility ops (background removal, …) run on
  // the render service's hosted endpoints — there's no local ComfyUI node to install,
  // so the capability is always ready. Only the local backend gates on the
  // node probe (which never runs without a local ComfyUI and would strand
  // cloud users on a dead "Open Model Manager" card).
  // A capability is a set of ComfyUI nodes. The Mac's local lanes run on MLX
  // and need none: its Edit is Qwen-Image 2.1 on the second image engine.
  const capReady = !meta.capability || backend === 'cloud' || !!caps[meta.capability] || isMlxImageHost()
  // Local model files missing for this intent (fresh PC): gate the stage on a
  // one-click starter-bundle card. connected === false also gates — the same
  // button installs ComfyUI itself first. connected === null (still probing)
  // gates nothing, so the card never flashes during startup.
  //
  // macOS answers this from MLX, not from ComfyUI: `connected` is deliberately
  // pinned to null there (there is nothing to connect to), so the rule would
  // never fire and a Mac with no model installed got an empty stage and no way
  // to fix it — the setup lived in Settings, where nothing pointed.
  //
  // Die Regel selbst steht in ./stageGate, weil die Kopfzeile in
  // CreateExperimental dieselbe Antwort braucht: sie haelt ihren roten Balken
  // zurueck, solange diese Karte die Lage schon erklaert.
  const modelsMissing = stageShowsSetupCard({
    backend,
    requiresModels: meta.requiresModels,
    mlxMissing,
    connected,
    comfyStarting,
    modelsLoaded,
    laneModelCount: laneModelCount(intent, meta.requiresModels, {
      image: imageModelList, video: videoModelList, audio: audioModelList,
      lipsync: lipsyncModelList, motion: motionModelList, upscale: upscaleModelList,
    }),
  })

  // A result counts for the current source only if it was generated after the
  // source was loaded — otherwise an older gallery item would hijack the stage.
  const freshResult = displayed && displayed.createdAt >= sourceSetAt

  const characterTab = useCreateStore((s) => s.characterTab)
  const characterTrain = intent === 'character' && characterTab === 'train'
  // The example chips of Music are style descriptions. Where the prompt of a
  // cloud model is the lyrics, a chip would be sung word for word, so that
  // model shows none. Local music keeps them: its prompt is always the style.
  const musicIsLyrics = useCreateStore((s) =>
    s.backend === 'cloud' && musicText(createRunModel('music', { image: '', video: '', op: s.cloudOpModel })).main === 'lyrics')
  const examples = intent === 'music' && musicIsLyrics ? [] : meta.examples

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
  // The empty stage carries the how-to line under its examples. A stage that
  // waits for a file or shows the source has no such place, so the line stands
  // at its foot.
  let howtoAtFoot = false
  // A source on a narrow stage has its controls under the picture, and the
  // picture already gives up all the height it can (FitStage). The line at
  // the foot would take 28 px more and make that stage scroll, so it stands
  // there only where the controls sit beside the picture.
  let howtoOnlyWide = false
  const howtoTopic = stageHowtoTopic(intent, backend, isMlxImageHost())
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
    howtoAtFoot = true
  } else if (meta.needsSource && !source) {
    body = <InputSlot />
    howtoAtFoot = true
  } else if (meta.needsSource && source && !freshResult) {
    body = <SourcePreview onOpenMaskEditor={onOpenMaskEditor} />
    howtoAtFoot = true
    howtoOnlyWide = true
  } else if (displayed) {
    body = (
      <ResultView
        item={displayed}
        onFullscreen={() => onFullscreen(displayed)}
        onShowPrompt={onShowPrompt ? () => onShowPrompt(displayed) : undefined}
        onSendToEditor={displayed.type === 'image' && onEditResult ? () => onEditResult(displayed) : undefined}
        onAnimate={displayed.type === 'image' && onAnimateResult ? () => onAnimateResult(displayed) : undefined}
        onSaveCharacter={displayed.type === 'video' && onSaveCharacter ? () => onSaveCharacter(displayed) : undefined}
        // The source and its references stay on screen beside the result
        // (FitStage), so the next run shows what it starts from.
        side={meta.needsSource && source ? <ResultInputs /> : undefined}
      />
    )
  } else {
    // D-A9/D-W3-7, die zwoelfte Einbindung: hier stand die 512x512-Bitmap des
    // Monogramms unter ihrem zweiten Dateinamen (die `-white`-Fassung ist
    // byteidentisch mit der `-bw`-Fassung, derselbe MD5), gezeigt auf 56px.
    // Sie stand in KEINER der beiden Audit-Listen und ist auch durch die Wache
    // von `b3f0f786` gefallen, weil die nach EINEM Namen gesucht hat statt
    // nach dem Muster. `kein-raster-als-hauszeichen.test.ts` sucht das Muster.
    //
    // `logoClassName` ist neu und kein Beiwerk: `create/` ist dunkel-zuerst
    // portiert und sitzt in `<main>` auf `bg-white dark:bg-[#1e1e1e]`. Das
    // Zeichen ist weiss gezeichnet und stand im Hellmodus unsichtbar auf
    // Weiss — den Text daneben faengt `index.css:863-868` ab, das Bild nicht.
    body = (
      <EmptyState icon={Sparkles} logoSrc={MONOGRAM} logoClassName={MONOGRAM_INVERT} title={teachTitle(intent)}>
        {examples.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5 pt-1">
            {examples.map((ex) => (
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
        {/* How it works: the cloud tabs only, the films show the cloud. */}
        {howtoTopic && (
          <div className="pt-1">
            <HowItWorks topic={howtoTopic} variant="line" />
          </div>
        )}
      </EmptyState>
    )
  }

  const footLine = howtoAtFoot && !!howtoTopic && !(howtoOnlyWide && stageWidth !== null && stageWidth < FIT_SIDE_FROM)

  return (
    // The viewer canvas: ONE fixed, centred frame that is identical on every tab
    // (Image / Edit / Cutout / Video) — same height and width — so switching
    // modes no longer resizes or shifts the stage. It shares the Gallery bubble's
    // surface + radius so the two read as a matched pair, and it sits in the same
    // row as the Gallery (see CreateExperimental) so both are always equal height.
    // Whatever the mode renders (empty state, dropzone, result, install card) is
    // centred inside this frame.
    <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden p-2">
      <div ref={stageRef} data-testid="create-stage" className="flex-1 min-w-0 rounded-xl bg-gray-50 dark:bg-[#1e1e1e] ring-1 ring-black/[0.04] dark:ring-white/[0.05] flex flex-col overflow-hidden relative">
        <AnimatePresence mode="wait">
          <StageLayer key={intent + (isGenerating ? ':gen' : '')} footRoom={footLine}>{body}</StageLayer>
        </AnimatePresence>
        {footLine && howtoTopic && (
          <div className="absolute bottom-2 inset-x-0 flex justify-center pointer-events-none">
            <div className="pointer-events-auto"><HowItWorks topic={howtoTopic} variant="line" /></div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One face of the stage, fading in and out.
 *
 * While a lane fades out, AnimatePresence keeps the card that is leaving as
 * it was last drawn, buttons and their handlers included. A click in those
 * 120 ms landed on it: Image chosen and "Download & install" pressed at once
 * started the VIDEO setup (persona walk of the Mac app, 09.10.2026, Fund 28).
 * A face that is leaving takes no click and no key any more. Nothing about
 * what is drawn changes, so this holds for every host.
 */
export function StageLayer({ children, footRoom = false }: { children: ReactNode; footRoom?: boolean }) {
  const present = useIsPresent()
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      // footRoom: the how-to line sits at the stage's foot, so the face ends above it.
      className={cn('flex-1 min-h-0 flex flex-col', footRoom && 'pb-7', !present && 'pointer-events-none')}
      inert={!present}
      data-stage-layer={present ? 'present' : 'leaving'}
    >
      {children}
    </motion.div>
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
  // Edit, Remove Background and Enhance Image take several images at once
  // where no mask is needed (lib/batch-edit).
  const batchOffered = useBatchOffered()
  // A model that reads several photos of a figure can start from a saved
  // character (lib/saved-characters) instead of a file.
  const referenceSlots = useReferenceSlots()

  // 2026-07-10: ops never auto-adopt a gallery image — instead the slot
  // offers the recent gallery images as an EXPLICIT pick, next to drag&drop
  // and the file picker ("aus Galerie ODER vom Desktop").
  const galleryImages = gallery.filter((g) => g.type === 'image' && !g.unavailable).slice(0, 8)
  // The image a list was made from is not in the gallery, and a batch can push
  // every older result out of the strip. It stays pinned at the front.
  const original = useBatchOriginalOffer()

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

  // More than one file: the list. One file: the plain single source.
  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return
    if (!batchOffered || files.length === 1) return handleFile(files[0])
    setLoading(true)
    try { await addBatchFiles(files) } finally { setLoading(false) }
  }
  const { inputs: batchInputs, pickFiles, pickFolder } = useBatchPickers((files) => { void handleFiles(files) })

  return (
    // Scroll-safe centering: `m-auto` centres the column when there's room and
    // collapses to a scroll when the dropzone + gallery strip exceed a short
    // window (e.g. a 1366×768 laptop) — previously the parent's overflow-hidden
    // clipped the "or pick from your gallery" strip.
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col">
      <div className="m-auto w-full max-w-sm flex flex-col items-center p-6">
        <div
          onClick={() => (batchOffered ? pickFiles() : inputRef.current?.click())}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            if (e.dataTransfer.files.length) { void filesFromDrop(e.dataTransfer).then(handleFiles); return }
            const item = gallery.find((g) => g.id === e.dataTransfer.getData(GALLERY_DRAG_TYPE))
            if (item && !loading) void adoptFromGallery(item)
          }}
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
            <div className="t-title text-gray-300">{meta.id === 'removebg' ? 'Drop an image to cut out' : meta.id === 'animate' ? 'Drop an image to animate' : meta.id === 'upscale' ? 'Drop an image to enhance' : 'Drop an image to edit'}</div>
            <div className="t-body text-gray-600">or click to browse · PNG, JPG, WebP</div>
            {batchOffered && <div className="t-body text-gray-600">Pick several to give them all the same run</div>}
          </div>
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
        </div>
        {batchOffered && (
          <>
            {batchInputs}
            <button
              onClick={pickFolder}
              disabled={loading}
              className="mt-2 t-control text-gray-500 hover:text-gray-300 underline underline-offset-2 transition-colors"
            >
              or choose a folder of images
            </button>
          </>
        )}
        {referenceSlots > 0 && (
          <div className="mt-4 w-full">
            <SavedCharacterChips
              label="or start from a saved character"
              disabled={loading}
              title={(c) => `Load the photos of ${c.name}`}
              onPick={(c) => {
                setLoading(true)
                setError(null)
                void loadPhotosAsReferences(c.name, c.photos)
                  .catch((err: unknown) => setError(`Could not load the photos: ${err instanceof Error ? err.message : String(err)}`))
                  .finally(() => setLoading(false))
              }}
            />
          </div>
        )}
        {(galleryImages.length > 0 || original) && (
          <div className="mt-4 w-full">
            <div className="t-label text-gray-600 mb-2 text-center">{galleryImages.length > 0 ? 'or pick from your gallery' : 'or pick the original again'}</div>
            <div className="flex justify-center gap-1.5 overflow-x-auto pb-1">
              {original && (
                <button
                  onClick={() => { if (!loading) setSource(original) }}
                  className="relative shrink-0 w-12 h-12 rounded-md overflow-hidden border border-lu-accent/60 hover:border-lu-accent transition-colors"
                  title={`Use ${original.name || 'the original image'} again`}
                  aria-label="Use the original image as the source"
                  data-testid="pick-original"
                >
                  <img src={original.url} alt="" className="w-full h-full object-cover" />
                  <span className="absolute bottom-0 inset-x-0 t-micro text-gray-100 bg-black/60 text-center">Original</span>
                </button>
              )}
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
  const backend = useCreateStore((s) => s.backend)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  // A cloud instruction editor (qwen-image-edit, every studio editor) takes no
  // mask: same model and same rule as the Create button in the Composer.
  // The Mac's local Edit is Qwen-Image 2.1 on the second image engine, which
  // takes a painted mask over the first image (mflux 0.22.0 `--mask-image`):
  // the prompt repaints the white, the rest stays as it was.
  const noMask = intent === 'edit' && backend === 'cloud'
    && !editNeedsMask(modelForOp('image', 'edit', cloudImageModel || defaultCloudModel('image')?.id || ''))
  const batchCount = useCreateStore((s) => s.batchSources.length)
  const batchOffered = useBatchOffered()
  // The same run over several images: no mask (it belongs to one image), and
  // the list below replaces "Change image".
  const batchOn = batchOffered && batchCount > 1

  // Zombie render: an intent switch drops the source in the same store update
  // that swaps this component out, but the child subscription can fire first.
  if (!source) return null

  const onDragOver: React.DragEventHandler<HTMLDivElement> = (e) => { if (batchOffered && e.dataTransfer.types.includes('Files')) e.preventDefault() }
  const onDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
    if (!batchOffered || !e.dataTransfer.files.length) return
    e.preventDefault()
    void filesFromDrop(e.dataTransfer).then(addBatchFiles)
  }
  // The picture. `maxHeight` is the height the stage has left for it
  // (FitStage); until the stage is measured it keeps a share of the window.
  const picture = (maxHeight?: string) => (
        <div className="relative">
          <img
            src={source.url}
            alt="source"
            className={cn(!maxHeight && 'max-h-[52vh]', 'max-w-full object-contain rounded-[var(--radius-panel)] border border-white/[0.06]', intent === 'removebg' && 'lu-checker')}
            style={maxHeight ? { maxHeight } : undefined}
          />
          {mask && !noMask && (
            <div className="lu-on-dark absolute top-2 left-2 t-label text-gray-300 bg-black/50 px-2 py-1 rounded-md">mask painted</div>
          )}
          <button
            onClick={() => { setSource(null); setMask(null) }}
            className="lu-on-dark absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 text-gray-300 hover:text-white"
            title="Remove image"
          >
            <X size={14} />
          </button>
        </div>
  )
  const controls = (
      <>
        <ReferenceStrip />
        {!batchOn && (
          <div className="flex items-center gap-2 mt-4">
            {meta.allowsMask && !noMask && (
              <Button variant="secondary" icon={Wand2} onClick={onOpenMaskEditor}>{mask ? 'Edit mask' : 'Paint mask'}</Button>
            )}
            <ChangeImageButton onChange={(r) => setSource(r)} />
            <UseOriginalButton />
          </div>
        )}
        <BatchStrip />
        <p className="t-body text-gray-600 mt-3 text-center max-w-sm">
          {batchOn ? (
            meta.id === 'removebg' ? `Hit Create to cut out all ${batchCount} images.`
              : meta.id === 'upscale' ? `Hit Create to upscale all ${batchCount} images.`
              : `Write your prompt below, then Create. All ${batchCount} images get the same edit.`
          ) : meta.id === 'removebg' ? 'Hit Create to cut out the subject and export a transparent PNG.'
            : meta.id === 'upscale' ? 'Hit Create to upscale the image.'
            : meta.id === 'eraser' ? (mask ? 'Mask ready. Hit Create.' : 'Paint a mask over the object to remove, then hit Create.')
            : noMask ? 'Write the edit prompt below, then Create. This model needs no mask.'
            // A cloud model that edits through a mask does not start without
            // one (maskGate.ts), so the line about an empty mask is local only.
            : needsMaskFor(intent, backend, false) ? 'Paint the area to change, write your prompt below, then Create.'
            // The Mac's Edit does not restyle at a denoise as the Windows
            // graph does: without a mask the prompt edits the whole image.
            : meta.id === 'edit' && backend === 'local' && isMlxImageHost()
              ? 'Paint an area to change just that, or leave the mask empty to edit the whole image. Write your prompt below, then Create.'
            : meta.allowsMask ? 'Leave the mask empty to restyle the whole image, or paint an area to change just that. Write your prompt below, then Create.'
            : 'Describe the motion below, then Create.'}
        </p>
      </>
  )

  // The picture takes the height the stage has left, and the reference
  // strip, "Change image" and the hint are on screen with it. In a
  // 1440 × 900 window they lay below the fold (persona walk, Fund 14).
  return <FitStage picture={picture} side={controls} capVh={52} onDragOver={onDragOver} onDrop={onDrop} />
}

/**
 * Beside a finished result on a tool that works from a source image: what the
 * next run starts from, and the way to the next image. After the first edit
 * the source and the references were gone from the screen: whoever wanted
 * "one image first, then with a reference" found no place for the reference,
 * and nothing said whether the source still counted (persona walk,
 * 09.10.2026, Fund 15). It does: Create runs on the same source again.
 *
 * "Change image" puts a new image on the Stage (the box, 04.10.2026: after a
 * cutout the only way to load another image was to leave the tool and come
 * back); the list under it adds more for one run over all of them.
 */
function ResultInputs() {
  const source = useCreateStore((s) => s.source)
  const setSource = useCreateStore((s) => s.setSource)
  const intent = useCreateStore((s) => s.intent())
  const batchCount = useCreateStore((s) => s.batchSources.length)
  const batchOn = useBatchOffered() && batchCount > 1
  if (!source) return null
  return (
    <div className="flex flex-col items-center mt-3" data-testid="result-source-actions">
      <div className="flex items-center gap-3">
        <img
          src={source.url}
          alt="source"
          className="w-16 h-16 shrink-0 rounded-lg object-cover border border-white/[0.06]"
        />
        <div className="flex flex-col items-start gap-1">
          <p className="t-body text-gray-500 max-w-[12rem]">
            {intent === 'edit' ? 'Create edits this image again.'
              : intent === 'animate' ? 'Create animates this image again.'
              : 'Create runs on this image again.'}
          </p>
          {!batchOn && <ChangeImageButton onChange={(r) => setSource(r)} />}
          {!batchOn && <UseOriginalButton />}
        </div>
      </div>
      <ReferenceStrip />
      <BatchStrip />
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
// The Cancel button is not optional chrome. 2026-07-25 clicked Download &
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
    description: `The AI cutout runs fully locally (ComfyUI-RMBG). This installs the node now. The ${DEFAULT_CUTOUT_MODEL_SIZE} cutout model downloads automatically on your first cutout.`,
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
 *  download" with a bare spinner under it, which is what made the owner ask whether
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
  // Per lane: the video setup said "under Image" as well, and sent the user
  // to a rail where nothing was moving (persona walk, 09.10.2026).
  macBundle: {
    image: 'This runs in the background and survives leaving this tab. The Model Manager shows the same progress, under Image.',
    video: 'This runs in the background and survives leaving this tab. The Model Manager shows the same progress, under Video.',
    motion: 'This runs in the background and survives leaving this tab.',
  },
} as const

/** Where the Mac's Cancel sends the user to follow a setup it does not stop. */
const MAC_CANCEL_TITLE = {
  image: 'Stops showing progress here. The download itself keeps running. Follow it in Models, under Image.',
  video: 'Stops showing progress here. The download itself keeps running. Follow it in Models, under Video.',
  motion: 'Stops showing progress here. The download itself keeps running.',
} as const

function CapabilityCard({ cap }: { cap: 'rmbg' | 'inpaint-nodes' | 'dwpose' }) {
  const { installCapability } = useCreateExp()
  // The run lives outside the card, like a bundle install: a failure must
  // still be readable after a trip to another mode (the box, 03.10.2026: the
  // reason for a failed node pack install was gone on the first mode switch).
  // It stays until the user closes it or tries again.
  const runKey = `capability:${cap}`
  const { status, err, running: installing } = useSyncExternalStore(subscribeInstallRuns, () => getInstallRun(runKey))
  const copy = CAP_COPY[cap]

  // On success the capability flips true and Stage swaps this card for the input slot.
  const run = () => startInstallRun(runKey, (onStatus, signal) =>
    installCapability(cap, onStatus, signal).catch((e: unknown) => {
      // A cancel is a decision, not a failure: say so plainly and add the one
      // thing that is not obvious, that the node install itself finishes in the
      // background because there is nothing to roll back.
      throw e instanceof InstallCancelled
        ? new Error('Cancelled. Any node install already running finishes on its own in the background.')
        : e
    }))

  return (
    <EmptyState
      icon={copy.icon}
      tone="accent"
      title={installing ? 'Setting this up for you' : copy.title}
      description={installing ? BUSY_DESCRIPTION.capability : copy.description}
    >
      <InstallCardBody
        run={run} installing={installing} status={status} err={err}
        onDismiss={() => clearInstallRun(runKey)}
        onCancel={() => cancelInstallRun(runKey)}
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
    // The size is the one Settings and the Model Manager quote for the same
    // setup. A button that starts gigabytes says how many before the click.
    description: `This sets up Apple MLX on this Mac and downloads the smallest image model to start with, ${MAC_IMAGE_SETUP_SIZE} in all. More models, including unfiltered ones, are in Models, under Image.`,
  },
  video: {
    icon: Film,
    title: 'Local video generation needs a one-time setup',
    // Before the catalogue has answered. What the card says after that is
    // `macVideoSetupCopy` (lib/mac-setup-sizes), from the model the setup
    // takes on this Mac.
    description: 'This sets up Apple MLX video on this Mac and downloads a video model to start with. Video renders take minutes per clip, not seconds. More models are in Models, under Video.',
  },
  motion: {
    icon: Film,
    title: 'Local motion control needs a one-time download',
    // The size of the LoRA (commands/video_motion.rs SIZE_BYTES).
    description: 'This downloads Motion Control for LTX-2.3 (about 650 MB). Your LTX-2.3 model then follows the movement of a video, starting from your image.',
  },
} as const

/** The plan of the Mac's video setup, for the card. Null until it is read,
 *  and when it could not be read: the card then says what it always can. */
function useMacVideoSetupPlan(enabled: boolean, installing: boolean): MacVideoSetupPlan | null {
  const [plan, setPlan] = useState<MacVideoSetupPlan | null>(null)
  useEffect(() => {
    if (!enabled || installing) return
    let stale = false
    macVideoSetupPlan().then((p) => { if (!stale) setPlan(p) }).catch(() => { /* the card keeps its plain text */ })
    return () => { stale = true }
  }, [enabled, installing])
  return enabled ? plan : null
}

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
    // What it says about the graphics card is added below from the bundle's
    // own verdict (lipsyncFitLine). The sentence that stood here said
    // "Comfortable on 12 GB VRAM" while the same bundle's card in the Model
    // Manager said "Tight on your 12 GB card".
    description: 'This sets up the Wan 2.2 S2V model plus its audio encoder (~20 GB total).',
  },
  upscale: {
    icon: Maximize2,
    title: 'Local Enhance Image needs a one-time download',
    description: 'This sets up everything for fully local upscaling: ComfyUI itself if it’s missing, plus the Real-ESRGAN x4plus upscale model (~67 MB, runs from 2 GB VRAM).',
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

function ModelInstallCard({ kind }: { kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion' | 'upscale' }) {
  const { installModelBundle } = useCreateExp()
  const intent = useCreateStore((s) => s.intent())
  // The run outlives this card on purpose. Stage swaps the card away as soon as
  // a render starts or the lane list refills, and a 12 GB install must not lose
  // its status line, its Cancel button and its error message to that.
  const runState = useSyncExternalStore(subscribeInstallRuns, () => getInstallRun(kind))
  const { status, err, running: installing } = runState
  const mac = isMlxImageHost()
  // The two lanes a Mac sets up itself. Every other lane is a cloud teaser
  // there and never renders this card.
  // Motion Control too (3.0.8): its LoRA, for the LTX-2.3 pack it runs on.
  const macKind = mac && (kind === 'image' || kind === 'video' || kind === 'motion') ? kind : null
  const copy = macKind ? MAC_BUNDLE_COPY[macKind] : BUNDLE_COPY[kind]
  // The Mac lane runs its own MLX stack and has no ComfyUI bundle to name.
  const cardGb = useGraphicsCardGb()
  // The Mac's video starter is chosen per Mac, so its card is written from
  // the plan of the setup. Null everywhere else.
  const macVideo = macVideoSetupCopy(MAC_BUNDLE_COPY.video, useMacVideoSetupPlan(macKind === 'video', installing))
  const title = macKind === 'video' ? macVideo.title : copy.title
  const description = (kind === 'video' && !mac)
    ? copy.description + videoBundleLine(intent)
    : kind === 'lipsync' ? copy.description + lipsyncFitLine(cardGb)
    : macKind === 'video' ? macVideo.description : copy.description
  // A Mac no video starter runs on: the card says so and offers no download.
  // A run that is already on its way, or left an error, keeps its body.
  const nothingToInstall = macKind === 'video' && !macVideo.canInstall && !installing && !err

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
      title={installing ? 'Setting this up for you' : title}
      description={installing ? (macKind ? BUSY_DESCRIPTION.macBundle[macKind] : BUSY_DESCRIPTION.bundle) : description}
    >
      {!nothingToInstall && (
        <InstallCardBody
          run={run} installing={installing} status={status} err={err}
          onDismiss={() => clearInstallRun(kind)}
          onCancel={() => cancelInstallRun(kind)}
          cancelTitle={macKind ? MAC_CANCEL_TITLE[macKind] : undefined}
        />
      )}
    </EmptyState>
  )
}

// ── Character-Studio training board (2.5.8): the 4-30 photo set. Trigger word
// and the Create (train) button live in the composer; this is the visual home
// of the image set with add/remove + drag&drop. ──
export function TrainSetBoard() {
  const trainImages = useCreateStore((s) => s.trainImages)
  const addTrainImages = useCreateStore((s) => s.addTrainImages)
  const removeTrainImage = useCreateStore((s) => s.removeTrainImage)
  const backend = useCreateStore((s) => s.backend)
  const trainCaptions = useCreateStore((s) => s.trainCaptions)
  const setTrainCaption = useCreateStore((s) => s.setTrainCaption)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const inputRef = useRef<HTMLInputElement>(null)
  // 3.0.8 D28: a description per photo, for the local trainers (musubi on
  // Windows and Linux, mflux on a Mac; both read the photo's .txt caption).
  // The cloud trainer takes photos only, so it shows no field it would not use.
  const captions = backend !== 'cloud'
  const [describe, setDescribe] = useState<DescribeAvailability | null>(null)
  const [describing, setDescribing] = useState<{ done: number; total: number } | null>(null)
  const describeAbort = useRef<AbortController | null>(null)
  const hasPhotos = trainImages.length > 0
  // Asked again when the user picks another chat model.
  const chatModel = useModelStore((s) => s.activeModel)
  useEffect(() => {
    if (!captions || !hasPhotos) return
    let live = true
    describeAvailability().then((a) => { if (live) setDescribe(a) }).catch(() => {})
    return () => { live = false }
  }, [captions, hasPhotos, chatModel])
  useEffect(() => () => describeAbort.current?.abort(), [])

  // Fills only the empty fields: what the user typed is never overwritten.
  const describeAll = async () => {
    const todo = useCreateStore.getState().trainImages.filter((i) => i.blob instanceof Blob && !(useCreateStore.getState().trainCaptions[i.name] ?? '').trim())
    if (todo.length === 0) return
    const own = new AbortController()
    describeAbort.current = own
    setDescribing({ done: 0, total: todo.length })
    for (const [n, img] of todo.entries()) {
      if (own.signal.aborted) break
      const text = await describeTrainPhoto(img.blob as Blob, own.signal)
      if (text && !(useCreateStore.getState().trainCaptions[img.name] ?? '').trim()) setTrainCaption(img.name, text)
      setDescribing({ done: n + 1, total: todo.length })
    }
    describeAbort.current = null
    setDescribing(null)
  }

  const addFiles = (files: FileList | File[]) => {
    // One mint, one release: `mediaRefFrom` is the only place a staged file
    // gets a blob: URL, and `addTrainImages` gives back every ref it does not
    // keep (a re-drop of a photo already in the set, anything past the cap).
    // Two different photos under one name both stay: the store numbers the
    // second one on. This used to be an
    // inline copy of those two lines with nothing on the other end.
    const imgs = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .map(mediaRefFrom)
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
          <div className="t-body">Drop {MIN_TRAIN_IMAGES} to {maxTrainImages(backend)} photos of your character here</div>
          <div className="t-label text-gray-600">
            One person or character, varied angles and lighting works best
          </div>
        </button>
      ) : null}
      <SavedCharacterChips
        label={trainImages.length === 0 ? 'or start from a saved character' : 'Add the photos of a saved character'}
        title={(c) => `Add the ${c.photos.length} photos of ${c.name}`}
        onPick={(c) => sendPhotosToStudio(c.name, c.photos)}
      />
      {trainImages.length === 0 ? null : (
        <>
          {captions && (
            <div className="flex items-start justify-center gap-2 flex-wrap shrink-0" data-testid="train-caption-help">
              <span className="t-label text-gray-500 max-w-[640px] text-center">{TRAIN_CAPTION_HELP}</span>
              {describing ? (
                <button
                  type="button"
                  onClick={() => describeAbort.current?.abort()}
                  className="t-label underline underline-offset-2 text-gray-400 hover:text-gray-200 transition-colors inline-flex items-center gap-1"
                >
                  <Loader2 size={11} className="animate-spin" />
                  Describing {describing.done} of {describing.total}, stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={describeAll}
                  disabled={!describe?.available || isGenerating}
                  title={describe?.hint ?? 'Checking your chat model...'}
                  className="t-label underline underline-offset-2 text-gray-400 hover:text-gray-200 disabled:opacity-50 disabled:no-underline disabled:hover:text-gray-400 transition-colors"
                >
                  Describe photos
                </button>
              )}
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {trainImages.map((img) => (
                <div key={img.name} className="flex flex-col gap-1">
                  <div className="relative group aspect-square rounded-lg overflow-hidden bg-white/[0.03] border border-white/[0.06]">
                    <img src={img.url} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={() => removeTrainImage(img.name)}
                      className="lu-on-dark absolute top-1 right-1 p-1 rounded-md bg-black/60 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-white transition-opacity"
                      title="Remove"
                      aria-label="Remove"
                    >
                      <X size={11} />
                    </button>
                  </div>
                  {captions && (
                    <input
                      value={trainCaptions[img.name] ?? ''}
                      onChange={(e) => setTrainCaption(img.name, e.target.value)}
                      maxLength={TRAIN_CAPTION_MAX}
                      disabled={isGenerating}
                      placeholder={TRAIN_CAPTION_PLACEHOLDER}
                      title={trainCaptions[img.name] || TRAIN_CAPTION_PLACEHOLDER}
                      aria-label={`What changes in ${img.name}`}
                      className="t-label w-full px-1.5 h-6 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/15 disabled:opacity-60"
                    />
                  )}
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
            {trainImages.length}/{maxTrainImages(backend)} photos. {backend === 'cloud'
              ? 'Training runs in the cloud and lands the character on your shelf.'
              // A Mac trains with its own image engine, on Z-Image Turbo, and
              // keeps the character in the Mac's LoRA folder (api/mlx-train).
              : isMlxImageHost()
                ? "Training runs on this Mac and lands the character in the Mac's LoRA folder."
                : 'Training runs on your GPU and lands the character in your local LoRAs.'}
          </div>
        </>
      )}
    </div>
  )
}
