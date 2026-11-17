import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Cloud, Cpu } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useCloudNoticeStore, CLOUD_RETENTION_DAYS, shouldShowRetentionNotice } from '../../../stores/cloudNoticeStore'
import { useComfyNoticeStore } from '../../../stores/comfyNoticeStore'
import { loadComfyCorsSignature, shouldShowCorsNotice } from '../../../lib/comfy-cors-notice'
import { comfyIdleNotice, shouldWatchComfyIdle, IDLE_WATCH_INTERVAL_MS, IDLE_STARTING } from '../../../lib/comfy-idle-watch'
import type { ComfyGuardStatus } from '../../../lib/comfy-restart-guard'
import { anyInstallRunning, subscribeInstallRuns } from '../../../lib/model-install-runs'
import { useComfyInstallStore } from '../../../stores/comfyInstallStore'
import { setRenderSurfaceOpen } from '../../../api/vram-handoff'
import { useWorkflowStore } from '../../../stores/workflowStore'
import { CreateExpProvider, useCreateExp } from './CreateContext'
import { IntentBar } from './IntentBar'
import { Stage } from './Stage'
import { Composer } from './Composer'
import { CharacterHub } from './hub/CharacterHub'
import { isHubIntent } from '../../../lib/create/character-hub'
import { CreatePanel } from './CreatePanel'
import { Lightbox } from './Lightbox'
import { SaveCharacterModal } from './SaveCharacterModal'
import { AdvancedDrawer } from './AdvancedDrawer'
import { WorkflowsModal } from '../WorkflowsModal'
import { Hinweis } from '../../ui/Hinweis'
import { BannerText } from './BannerText'
import { MacVideoMemoryNotice } from './MacVideoMemoryNotice'
import { ThreeDHardwareNotice } from './ThreeDHardwareNotice'
import { CreateCloudOffer } from './CreateCloudOffer'
import { MaskEditor } from './MaskEditor'
import { VhsInstallModal } from './VhsInstallModal'
import { CloudHiddenNotice } from '../../cloud/CloudHiddenNotice'
import { PresetShelf } from './PresetShelf'
import type { CreatePreset } from '../../../lib/render/create-presets'
import { Modal } from '../../ui/Modal'

// `provider-schemas.json` (P1) ist 256 KB. `PresetShelf` haengt schon
// synchron an `studio-contract.ts` (fuer `STUDIO_MODELS` in der
// Einzelmodell-Auswahl der Schiene), zieht das Schema also ohnehin in den
// Hauptbaum. Nur die WERKSTATT selbst, die `SchemaControl`/`AvatarPicker`
// und damit `studioSchema()` fuer jedes einzelne Feld aufruft, laesst sich
// ohne Vertragsaenderung an `PresetShelf`/`studio-contract.ts` (P1/P3, fremde
// Dateien) aus dem ersten Ladevorgang heraushalten: sie oeffnet sich erst auf
// einen Klick, der Import darf also warten.
const PresetWorkshop = lazy(() =>
  import('./PresetWorkshop').then((m) => ({ default: m.PresetWorkshop })),
)
import { INTENT_MAP, intentNeedsSource, isIntentAvailable } from './intents'
import { studioIntentOf, studioPickFor } from '../../../lib/render/create-studio'
import { modelForOp, useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { stageShowsSetupCard, laneModelCount } from './stageGate'
import { isMlxImageHost } from '../../../api/mlx-image'
import { mlxTakesStartImage } from '../../../api/mlx-video'
import { mlxTakesEditImage } from '../../../lib/image-engines'
import { fetchGalleryItemBlob } from './galleryUrl'
import { loadImageRef } from './loadImage'

/** The redesigned Create surface. Mounted by AppShell for currentView==='create'. */
export function CreateExperimental() {
  return (
    <CreateExpProvider>
      <CreateExperimentalInner />
    </CreateExpProvider>
  )
}

function CreateExperimentalInner() {
  const gallery = useCreateStore((s) => s.gallery)
  const error = useCreateStore((s) => s.error)
  const setError = useCreateStore((s) => s.setError)
  const backend = useCreateStore((s) => s.backend)
  const comfyCorsBlocked = useCreateStore((s) => s.comfyCorsBlocked)
  const setComfyCorsBlocked = useCreateStore((s) => s.setComfyCorsBlocked)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const corsNoticeDismissedFor = useComfyNoticeStore((s) => s.corsNoticeDismissedFor)
  const dismissCorsNotice = useComfyNoticeStore((s) => s.dismissCorsNotice)
  const adoptCorsSignature = useComfyNoticeStore((s) => s.adoptCorsSignature)
  const retentionNoticeSeen = useCloudNoticeStore((s) => s.retentionNoticeSeen)
  const setRetentionNoticeSeen = useCloudNoticeStore((s) => s.setRetentionNoticeSeen)
  const setManagerNoticeSeen = useWorkflowStore((s) => s.setManagerNoticeSeen)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const audioModelList = useCreateStore((s) => s.audioModelList)
  const lipsyncModelList = useCreateStore((s) => s.lipsyncModelList)
  const motionModelList = useCreateStore((s) => s.motionModelList)
  const upscaleModelList = useCreateStore((s) => s.upscaleModelList)
  const { modelLoadError, connected, modelsLoaded, mlxMissing, comfyOnCpu, comfyCpuBanner } = useCreateExp()

  // P9: AdvancedDrawer needs the same studioModel Composer.tsx derives
  // (Portplan Abschnitt 3b), so the Expert drawer shows StudioParams instead
  // of WorkflowFinder+ParamGroups whenever a Studio pick is active. P7's
  // report flagged this as still open: Composer computes studioPick itself
  // and never passed it up, so CreateExperimental rendered AdvancedDrawer
  // with no studioModel at all and the drawer always fell back to the
  // ComfyUI expert block even on a Studio pick. Same read-only derivation as
  // Composer.tsx, kept in sync by hand (both read the same store getters and
  // pure functions, no new state).
  const intent = useCreateStore((s) => s.intent())
  const threeDWay = useCreateStore((s) => s.threeDWay)
  // The Character area (3.1.0 part B) takes the place of the stage and the
  // prompt window for its four intents; gallery and presets stay beside it.
  const hubOpen = isHubIntent(intent)
  // The Character tab stands on the middle axis of the prompt window: the
  // room the rails take at the right is kept free at the left as well
  // (index.css, .lu-hub-row reads --hub-rails).
  const rails = useRef<HTMLDivElement>(null)
  const [railsWidth, setRailsWidth] = useState(0)
  useEffect(() => {
    const el = rails.current
    if (!hubOpen || !el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setRailsWidth(el.offsetWidth))
    ro.observe(el)
    setRailsWidth(el.offsetWidth)
    return () => ro.disconnect()
  }, [hubOpen])
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  // Der Katalog kommt vom Server; die Studio-Wahl liest ihn, also zeichnet sich
  // diese Flaeche neu, sobald er eintrifft.
  useCloudCatalogStore((s) => s.models)
  // Seit 02.10.2026 faehrt nicht nur eine Rollen-Absicht ein Studio-Modell,
  // sondern auch Image, Edit, Video und Animate (Web-Paritaet). Eine Funktion
  // traegt die Regel fuer Composer, Zaehler, Start und diese Schublade; der
  // Character-Weg bleibt davon ausgenommen. Auf der lokalen Spur gibt es nie
  // eine Studio-Wahl.
  const studioPick = backend === 'cloud' ? studioPickFor(studioIntentOf(intent, threeDWay), { cloudImageModel, cloudVideoModel, cloudOpModel }) : undefined

  const [shownId, setShownId] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [maskOpen, setMaskOpen] = useState(false)
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null)
  // The large view opens with the prompt folded; the Prompt word in the
  // facts asks for the prompt, so it opens it unfolded.
  const [lightboxPrompt, setLightboxPrompt] = useState(false)
  // The video whose frames are being saved as a character (SaveCharacterModal).
  const [characterFrom, setCharacterFrom] = useState<GalleryItem | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [workflowsOpen, setWorkflowsOpen] = useState(false)

  // Die gefuehrte Preset-Werkstatt (P6, Portplan Abschnitt 5): eine Schiene
  // rechts neben Buehne/Galerie, ein Fenster obendrauf. `presetsOpen` haelt
  // nur, ob die Schiene aufgeklappt ist; die Werkstatt selbst bleibt offen,
  // solange ein Lauf darin arbeitet (`presetDialogOpen` schliesst nur die
  // SICHTBARE Flaeche, `selectedPreset` bleibt fuer den Continue-Knopf
  // stehen). Auf `Modal` statt eines eigenen Fokus-/Escape-Baus: dieselbe
  // Sperrklinke wie jedes andere Fenster im Haus (X, Escape,
  // e2e/escape-closes-overlays.spec.ts).
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<CreatePreset | null>(null)
  const [presetStarted, setPresetStarted] = useState(false)

  // One-click CORS fix (2026-07-17): restart the user-managed ComfyUI
  // under LU's management so it carries --enable-cors-header. On success the
  // banner clears; if LU can't do it (unknown path / remote host) the backend
  // error explains the manual route and stays visible in the banner.
  const [corsFixing, setCorsFixing] = useState(false)
  const [corsFixError, setCorsFixError] = useState<string | null>(null)

  // R18 Befund 1 (2026-08-30, Windows box, ComfyUI 0.33.0): the cross-origin
  // bar came back after EVERY render, dismissed or not. The X only flipped the
  // session flag that the next preview image set again (useComfyMedia). The
  // dismissal now sticks against a cause signature (which ComfyUI, which
  // version) and is persisted, so it survives a restart and only lifts if that
  // cause actually changes. Rules and reasoning: lib/comfy-cors-notice.ts.
  const [corsSignature, setCorsSignature] = useState<string | null>(null)
  useEffect(() => {
    if (backend !== 'local') return
    let cancelled = false
    void (async () => {
      const { getComfyHost, getComfyPort } = await import('../../../api/backend')
      const { getComfyVersion } = await import('../../../api/comfyui')
      const sig = await loadComfyCorsSignature({
        host: getComfyHost, port: getComfyPort, version: getComfyVersion,
      })
      if (cancelled || !sig) return
      setCorsSignature(sig)
      // A dismissal made before the signature landed is upgraded to it, or the
      // very next render would show the bar again — the finding itself.
      adoptCorsSignature(sig)
    })()
    return () => { cancelled = true }
  }, [backend, connected, adoptCorsSignature])

  // R18 Befund 2 (2026-08-30, Windows box): ComfyUI was killed while the app
  // sat idle on this tab and the Create surface said NOTHING for 180 seconds.
  // `connected` is probed once on mount and never again, so a death nobody
  // asked about produced no error to show. The next render heals it (R16
  // Befund 5, comfy-restart-guard) — the user just had no way to know that.
  //
  // A glance every 30s while this tab is open and idle, no restart of its own:
  // holding an engine warm for work nobody asked for costs RAM and VRAM, and
  // the render path already fixes it on demand. Wording in lib/comfy-idle-watch.
  //
  // Silent while LU restarts ComfyUI itself: the setup card or the update line
  // is already saying what happens, and the look comes back when it is done.
  const setupRunning = useSyncExternalStore(subscribeInstallRuns, anyInstallRunning)
  const comfyUpdating = useComfyInstallStore((s) => s.phase !== 'idle' && s.phase !== 'error')
  const luIsRestartingComfy = setupRunning || comfyUpdating || corsFixing
  // While this view is open a finished render keeps the graphics card for the
  // next one; leaving it brings the chat model back (api/vram-handoff).
  useEffect(() => {
    setRenderSurfaceOpen(true)
    return () => setRenderSurfaceOpen(false)
  }, [])
  const [idleNotice, setIdleNotice] = useState('')
  const idleTimerRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    let cancelled = false
    const clear = () => { if (!cancelled) setIdleNotice('') }
    void (async () => {
      const { isMacOS } = await import('../../../api/backend')
      if (cancelled) return
      if (!shouldWatchComfyIdle(backend === 'local', isMacOS(), isGenerating, luIsRestartingComfy)) { clear(); return }
      const { backendCall } = await import('../../../api/backend')
      const look = async () => {
        const st = await backendCall<ComfyGuardStatus>('comfyui_status').catch(() => null)
        if (!cancelled) setIdleNotice(comfyIdleNotice(st))
      }
      await look()
      const timer = setInterval(() => { void look() }, IDLE_WATCH_INTERVAL_MS)
      idleTimerRef.current = () => clearInterval(timer)
    })()
    return () => { cancelled = true; idleTimerRef.current?.(); idleTimerRef.current = null }
  }, [backend, isGenerating, luIsRestartingComfy])

  const fixCorsForMe = useCallback(async () => {
    setCorsFixing(true)
    setCorsFixError(null)
    try {
      const { backendCall } = await import('../../../api/backend')
      await backendCall('fix_comfyui_cors')
      // ComfyUI is relaunching with the flag — direct loads work from here on.
      useCreateStore.getState().setComfyCorsBlocked(false)
    } catch (err) {
      setCorsFixError(err instanceof Error ? err.message : String(err))
    } finally {
      setCorsFixing(false)
    }
  }, [])

  // 2026-07-11: the Stage starts EMPTY and never auto-surfaces a persisted
  // gallery item — not on mount, not on a mode/intent switch. It fills only on an
  // explicit pick (a gallery tile, or a result's "Edit" action) or a fresh
  // generation made in THIS session. Seed prevTop with whatever is already on top
  // so a persisted item is never mistaken for a just-made result; only a genuinely
  // new top id (an in-session generation) auto-shows.
  const prevTop = useRef<string | undefined>(gallery[0]?.id)
  // 3.1.0 (C27): the full list from IndexedDB, or entries restored from the
  // output folder, can put an older entry on top. Only one made in this
  // session counts as a new result.
  const sessionStart = useRef(Date.now() - 60_000)
  useEffect(() => {
    const top = gallery[0]
    if (top && top.id !== prevTop.current) {
      prevTop.current = top.id
      if (top.createdAt >= sessionStart.current) setShownId(top.id)
    }
  }, [gallery])

  // Switching intent/mode returns the Stage to empty — the newest gallery item
  // must not reappear just because the axis changed. (`intent` is read once,
  // near the top of the component, for the studioModel derivation below.)
  useEffect(() => { setShownId(null) }, [intent])

  const displayed = shownId ? gallery.find((g) => g.id === shownId) : undefined

  // Ein Zustand, eine Stimme. `modelLoadError` beschreibt genau die Lage, fuer
  // die die Buehne darunter die Einrichtungskarte zeigt — mit demselben Satz
  // (Mac) oder mit einem, der in die andere Richtung zeigt (Windows: „Start it
  // from Settings or wait for auto-start" ueber einem Knopf, der es selbst
  // erledigt). Solange die Karte da ist, schweigt der Balken. Die Begruendung
  // mit beiden Wortlauten steht in ./stageGate.
  //
  // `error` ist davon ausgenommen: das sind Laufzeitfehler eines konkreten
  // Laufs, die die Karte nicht erklaert — und nur sie tragen das
  // Schliesskreuz.
  const comfyStarting = idleNotice === IDLE_STARTING
  const setupCardOwnsStage = stageShowsSetupCard({
    backend,
    requiresModels: INTENT_MAP[intent].requiresModels,
    mlxMissing,
    connected,
    comfyStarting,
    modelsLoaded,
    laneModelCount: laneModelCount(intent, INTENT_MAP[intent].requiresModels, {
      image: imageModelList, video: videoModelList, audio: audioModelList,
      lipsync: lipsyncModelList, motion: motionModelList, upscale: upscaleModelList,
    }),
  })
  // While ComfyUI starts, "ComfyUI is starting up." is the one voice; the
  // load error "is not running" said the opposite in red next to it
  // (3.0.4 Gegenprobe 8).
  //
  // In Cloud mode nothing renders on this machine. `modelLoadError` is the
  // state of the LOCAL model list, which is fetched whatever the mode is, so
  // on a Windows or Linux machine with no ComfyUI running the Cloud tab stood
  // under "ComfyUI is not running. Start it from Settings or wait for
  // auto-start." (how-to recording 12.10.2026). It belongs to the local lane.
  // 3D on a Mac runs its own engine (commands/mesh3d.rs): the state of the
  // image engine is its business only for "From text", which paints first.
  const threeDOwnEngine = intent === '3d' && isMlxImageHost() && threeDWay !== 'text'
  const banner = error ?? (backend === 'cloud' ? null : setupCardOwnsStage || comfyStarting || threeDOwnEngine ? null : modelLoadError)

  // "Edit with mask" on a finished image force-sets the 'edit' intent and
  // opens the mask editor. On the MLX Mac that is Qwen-Image 2.1 on the
  // second engine, which paints under a mask (mflux `--mask-image`), so the
  // action is there while such a model is installed, as the Edit tab is.
  const mlxEdit = useCreateStore((s) => mlxTakesEditImage(s.imageModelList))
  const editAvailable = isIntentAvailable('edit', backend, isMlxImageHost(), false, mlxEdit)
  const mlxAnimate = useCreateStore((s) => mlxTakesStartImage(s.videoModelList))
  const animateAvailable = isIntentAvailable('animate', backend, isMlxImageHost(), mlxAnimate)

  // Pull a finished result back in as the working source (ImageRef). Needed
  // because a text-to-image run leaves `source` empty — without this, "Edit
  // with mask" on a result and switching to Edit/Upscale/Eraser/Animate were
  // no-ops that demanded a download + re-upload of the app's own output.
  const adoptResult = useCallback(async (item: GalleryItem) => {
    const blob = await fetchGalleryItemBlob(item)
    const file = new File([blob], item.filename || 'result.png', { type: blob.type || 'image/png' })
    return loadImageRef(file)
  }, [])

  const editResultWithMask = useCallback(async (item: GalleryItem) => {
    useCreateStore.getState().setIntent('edit')
    try {
      useCreateStore.getState().setSource(await adoptResult(item))
      setMaskOpen(true)
    } catch (err) {
      setError(`Could not load the result for editing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [adoptResult, setError])

  // C1: "Animate this image" on a finished result (web parity, createStore's
  // animateFrom / OutputView.tsx). setIntent('animate') already keeps the
  // current source in place (see createStore.ts's 'animate' case, which
  // deliberately skips ...dropAll), but a fresh t2i result was never adopted
  // as `source` in the first place, so setSource still has to run after it,
  // exactly like editResultWithMask does for 'edit'. No mask step needed here.
  //
  // C1 nachbessert, Punkt 8: also coerce cloudVideoModel onto a real i2v
  // model via modelForOp, the same coercion submit/the credits gate already
  // apply. Without this the ModelChip kept showing whatever was picked for
  // the PREVIOUS intent (e.g. a t2v-only model), which the run itself never
  // used, since modelForOp silently swaps to i2vModels()[0] at submit time.
  // Web's animateFrom does the equivalent set for parity.
  const animateResult = useCallback(async (item: GalleryItem) => {
    const state = useCreateStore.getState()
    state.setIntent('animate')
    state.setCloudVideoModel(modelForOp('video', 'animate', state.cloudVideoModel))
    try {
      state.setSource(await adoptResult(item))
    } catch (err) {
      setError(`Could not load the result for animating: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [adoptResult, setError])

  // 2026-07-10: source-needing ops must start EMPTY — never silently
  // adopt a gallery image as the input. Adoption is always explicit: the
  // InputSlot's "pick from gallery" strip, drag&drop, the file picker, or a
  // result's "Edit" action. While an op intent owns the stage, clicking a
  // gallery tile opens the Lightbox (view it, videos play) instead of
  // showing it in a stage that can't display it.
  const openGalleryItem = useCallback((id: string) => {
    const item = useCreateStore.getState().gallery.find((g) => g.id === id)
    if (!item) return
    // 3D from a picture or a video owns a source too, and a model opens in
    // the large view, where it can be turned.
    if (intentNeedsSource(intent, useCreateStore.getState().threeDWay) || item.type === '3d') setLightbox(item)
    else setShownId(id)
  }, [intent])

  return (
    <div className="relative h-full w-full flex flex-col bg-white dark:bg-[#141414] text-gray-900 dark:text-gray-200 overflow-hidden">
      <IntentBar />

      {/* Die Meldeleiste dieser Oberflaeche: vier Lagen, ZWEI Toene. Rot, wenn
          jemand handeln muss, sonst gedaempftes Grau, und keine davon in einem
          Kasten. Drei dieser vier waren gelb gefuellt, mit Rahmen und
          Warndreieck, so dass ein Satz ueber die Aufbewahrungsdauer und ein
          Absturz gleich schwer wogen. Regel und Begruendung: lib/hinweis.ts. */}
      <AnimatePresence>
        {banner && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden shrink-0"
          >
            <Hinweis
              ton="fehler"
              icon={<AlertTriangle size={12} className="shrink-0 mt-px" />}
              onDismiss={error ? () => setError(null) : undefined}
              className="px-4 py-2"
            >
              <BannerText text={banner} />
            </Hinweis>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CPU-mode warning, persistent while LU's ComfyUI runs with --cpu.
          Without it a user sees "Ready to generate" and then a bare 20-minute
          timeout (RX 7900 XTX). Local renders only, cloud jobs
          never touch the local ComfyUI.

          The sentence itself lives in lib/comfy-cpu-banner.ts, because it is
          three sentences: the R12/R13 re-measure caught this bar telling a user
          with a working, correctly detected RTX 3060 that no usable GPU had
          been found, when he had chosen Force CPU himself, and then walking him
          through the AMD route on a machine with no AMD card in it. Same three
          facts the backend was already sending, now all three read.

          Das Chipsymbol statt des Warndreiecks ist der Punkt: hier ist nichts
          kaputt, es rechnet nur der Prozessor. Der innere span bleibt stehen,
          weil lib/__tests__/cpu-banner-names-the-real-reason.test.ts genau an
          ihm prueft, dass diese Leiste den Satz RENDERT und keine vierte
          Abschrift von ihm traegt. */}
      {backend === 'local' && connected === true && comfyOnCpu && comfyCpuBanner && (
        <Hinweis icon={<Cpu size={12} className="shrink-0 mt-px" />} className="px-4 py-2 shrink-0">
          <span>{comfyCpuBanner}</span>
        </Hinweis>
      )}

      {/* A Mac with less memory than the lane's video model is recommended
          for. The run is not held back, so it is said before it starts. */}
      <MacVideoMemoryNotice />

      {/* Local 3D on a PC whose card is under TRELLIS.2's 12 GB, or with
          ComfyUI on the processor: one line before setup and run, with the
          way to LU Cloud 3D. A hint, the setup and the run stay possible. */}
      <ThreeDHardwareNotice />

      {/* The run on screen does not fit this machine (too big for the card,
          only partly on it for a video, or a long Mac run): one quiet line
          that LU Cloud runs it, closable for the session. */}
      <CreateCloudOffer />

      {/* Idle outage (R18 Befund 2): ComfyUI died while nobody was rendering
          and the tab said nothing about it for 180 seconds. One quiet line,
          no button: the render path restarts it and this says so. Nothing is
          started from here — see lib/comfy-idle-watch.ts for why. */}
      {idleNotice && (
        <Hinweis className="px-4 py-2 shrink-0">{idleNotice}</Hinweis>
      )}

      {/* Cross-origin block (#75): a user-managed ComfyUI 0.19+
          answers the WebView's media/WS requests with a Sec-Fetch 403, so results
          couldn't be viewed. LU proxies the bytes so they still display, but the
          live progress bar + native video seeking degrade. 2026-07-17: keep
          the message short and offer a one-click fix — LU restarts ComfyUI under
          its own management, which always passes the CORS flag. Local only,
          dismissible; the long manual-flag hint only appears if the fix fails.

          R18 Befund 1: dismissible now MEANS dismissed. shouldShowCorsNotice
          holds the X against the cause signature, so the bar cannot return
          after every render the way it did on the box with ComfyUI 0.33.0. */}
      {backend === 'local' && shouldShowCorsNotice(comfyCorsBlocked, corsSignature, corsNoticeDismissedFor) && (
        <Hinweis
          ton={corsFixError ? 'fehler' : 'ruhig'}
          icon={corsFixError ? <AlertTriangle size={12} className="shrink-0 mt-px" /> : undefined}
          onDismiss={() => { setComfyCorsBlocked(false); setCorsFixError(null); dismissCorsNotice(corsSignature) }}
          className="px-4 py-2 shrink-0"
        >
          {corsFixError
            ? corsFixError
            : corsFixing
              ? 'Restarting ComfyUI with the fix… this takes a moment.'
              : 'Your ComfyUI blocks direct loads (v0.19+), so previews use a slower fallback.'}
          {!corsFixing && (
            <button
              onClick={() => { void fixCorsForMe() }}
              disabled={isGenerating}
              title={isGenerating ? 'Waiting for the current generation to finish' : 'LU restarts ComfyUI with the CORS flag for you'}
              className="ml-1.5 underline underline-offset-2 whitespace-nowrap opacity-80 hover:opacity-100 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Let me do it for you!
            </button>
          )}
        </Hinweis>
      )}

      <CloudHiddenNotice />

      {/* Cloud gallery retention (2026-07-24). Cloud renders live on our
          servers, not on this machine, so the gallery is not permanent storage.
          Cloud mode only. One time ever: no close X and no auto-hide, the only
          way out is the explicit "Do not show again", and it stays dismissed
          across updates (persisted in lu_cloud_notice). */}
      {shouldShowRetentionNotice(backend, retentionNoticeSeen) && (
        <Hinweis icon={<Cloud size={12} className="shrink-0 mt-px" />} className="px-4 py-2 shrink-0">
          Cloud results are stored for {CLOUD_RETENTION_DAYS} days and then deleted.
          Download anything you want to keep from the gallery.
          <button
            onClick={() => setRetentionNoticeSeen(true)}
            className="ml-1.5 underline underline-offset-2 whitespace-nowrap opacity-80 hover:opacity-100 transition-opacity"
          >
            Do not show again
          </button>
        </Hinweis>
      )}

      {/* The viewer (Stage) and the Gallery bubble share ONE row, so they're
          always the exact same height; the prompt window spans the full width
          beneath them. (Previously the Gallery ran full-height alongside both the
          viewer AND the composer, so it was taller than the viewer.) */}
      {/* The Character tab: its column stands exactly over the prompt window
          (index.css, .lu-hub-row), the rails stay at the right. */}
      <div
        className={hubOpen ? 'lu-hub-row flex-1 min-h-0 overflow-hidden' : 'flex-1 min-h-0 flex overflow-hidden'}
        style={hubOpen ? { ['--hub-rails' as string]: `${Math.max(16, railsWidth)}px` } : undefined}
      >
        {hubOpen ? (
          <CharacterHub
            stage={{
              displayed,
              onOpenMaskEditor: () => setMaskOpen(true),
              onEditResult: editAvailable ? (it) => { void editResultWithMask(it) } : undefined,
              onAnimateResult: animateAvailable ? (it) => { void animateResult(it) } : undefined,
              onFullscreen: (it) => { setLightboxPrompt(false); setLightbox(it) },
              onShowPrompt: (it) => { setLightboxPrompt(true); setLightbox(it) },
              onSaveCharacter: setCharacterFrom,
              comfyStarting,
            }}
            onOpenGallery={() => setPanelOpen(true)}
          />
        ) : (
          <Stage
            displayed={displayed}
            onOpenMaskEditor={() => setMaskOpen(true)}
            onEditResult={editAvailable ? (it) => { void editResultWithMask(it) } : undefined}
            onAnimateResult={animateAvailable ? (it) => { void animateResult(it) } : undefined}
            onFullscreen={(it) => { setLightboxPrompt(false); setLightbox(it) }}
            onShowPrompt={(it) => { setLightboxPrompt(true); setLightbox(it) }}
            onSaveCharacter={setCharacterFrom}
            comfyStarting={comfyStarting}
          />
        )}
        {/* On a phone-wide window the Character area takes the whole width
            (its rails would leave the column 200 px). */}
        <div ref={rails} className={hubOpen ? 'lu-hub-rails max-[520px]:hidden' : 'contents'}>
          <CreatePanel open={panelOpen} onOpenChange={setPanelOpen} activeId={shownId} onSelect={openGalleryItem} />
          <PresetShelf
            open={presetsOpen}
            onOpenChange={setPresetsOpen}
            onSelect={(p) => { setSelectedPreset(p); setPresetStarted(false); setPresetDialogOpen(true) }}
            resume={selectedPreset && presetStarted && !presetDialogOpen ? { title: selectedPreset.title, onResume: () => setPresetDialogOpen(true) } : null}
          />
        </div>
      </div>

      {/* Prompt window — full width, beneath the viewer + gallery. The same
          one in every tab, the Character tab included (David, 16.11.2026). */}
      <Composer
        hub={hubOpen}
        onOpenAdvanced={() => setAdvancedOpen(true)}
        onOpenWorkflows={() => { setWorkflowsOpen(true); setManagerNoticeSeen(true) }}
      />

      <AdvancedDrawer open={advancedOpen} onClose={() => setAdvancedOpen(false)} studioModel={studioPick}
        onOpenWorkflows={() => { setAdvancedOpen(false); setWorkflowsOpen(true); setManagerNoticeSeen(true) }} />
      <WorkflowsModal open={workflowsOpen} onClose={() => setWorkflowsOpen(false)} />
      <MaskEditor open={maskOpen} onClose={() => setMaskOpen(false)} />

      {/* Preset-Werkstatt (P6): ein Popup mit X und Escape, dieselbe Sperrklinke
          wie jedes andere Fenster (Modal, siehe src/components/ui/Modal.tsx).
          Die Generation laeuft IM Fenster weiter, auch wenn niemand zusieht,
          geschlossen wird nur von Hand (Portplan Abschnitt 5/7).

          Optik (21.09.2026): das Fenster lag auf der blanken
          `.lu-elevated`-Flaeche (#363636). Fuer ein Menue ist das richtig,
          fuer ein 4xl breites Arbeitsfenster war es ein mittelgrauer Block
          vor der fast schwarzen App. Es traegt jetzt dieselbe schwarze
          Modalflaeche wie das Was-ist-neu-Blatt (`bg-lu-base`), und der
          Kopf des Hauses entfaellt: die Werkstatt schreibt den Titel des
          Presets ohnehin in ihre eigene Kopfzeile, also stand er zweimal
          da, und mit `panelPad="p-0"` klebte er obendrein ohne jeden
          Abstand in der Ecke. `hideHeader` laesst genau das X stehen, das
          die Hausregel verlangt; `ariaLabel` haelt den Namen des Dialogs
          unveraendert. */}
      {selectedPreset && backend === 'cloud' && (
        <Modal
          open={presetDialogOpen}
          onClose={() => setPresetDialogOpen(false)}
          title={selectedPreset.title}
          hideHeader
          ariaLabel={selectedPreset.title}
          maxWidth="max-w-4xl"
          panelPad="p-0"
          // Review B2: X/Escape darf den bezahlten Schrittzustand der
          // Werkstatt nicht wegwerfen. `keepMounted` haelt PresetWorkshop im
          // Baum und blendet nur das Fenster aus; `selectedPreset` bleibt
          // ohnehin schon stehen (siehe Kommentar oben bei presetDialogOpen),
          // also ist dies die letzte fehlende Haelfte.
          keepMounted
        >
          <div className="flex h-[min(600px,calc(90vh/var(--ui-scale)))] flex-col overflow-hidden rounded-2xl bg-lu-base dark:bg-transparent">
            <Suspense fallback={<div className="flex flex-1 items-center justify-center t-control text-gray-400">Loading…</div>}>
              <PresetWorkshop
                key={selectedPreset.id}
                preset={selectedPreset}
                onGenerate={() => setPresetStarted(true)}
                onClose={() => { setPresetDialogOpen(false); setSelectedPreset(null) }}
              />
            </Suspense>
          </div>
        </Modal>
      )}

      <Lightbox item={lightbox} promptOpen={lightboxPrompt} onClose={() => { setLightbox(null); setLightboxPrompt(false) }} onSaveCharacter={setCharacterFrom} onNavigate={(it) => { setLightboxPrompt(false); setLightbox(it) }} />
      <SaveCharacterModal item={characterFrom} onClose={() => setCharacterFrom(null)} />
      <VhsInstallModal />
    </div>
  )
}
