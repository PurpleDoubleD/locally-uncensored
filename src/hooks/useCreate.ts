import { useState, useCallback, useRef, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import {
  checkComfyConnection,
  refreshComfyModels,
  getImageModels,
  getVideoModels,
  getAudioModels,
  getLipsyncModels,
  getMotionModels,
  resolveLocalOpPick,
  uploadMediaFile,
  getSamplers,
  getSchedulers,
  detectVideoBackend,
  abandonPrompt,
  submitWorkflow,
  getHistory,
  isPromptQueued,
  buildTxt2ImgWorkflow,
  buildTxt2VidWorkflow,
  canRunVideoIntent,
  classifyModel,
  isI2VModel,
  videoLaneModels,
  extractComfyOutputFiles,
  galleryTypeForFile,
  MODEL_TYPE_DEFAULTS as COMFY_MODEL_DEFAULTS,
  type ClassifiedModel,
  type ComfyUIOutput,
  type VideoBackend,
} from '../api/comfyui'
import {
  comfyErrorHint,
  cpuRenderFacts,
  lastCpuRenderFacts,
  evictChatBackendsForRender,
  restoreChatBackendsAfterRender,
  type RenderEviction,
} from '../api/vram-handoff'
import { cpuCauseSuffix } from '../lib/render-budget'
import { backendCall } from '../api/backend'
import {
  ensureComfyForRender, comfyGuardMessage, type ComfyGuardStatus,
} from '../lib/comfy-restart-guard'
import {
  comfyWS, CLIENT_ID,
  type ComfyWSEvent,
} from '../api/comfyui-ws'
import { phaseForExecutingNode, phaseForProgressStep } from '../lib/render-phase-labels'
import { buildDynamicWorkflow, buildLocalOpWorkflow, checkVideoOutputCapability } from '../api/dynamic-workflow'
import { getAllNodeInfo, clearNodeCache } from '../api/comfyui-nodes'
import { apiNodes, type ComfyApiGraph, type ComfyExecutionMessage, type ComfyHistoryEntry } from '../types/comfy-graph'
import { restartComfyForNewNodes } from '../api/comfy-restart'
import { installCustomNodes } from '../api/discover'
import { checkPromptSafety, SAFETY_BLOCK_MESSAGE } from '../lib/render/safety'
import { resolveRunSeed } from '../lib/run-seed'
import {
  clearTrainingSet, stageTrainingImage, startCharacterTraining,
  characterTrainingStatus, cancelCharacterTraining,
} from '../api/trainer'
import { useCreateStore } from '../stores/createStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { injectParameters } from '../api/workflows'
import { applyNativeHiresFix } from '../api/hires-fix'
import {
  generateMlxImageDataUrl, isMlxImageHost, isMlxImageModel,
  mlxStatus, listMlxImageModels, buildMlxImageModels, mergeImageModels, mlxModelIdFor,
} from '../api/mlx-image'
import {
  getVideoStatus, listVideoModels, generateVideo, getVideoProgress, cancelVideo,
  buildMlxVideoModels, mlxVideoModelIdFor, readVideoAsBlobUrl,
} from '../api/mlx-video'

/**
 * The `[event, payload]` pairs of a `/history` status entry.
 *
 * `ComfyHistoryEntry` DECLARES `messages` as those pairs, but `getHistory`
 * only checks that the entry is an object — so the array-ness is a claim about
 * ComfyUI's JSON, not a fact. Four call sites below used to run `.find` on it
 * straight from a `[string, any][]` annotation; one non-array `messages` field
 * would have thrown out of the render-polling loop and left the Create tab
 * stuck on "Generating…" with no error.
 */
function historyMessages(entry: ComfyHistoryEntry | null): [string, ComfyExecutionMessage][] {
  const raw = entry?.status?.messages
  return Array.isArray(raw) ? raw : []
}

export function useCreate() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [imageModels, setImageModels] = useState<ClassifiedModel[]>([])
  const [videoModelsList, setVideoModelsList] = useState<ClassifiedModel[]>([])
  const [samplerList, setSamplerList] = useState<string[]>([])
  const [schedulerList, setSchedulerList] = useState<string[]>([])
  const [videoBackend, setVideoBackend] = useState<VideoBackend>('none')
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  // macOS only: which local media lanes have no MLX model installed yet.
  // `null` means "not probed" — Windows/Linux leave it there, and so does the
  // Mac until the first fetch answers, so no setup card can flash at startup.
  // `connected` cannot carry this: it tracks ComfyUI, which is not the local
  // media backend on a Mac.
  const [mlxMissing, setMlxMissing] = useState<{ image: boolean; video: boolean } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // A local character-training run is a Rust child process, not a ComfyUI
  // prompt — cancel() must reach it through its own command.
  const trainingActive = useRef(false)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const checkConnection = useCallback(async () => {
    const ok = await checkComfyConnection()
    setConnected(ok)
    // Mirror into createStore so the header-level Lichtschalter in
    // CreateTopControls stays in sync with the deeper useCreate state.
    useCreateStore.getState().setComfyRunning(ok)
    return ok
  }, [])

  const zeroModelRetries = useRef(0)

  const fetchModels = useCallback(async () => {
    setModelLoadError(null)

    try {
      // Apple Silicon: MLX is a first-class local media backend (hard rule —
      // Mac local image/video is the in-process MLX path, never ComfyUI). Load
      // the installed MLX catalogs FIRST so Create works on the normal Mac,
      // which has no ComfyUI at all.
      const mlxHost = isMlxImageHost()
      let mlxImageModels: ClassifiedModel[] = []
      // Video has no ComfyUI counterpart on Mac (ComfyUI never even auto-starts
      // there — see process.rs::auto_start_comfyui). The video list IS the MLX
      // catalog.
      let mlxVideoModels: ClassifiedModel[] = []
      if (mlxHost) {
        try {
          const mlx = await mlxStatus()
          if (mlx.installed) mlxImageModels = buildMlxImageModels(await listMlxImageModels())
        } catch { /* MLX engine not set up yet — treat as no MLX models */ }
        try {
          mlxVideoModels = buildMlxVideoModels(await listVideoModels())
        } catch { /* mlx-video status unavailable yet — treat as no MLX video models */ }
        setMlxMissing({ image: mlxImageModels.length === 0, video: mlxVideoModels.length === 0 })
      }

      // Check connection first — if ComfyUI is down, don't waste time on model queries.
      // Sync the connected state on EVERY fetch: the mount-time checkConnection can
      // race ComfyUI's autostart (exe boots faster than the engine), and nothing
      // else ever flipped `connected` back to true — the Stage then kept showing
      // the Download & install card while the model chip was happily populated
      // (live-caught on the 2.5.8 extend lane E2E).
      // NOT on Mac: there is no ComfyUI to be connected to, and pinning
      // `connected` to false is exactly what makes the Stage cover a working
      // MLX catalog with the ComfyUI "Download & install" card. Left at null
      // ("not applicable"), which every ComfyUI-gated surface treats as neutral.
      // On the Mac the answer is decided, not probed. ComfyUI is never started
      // there and never renders there, so asking port 8188 can only produce a
      // wrong answer: anything that happens to reply — a manual install, another
      // app — used to drag the whole tab into the ComfyUI path, where the model
      // queries then failed and left the store's list EMPTY while the picker
      // still displayed the MLX catalog. Pressing Create in that state said
      // "No image model selected. Add checkpoints or FLUX models to ComfyUI."
      // (caught by the MLX e2e, MAC-5.)
      const comfyOk = mlxHost ? false : await checkComfyConnection()
      if (!mlxHost) {
        setConnected(comfyOk)
        useCreateStore.getState().setComfyRunning(comfyOk)
      }
      if (!comfyOk) {
        // On Apple Silicon MLX alone is a valid image/video backend — don't bail.
        if (mlxImageModels.length > 0 || mlxVideoModels.length > 0) {
          const st = useCreateStore.getState()
          setImageModels(mlxImageModels)
          st.setImageModelList(mlxImageModels)
          if (mlxImageModels.length > 0 && !mlxImageModels.find(m => m.name === st.imageModel)) {
            st.setImageModel(mlxImageModels[0].name, mlxImageModels[0].type)
          }
          setVideoModelsList(mlxVideoModels)
          st.setVideoModelList(mlxVideoModels)
          if (mlxVideoModels.length > 0 && !mlxVideoModels.find(m => m.name === st.videoModel)) {
            st.setVideoModel(mlxVideoModels[0].name)
          }
          zeroModelRetries.current = 0
          setModelsLoaded(true)
          return
        }
        // Honest copy: there is no "Model Manager → Mac Image/Video" surface to
        // point at, and naming the raw install command leaks an internal path.
        setModelLoadError(
          mlxHost
            ? 'The local image engine is not set up on this Mac yet — a one-time setup is needed before local generation works.'
            : 'ComfyUI is not running. Start it from Settings or wait for auto-start.'
        )
        return
      }

      // Force ComfyUI to re-scan model directories before querying.
      // This fixes the case where models were downloaded while ComfyUI was running
      // and its internal cache hasn't updated yet.
      await refreshComfyModels()

      const [comfyImgModels, comfyVidModels, samplers, schedulers, vBackend, _nodeInfo, audModels, lipModels, motModels] = await Promise.all([
        getImageModels(),
        getVideoModels(),
        getSamplers(),
        getSchedulers(),
        detectVideoBackend(),
        getAllNodeInfo().catch(() => null),
        // 2.5.8 specialized lane lists — best-effort so a probe failure never
        // blocks the classic image/video surfaces.
        getAudioModels().catch(() => [] as ClassifiedModel[]),
        getLipsyncModels().catch(() => [] as ClassifiedModel[]),
        getMotionModels().catch(() => [] as ClassifiedModel[]),
      ])
      // MLX entries go first so one is the default on a fresh Apple-Silicon box.
      const imgModels = mlxImageModels.length
        ? mergeImageModels(comfyImgModels, mlxImageModels)
        : comfyImgModels
      // Mac video is MLX-only — never surface ComfyUI video checkpoints there,
      // even in the rare case ComfyUI happens to be reachable (a manual install
      // the user started outside LU).
      const vidModels = mlxHost ? mlxVideoModels : comfyVidModels
      setImageModels(imgModels)
      setVideoModelsList(vidModels)
      setSamplerList(samplers)
      setSchedulerList(schedulers)
      setVideoBackend(vBackend)

      // Mirror the fetched lists into createStore so the header-level
      // CreateTopControls dropdown (which does NOT host its own useCreate)
      // can render without crashing on undefined. Discord-reported by
      // @diimmortalis (console: `activeList is undefined`).
      const st = useCreateStore.getState()
      st.setImageModelList(imgModels)
      st.setVideoModelList(vidModels)
      st.setAudioModelList(audModels)
      st.setLipsyncModelList(lipModels)
      st.setMotionModelList(motModels)

      // If ComfyUI is connected but returns 0 models, do NOT set modelsLoaded — keep retrying.
      // ComfyUI may still be scanning directories (race condition on startup).
      if (imgModels.length === 0 && vidModels.length === 0) {
        zeroModelRetries.current++
        if (zeroModelRetries.current <= 12) {
          // Still retrying — ComfyUI might not be done scanning yet
          console.log(`[useCreate] 0 models found, retry ${zeroModelRetries.current}/12...`)
          setModelLoadError('ComfyUI is loading models... This can take a moment after startup.')
          // Don't set modelsLoaded — auto-retry will keep running
        } else {
          // Give up retrying — flip to loaded so the empty-state UI can render.
          // Clear any stale persisted model names so callers don't try to
          // generate against a model that no longer exists.
          const state = useCreateStore.getState()
          if (state.imageModel) {
            console.warn(`[useCreate] Clearing stale persisted imageModel "${state.imageModel}" (0 models installed).`)
            state.setImageModel('', 'unknown')
          }
          if (state.videoModel) {
            console.warn(`[useCreate] Clearing stale persisted videoModel "${state.videoModel}" (0 models installed).`)
            state.setVideoModel('')
          }
          setModelsLoaded(true)
          setModelLoadError(null)  // empty-state UI handles this — don't double-up
        }
        return
      }

      // Models found — reset retry counter and mark loaded
      zeroModelRetries.current = 0
      setModelsLoaded(true)

      const state = useCreateStore.getState()
      // Auto-select first models if none set (or stale name no longer exists)
      if (imgModels.length > 0) {
        if (!state.imageModel) {
          state.setImageModel(imgModels[0].name, imgModels[0].type)
        }
      } else if (state.imageModel) {
        // Image models absent but videos found — clear stale image model
        console.warn(`[useCreate] No image models installed, clearing stale imageModel "${state.imageModel}".`)
        state.setImageModel('', 'unknown')
      }
      if (vidModels.length > 0) {
        if (!state.videoModel || !vidModels.find(m => m.name === state.videoModel)) {
          if (state.videoModel) console.warn(`[useCreate] Persisted videoModel "${state.videoModel}" not found, resetting to ${vidModels[0].name}`)
          state.setVideoModel(vidModels[0].name)
        }
      } else if (state.videoModel) {
        // Video models absent but images found — clear stale video model
        console.warn(`[useCreate] No video models installed, clearing stale videoModel "${state.videoModel}".`)
        state.setVideoModel('')
      }
      // Always re-sync model type for currently selected model (fixes stale type after restart)
      if (state.imageModel && imgModels.length > 0) {
        const current = imgModels.find(m => m.name === state.imageModel)
        if (current) {
          if (current.type !== state.imageModelType) {
            console.log(`[useCreate] Fixing model type: ${state.imageModelType} -> ${current.type}`)
            state.setImageModel(state.imageModel, current.type)
          }
        } else {
          // Persisted model no longer exists in ComfyUI — reset to first available
          console.warn(`[useCreate] Persisted imageModel "${state.imageModel}" not found in ComfyUI, resetting to ${imgModels[0].name}`)
          state.setImageModel(imgModels[0].name, imgModels[0].type)
        }
      }
    } catch (err) {
      console.error('[useCreate] Failed to fetch models:', err)
      setModelLoadError(`Failed to load models: ${err instanceof Error ? err.message : 'ComfyUI API error'}`)
    }
  }, [])

  // Auto-refresh models when a ComfyUI model download completes.
  // Schedules three fetches because real-world ComfyUI scans take longer than
  // the /api/refresh round-trip implies: the API responds OK but the in-memory
  // model list catches up only after the directory walk finishes. A single
  // fetch immediately after the event was leaving Draekzy + cprovencher
  // staring at a "model installed but not in dropdown" state for minutes.
  useEffect(() => {
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const handler = () => {
      console.log('[useCreate] Model download completed, refreshing model list...')
      fetchModels()
      // Belt-and-braces: re-fetch at +2s and +6s in case ComfyUI's scan is slow.
      // fetchModels() is idempotent and cheap (object_info hits cache server-side),
      // so a couple of extra calls cost almost nothing.
      timeouts.push(setTimeout(() => { if (!cancelled) fetchModels() }, 2000))
      timeouts.push(setTimeout(() => { if (!cancelled) fetchModels() }, 6000))
    }
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => {
      cancelled = true
      timeouts.forEach(clearTimeout)
      window.removeEventListener('comfyui-model-downloaded', handler)
    }
  }, [fetchModels])

  // Auto-retry model loading when ComfyUI reconnects OR when 0 models found (startup race)
  useEffect(() => {
    if (!modelLoadError) return  // No error — nothing to retry
    if (modelsLoaded) return     // modelsLoaded + error = gave up after max retries, don't loop
    const retryInterval = setInterval(async () => {
      // No ComfyUI to wait for on Mac (hard rule: MLX-only) — retry the MLX
      // catalog directly instead of gating on a connection that never comes.
      if (isMlxImageHost()) {
        fetchModels()
        return
      }
      const ok = await checkComfyConnection()
      if (ok) {
        console.log('[useCreate] Retrying model fetch...')
        fetchModels()
      }
    }, 3000)
    return () => clearInterval(retryInterval)
  }, [modelLoadError, modelsLoaded, fetchModels])

  // ── 2.5.8 A5: local character training. Not a ComfyUI render — the Rust
  // trainer (musubi-tuner in its own venv) owns stage -> cache -> train ->
  // convert -> loras/; this just streams its status into the normal
  // generating UI and lands the user on the Use tab when the LoRA is in.
  const runCharacterTraining = useCallback(async () => {
    const state = useCreateStore.getState()
    const { setIsGenerating, setProgress, setError } = state
    const trigger = state.triggerWord.trim()
    if (!trigger) {
      setError('Pick a trigger word first, e.g. davechar. It becomes the token that summons your character.')
      return
    }
    // Blobs are runtime-only — after an app restart the thumbnails would
    // still render (object URLs die too, but names persist) with no bytes.
    const staged = state.trainImages.filter((i) => i.blob instanceof Blob)
    if (staged.length < 4) {
      setError(staged.length < state.trainImages.length
        ? 'Your photos did not survive the app restart. Re-add them, then train.'
        : 'Add at least 4 photos of your character first (up to 30).')
      return
    }
    setError(null)
    setIsGenerating(true)
    trainingActive.current = true
    // The trainer is a 12 GB recipe on a 12 GB card. A resident chat model
    // (the built-in engine, Ollama, LM Studio) squats 2 to 9 GB of that and
    // the run dies in the text-encoder cache or the first training step with
    // CUDA out of memory. Same hand-off as a render (Z36): capture what is
    // resident, save the built-in engine's KV slot, evict, and bring it all
    // back in the finally below. exclusiveVramMode 'never' skips it.
    let trainingEviction: RenderEviction | null = null
    try {
      const setId = trigger
      await clearTrainingSet(setId)
      let n = 0
      for (const img of staged) {
        const bytes = Array.from(new Uint8Array(await img.blob.arrayBuffer()))
        // Musubi has no trigger flag — the token must lead every caption.
        await stageTrainingImage(setId, img.name, bytes, `${trigger}, a photo of ${trigger}`)
        n += 1
        setProgress(2 + Math.round((n / staged.length) * 5), `Staging photos (${n}/${staged.length})...`)
      }
      setProgress(7, 'Freeing the card for training (the local chat model pauses until the run ends)...')
      try {
        trainingEviction = await evictChatBackendsForRender()
      } catch { /* VRAM housekeeping is best-effort */ }
      setProgress(8, 'Starting the training run...')
      await startCharacterTraining(setId, trigger, trigger, state.trainSteps)
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000))
        // cancel() already reset the UI; the Rust child got its kill there.
        if (!useCreateStore.getState().isGenerating) return
        const s = await characterTrainingStatus().catch(() => null)
        if (!s) continue
        if (s.status === 'running') {
          if (s.totalSteps > 0) {
            setProgress(Math.min(95, 10 + Math.round((s.step / s.totalSteps) * 85)), `Training ${s.step}/${s.totalSteps}...`)
          } else {
            // Before the step counter exists the run is checking, possibly
            // repairing, and then caching. Those phases last minutes, so show
            // the phase the backend reports rather than a fixed line that
            // reads as a hang (A2: the repair must be visible while it runs).
            const last = s.logs[s.logs.length - 1] ?? ''
            const headline = s.phase || (/Step \d\/4/.test(last) ? last : '')
            setProgress(10, headline || 'Preparing training data...')
          }
        } else if (s.status === 'complete') {
          setProgress(100, 'Character ready!')
          // The LoRA file just landed in models/loras — drop the node cache so
          // the Use shelf and the LoRA picker list it without a restart.
          clearNodeCache()
          useCreateStore.getState().bumpCharactersVersion()
          useCreateStore.getState().setCharacterTab('use')
          return
        } else if (s.status === 'cancelled') {
          return
        } else {
          setError(`Training failed. ${s.logs.slice(-3).join(' ')}`.slice(0, 420))
          return
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Training could not start.')
    } finally {
      trainingActive.current = false
      useCreateStore.getState().setIsGenerating(false)
      useCreateStore.getState().setProgress(0)
      // The chat model comes back the way it does after a render: fire and
      // forget, the reload must not hold the Create UI.
      if (trainingEviction) void restoreChatBackendsAfterRender(trainingEviction)
    }
  }, [])

  const generateInner = useCallback(async () => {
    const state = useCreateStore.getState()
    // AI-CSAM gate — applies before any backend is touched. On this path there
    // is no server gate behind it: a local render goes straight to ComfyUI/MLX
    // on the user's own machine. triggerWord is in here because local character
    // training runs through this same function a few lines down, and the cloud
    // gate already treats that field as prompt-bearing (useCloudCreate.ts).
    //
    // musicLyrics used to be left out on the premise that music is hosted only
    // and cannot reach this path. It can and it does: the local audio lane
    // hands `lyrics: state.musicLyrics` to buildLocalOpWorkflow a few hundred
    // lines below. Every field that carries user text to a render is gated on
    // both paths, and the two lists have to stay identical (review
    // 2026-08-14).
    {
      const verdict = checkPromptSafety(
        `${state.prompt} ${state.negativePrompt} ${state.musicLyrics} ${state.triggerWord}`,
      )
      if (verdict.blocked) {
        state.setError(SAFETY_BLOCK_MESSAGE)
        return
      }
    }
    // Character-Studio train surface books the local trainer instead of a
    // render; the use surface falls through to the plain image path (the
    // selected character LoRA rides the normal selectedLoras chain).
    if (state.cloudOp === 'character' && state.characterTab === 'train') {
      await runCharacterTraining()
      return
    }
    const {
      mode, prompt, negativePrompt, imageModel, videoModel,
      sampler, scheduler, steps, cfgScale, width, height, seed, batchSize, frames, fps, denoise,
      hiresFixEnabled, hiresScale, hiresDenoise, hiresSteps, hiresUpscaleMethod, i2iImage, i2vImage,
      source, mask, growMaskBy, removebg, selectedLoras, selectedVae, clipSkip,
      setIsGenerating, setProgress, setCurrentPromptId, setError, addToGallery, addToPromptHistory,
    } = state

    // The dice are thrown here, once, and the number travels with the run.
    // Every builder used to roll its own -1 internally and keep the result to
    // itself, so the gallery wrote 0 and no image could ever be reproduced
    // (#110). A concrete seed also stops those builders from re-rolling.
    const runSeed = resolveRunSeed(seed)

    const isI2I = mode === 'image' && state.imageSubMode === 'img2img'
    // Which redesign intent produced this run (gallery tag).
    const intent = state.intent()
    // The redesigned Create page drives its unified Stage input via `source`/`mask`
    // ImageRefs. On the local path their `.filename` IS the ComfyUI /upload/image
    // name, so they map straight onto the existing i2iImage/i2vImage handles.
    const effInputImage = source?.filename ?? i2iImage
    const effI2vImage = source?.filename ?? i2vImage
    const maskFilename = mask?.filename
    const isRemoveBg = mode === 'image' && removebg

    // ── 2.5.8 specialized local lanes. music / lipsync / motion build their
    // own core-node graphs (buildLocalOpWorkflow); extend rides the regular
    // I2V flow below — its source IS the extracted last frame. character
    // trained already branched off above (Rust musubi trainer); its use
    // surface is a plain image generate with the LoRA active. ──
    const localOp =
      state.cloudOp === 'music' || state.cloudOp === 'lipsync' || state.cloudOp === 'motion'
        ? state.cloudOp
        : null
    const localOpList =
      localOp === 'music' ? state.audioModelList
      : localOp === 'lipsync' ? state.lipsyncModelList
      : localOp === 'motion' ? state.motionModelList
      : []
    const localOpModel = localOp ? resolveLocalOpPick(state.localOpModel, localOpList) : ''

    // Chip↔run agreement for IMAGE, the same rule the video path already
    // applies further down. ModelChip shows `list[0]` whenever the stored pick
    // isn't in the current list — which includes the empty pick a fresh
    // profile has. Reading the raw store here meant a first-run Mac saw
    // "MLX SD Turbo" in the picker, pressed Create, and got
    // "No image model selected. Add checkpoints or FLUX models to ComfyUI."
    // — a ComfyUI message on the one platform that never runs ComfyUI.
    const effImageModel =
      state.imageModelList.some((m) => m.name === imageModel)
        ? imageModel
        : (state.imageModelList[0]?.name ?? imageModel)

    // ── MLX image pipeline (Apple Silicon) — hard rule: Mac local image is the
    // in-process MLX path, never ComfyUI. Gated on the derived `image` intent
    // (which already means: no cloudOp, no utilityOp, no removebg, text2img)
    // AND on the SELECTED model being a synthetic MLX entry, so a real ComfyUI
    // checkpoint from a manual install is never hijacked. Generation returns a
    // base64 PNG stored as a data URL on the gallery item, so display +
    // download work with no ComfyUI /view route. ──
    if (intent === 'image' && isMlxImageHost() && isMlxImageModel(effImageModel)) {
      setError(null)
      if (!prompt.trim()) { setError('Please enter a prompt.'); return }
      setIsGenerating(true)
      state.setProgressPhase('loading-model')
      setProgress(10, 'Starting MLX image generation...')
      addToPromptHistory(prompt)
      const startTime = Date.now()
      try {
        state.setProgressPhase('sampling')
        setProgress(40, 'Generating with MLX...')
        const { dataUrl, width: outW, height: outH, localPath } = await generateMlxImageDataUrl({
          prompt, steps, seed: runSeed, width, height,
          model: mlxModelIdFor(effImageModel),
          negativePrompt: negativePrompt || undefined,
        })
        const elapsed = Math.round((Date.now() - startTime) / 1000)
        state.setProgressPhase('complete')
        setProgress(100, 'Complete!')
        state.setLastGenTime(`${elapsed}s`)
        addToGallery({
          id: uuid(), type: 'image', filename: `mlx-${Date.now()}.png`, subfolder: '',
          // localPath is what survives the restart: partialize strips dataUrl,
          // and there is no ComfyUI /view to fall back to on a Mac.
          dataUrl, localPath, prompt, negativePrompt, model: imageModel, modelType: 'unknown',
          seed: runSeed, steps, cfgScale, sampler, scheduler,
          width: outW || width, height: outH || height, batchSize: 1,
          createdAt: Date.now(), builderUsed: 'dynamic', intent,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        useCreateStore.getState().setError(`Generation failed: ${msg}`)
      } finally {
        useCreateStore.getState().setIsGenerating(false)
        useCreateStore.getState().setProgress(0)
      }
      return
    }

    // ── MLX video pipeline (Apple Silicon) — hard rule: Mac local video is the
    // in-process mlx-video path, never ComfyUI. Unlike the image branch this
    // needs no model-name marker: on Mac the video picker IS the MLX catalog
    // (fetchModels above), so every local video generation routes here. Gated
    // on the derived `video` intent, which is text-to-video by definition —
    // animate/extend/motion have no local lane on this host (the IntentBar
    // shows them hidden / as cloud teasers), and their source images are staged
    // through a ComfyUI upload that doesn't exist here. Generation is a
    // subprocess polled via video_progress every 2s (no WebSocket/node graph). ──
    if (intent === 'video' && isMlxImageHost()) {
      setError(null)
      if (!prompt.trim()) { setError('Please enter a prompt.'); return }
      if (!videoModel) { setError('No local video model selected — pick one from the model picker.'); return }
      const catalogId = mlxVideoModelIdFor(videoModel)
      if (!catalogId) { setError(`Unknown MLX video model "${videoModel}" — re-select it from the picker.`); return }
      try {
        const status = await getVideoStatus()
        if (!status.available) { setError('Local video generation is Apple Silicon only.'); return }
        if (!status.mlxInstalled) { setError('The local video engine is not set up on this Mac yet (a one-time setup is needed before local video works).'); return }
        if (!status.installedModels.includes(catalogId)) { setError(`The local video model "${videoModel}" isn't downloaded yet.`); return }
      } catch (e) {
        setError(`Local video status check failed: ${e instanceof Error ? e.message : String(e)}`)
        return
      }

      setIsGenerating(true)
      state.setProgressPhase('loading-model')
      setProgress(0, 'Starting MLX video generation...')
      addToPromptHistory(prompt)
      const startTime = Date.now()
      abortRef.current = new AbortController()
      let result: Awaited<ReturnType<typeof generateVideo>>
      try {
        result = await generateVideo({
          id: catalogId,
          prompt,
          seconds: Math.max(0.5, frames / Math.max(1, fps)),
          fps,
          seed: runSeed,
        })
      } catch (e) {
        useCreateStore.getState().setError(`Failed to start: ${e instanceof Error ? e.message : String(e)}`)
        useCreateStore.getState().setIsGenerating(false)
        abortRef.current = null
        return
      }
      try {
        state.setProgressPhase('sampling')
        await new Promise<void>((resolve, reject) => {
          const tick = async () => {
            if (abortRef.current?.signal.aborted) {
              try { await cancelVideo() } catch { /* already finished/gone */ }
              reject(new Error('Cancelled'))
              return
            }
            // Safety net (David: the machine glowed for hours). Local MLX video
            // is slow — tens of minutes — so give it a full hour, but never
            // poll forever. On the cap, KILL the mlx-video subprocess so it
            // stops pinning the machine; before this it kept running after the
            // UI had given up.
            if (Date.now() - startTime > 60 * 60 * 1000) {
              try { await cancelVideo() } catch { /* already finished/gone */ }
              reject(new Error('Generation timed out after 60 minutes'))
              return
            }
            try {
              const prog = await getVideoProgress()
              const elapsed = Math.round((Date.now() - startTime) / 1000)
              setProgress(Math.min(95, elapsed * 2), `Generating with MLX... ${elapsed}s`)
              if (prog.status === 'complete') {
                setProgress(100, 'Complete!')
                useCreateStore.getState().setLastGenTime(`${elapsed}s`)
                // The mp4 lives on disk only (no ComfyUI /view route here) —
                // read it via the guarded `read_media_file` Rust command and
                // hand the frontend a `blob:` URL, which the CSP's media-src
                // allows (unlike `data:`). Reuse `dataUrl`: galleryItemUrl() /
                // OutputView / Lightbox / download already prefer it over the
                // ComfyUI /view path, and a blob: URL is just a string src as
                // far as <video>/fetch are concerned.
                let dataUrl: string | undefined
                try {
                  dataUrl = await readVideoAsBlobUrl(result.output)
                } catch (e) {
                  console.error('read_media_file failed for MLX video output', e)
                }
                addToGallery({
                  id: uuid(), type: 'video', filename: '', subfolder: '',
                  dataUrl,
                  // Keep the real on-disk path too, for a future
                  // download-to-disk path that wants to reference it directly.
                  localPath: result.output,
                  prompt, negativePrompt, model: videoModel, modelType: 'wan',
                  seed: runSeed, steps, cfgScale, sampler, scheduler,
                  width, height, batchSize: 1,
                  createdAt: Date.now(), builderUsed: 'dynamic', intent,
                })
                resolve()
                return
              }
              if (prog.status === 'error') {
                reject(new Error(prog.error || 'local video generation failed'))
                return
              }
              setTimeout(tick, 2000)
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)))
            }
          }
          tick()
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg !== 'Cancelled') useCreateStore.getState().setError(`Generation failed: ${msg}`)
      } finally {
        useCreateStore.getState().setIsGenerating(false)
        useCreateStore.getState().setProgress(0)
        abortRef.current = null
      }
      return
    }

    setError(null)
    let activeModel = localOp ? localOpModel : (mode === 'image' ? effImageModel : videoModel)
    // Chip↔run agreement (live-caught on the extend E2E): the picker DISPLAYS
    // the first capable model when the stored pick can't run the current
    // intent, but submit read the raw store — the run then used a model the
    // user never saw. Apply the picker's coercion here too (same one-rule
    // philosophy as the cloud op resolver after take-01).
    if (!localOp && mode === 'video' && state.videoModelList.length > 0) {
      const capable = videoLaneModels(state.videoModelList, intent)
      if (capable.length > 0 && !capable.some((m) => m.name === activeModel)) {
        activeModel = capable[0].name
      }
    } else if (!localOp && mode === 'video' && !canRunVideoIntent(activeModel, intent)) {
      // The list has not arrived yet (fresh boot, ComfyUI still waking). The
      // coercion above cannot run, and a persisted pick the lane cannot use
      // must not reach the builder: that is how a T2V run right after app
      // start went out as SVD's LoadImage graph and ComfyUI answered
      // "Node 2 (LoadImage): Custom validation failed" while the chip already
      // showed a capable model (David 2026-08-02).
      setError('Video models are still loading. Give it a few seconds and hit Create again.')
      return
    }
    // Always re-classify from model name to avoid stale type
    const imageModelType = classifyModel(activeModel)

    // Background removal is prompt-free and model-independent (RMBG node);
    // lipsync/motion drive off their media inputs (the builder supplies a
    // neutral scene prompt when the field is empty).
    const promptOptional = isRemoveBg || localOp === 'lipsync' || localOp === 'motion'
    if (!promptOptional && !prompt.trim()) {
      setError(localOp === 'music' ? 'Describe the track first. Genre, mood, tempo…' : 'Please enter a prompt.')
      return
    }
    if (isRemoveBg && !effInputImage) {
      setError('Please add an image to remove its background.')
      return
    }
    if (!localOp && isI2I && !isRemoveBg && !effInputImage) {
      setError('Please add a source image first.')
      return
    }
    // No mask-required gate on Edit. In 2.5.8 this lane was inpaint-only and
    // the guard existed because an empty mask SILENTLY became plain img2img and
    // repainted the whole picture. 2.5.9 renamed the lane "Edit / Image to
    // Image" and states the rule on the canvas ("leave the mask empty to
    // restyle the whole image, or paint an area to change just that"), so that
    // path is now the advertised behaviour rather than a surprise — and the
    // guard was refusing exactly what the copy above it promises. The builder
    // already routes it correctly: no mask means isInpaint is false and the
    // request falls into the LoadImage → VAEEncode → KSampler(denoise) i2i
    // branch, driven by the Edit strength slider.
    if (!isRemoveBg && !activeModel) {
      if (localOp === 'music') {
        setError('No music model installed. Use Download & install above to get ACE Step, then generate.')
      } else if (localOp === 'lipsync') {
        setError('No talking character model installed. Use Download & install above to get Wan 2.2 S2V.')
      } else if (localOp === 'motion') {
        setError('No motion model installed. Use Download & install above to get Wan Animate or VACE.')
      } else {
        setError(mode === 'image'
          ? 'No image model selected. Add checkpoints or FLUX models to ComfyUI.'
          : 'No video model selected. Install Wan 2.1 or AnimateDiff models.')
      }
      return
    }
    // Lane input guards — reject-and-report before anything uploads.
    if (localOp === 'lipsync') {
      if (!source?.filename) {
        setError('Add the portrait the character should speak from.')
        return
      }
      if (!state.audioInput) {
        setError('Add a voice first. Upload or record the speech audio.')
        return
      }
    }
    if (localOp === 'motion') {
      if (!source?.filename) {
        setError('Add the character image that should perform the motion.')
        return
      }
      if (!state.videoInput) {
        setError('Add the driving video whose motion the character should copy.')
        return
      }
    }
    // Animate (local I2V, restored 2026-07-17) + extend (2.5.8 — continues a
    // clip from its extracted last frame): reject-and-report instead of
    // feeding a start image to a t2v-only checkpoint — that either errors in
    // ComfyUI or silently ignores the source. The ModelChip already filters
    // the picker; this guards a stale store selection reaching submit.
    if (intent === 'animate' || intent === 'extend') {
      if (!effI2vImage) {
        setError(intent === 'extend'
          ? 'Pick the clip to extend first. Its last frame becomes the starting point.'
          : 'Add the image you want to animate first.')
        return
      }
      if (!isI2VModel(activeModel)) {
        setError(`${activeModel} is text-to-video only. Pick an i2v-capable model (WAN i2v / WAN 2.2 ti2v / SVD / LTX) to ${intent === 'extend' ? 'extend a clip' : 'animate an image'}.`)
        return
      }
    }

    // R16 Befund 5: this used to be a bare probe with the line "ComfyUI is not
    // running. Wait for it to start." Nothing was waiting to start it. LU
    // starts ComfyUI at app launch and never again, so a ComfyUI killed
    // mid-session stayed dead, and the box sat on that sentence for ten
    // minutes with port 8188 shut. If LU started it, LU restarts it, and if it
    // is not LU's to start, the line says so instead of promising an actor
    // that does not exist.
    //
    // The waiting area is opened BEFORE the guard runs, because a restart can
    // take a minute and the line explaining it has to be somewhere the user
    // can read it.
    setIsGenerating(true)
    setProgress(0, 'Checking ComfyUI...')
    const guard = await ensureComfyForRender({
      probe: () => checkComfyConnection(),
      status: () => backendCall<ComfyGuardStatus>('comfyui_status').catch(() => null),
      start: async () => { await backendCall('start_comfyui') },
      onProgress: (line) => setProgress(0, line),
    })
    if (guard === 'unmanaged' || guard === 'failed') {
      setIsGenerating(false)
      setProgress(0)
      setError(comfyGuardMessage(guard))
      return
    }

    setProgress(0, 'Preparing workflow...')
    abortRef.current = new AbortController()

    // Make VRAM room for the render. On a single local GPU a resident chat LLM
    // (Ollama / LM Studio / the bundled engine) squats the card, which forces
    // ComfyUI into heavy CPU offload, or a CUDA OOM on the 14B video lanes
    // (S2V / Animate). Z36: this used to be a bare offload_local_models call
    // that killed both llama processes with no KV save and no reload, costing
    // the next chat turn a 62 s cold start. The hand-off helper captures what
    // is resident, saves the built-in engine's KV slot, then evicts; the
    // finally below brings everything back. exclusiveVramMode 'never' skips
    // the eviction. Best-effort, never blocks a render.
    let renderEviction: RenderEviction | null = null
    try {
      renderEviction = await evictChatBackendsForRender()
    } catch { /* VRAM housekeeping is best-effort */ }

    try {
      let outputWidth = width
      let outputHeight = height
      const baseParams = {
        prompt, negativePrompt, model: activeModel, sampler, scheduler, steps, cfgScale, width, height, seed: runSeed, batchSize,
        ...(isRemoveBg && effInputImage ? { removebg: true, inputImage: effInputImage } : {}),
        ...(isI2I && !isRemoveBg && effInputImage ? { inputImage: effInputImage, denoise } : {}),
        ...(!isRemoveBg && maskFilename ? { maskImage: maskFilename, growMaskBy } : {}),
        // Advanced adjustments. LoRA feeds the builder's `lora`/`loraStrength`
        // contract (string[] + number[]); the old `loras` key was read by nobody,
        // so LoRA selection was a silent no-op for image too (D#80). VAE/clip-skip
        // stay image-only (the builder ignores them for video).
        ...(selectedLoras.length
          ? { lora: selectedLoras.map((l) => l.name), loraStrength: selectedLoras.map((l) => l.strength) }
          : {}),
        ...(selectedVae && selectedVae !== 'auto' ? { vae: selectedVae } : {}),
        ...(clipSkip > 0 ? { clipSkip } : {}),
      }

      let workflow: ComfyApiGraph = {}
      let builderUsed: 'dynamic' | 'legacy' | 'custom' = 'dynamic'

      // ── Specialized-lane graphs: stage the media inputs in ComfyUI's input
      // dir, then build the lane's core-node workflow. No custom-workflow or
      // legacy fallback here — REJECT-AND-REPORT via WorkflowUnavailableError
      // is the whole point (an "Update ComfyUI" message instead of a broken
      // graph). ──
      if (localOp) {
        let audioFile: string | undefined
        let drivingVideo: string | undefined
        let laneFrames = mode === 'video' ? frames : 0
        if (localOp === 'lipsync' && state.audioInput) {
          setProgress(3, 'Uploading the voice audio...')
          audioFile = await uploadMediaFile(state.audioInput.blob, state.audioInput.name)
          // Size the clip to the speech: a fixed 77 frames would cut a longer
          // voice mid-sentence. Cap at ~7.5s (121 frames @16fps) so a long
          // narration doesn't quietly queue a 10-minute render on 12 GB.
          const audioSeconds = await new Promise<number>((resolve) => {
            const probe = new Audio()
            const objUrl = URL.createObjectURL(state.audioInput!.blob)
            probe.preload = 'metadata'
            probe.onloadedmetadata = () => { URL.revokeObjectURL(objUrl); resolve(probe.duration || 0) }
            probe.onerror = () => { URL.revokeObjectURL(objUrl); resolve(0) }
            probe.src = objUrl
          })
          if (audioSeconds > 0 && Number.isFinite(audioSeconds)) {
            laneFrames = Math.min(121, Math.max(25, Math.round(audioSeconds * (fps || 16)) + 1))
          }
        }
        if (localOp === 'motion' && state.videoInput) {
          setProgress(3, 'Uploading the driving video...')
          drivingVideo = await uploadMediaFile(state.videoInput.blob, state.videoInput.name)
        }
        setProgress(5, 'Building workflow...')
        const laneDefaults = COMFY_MODEL_DEFAULTS[imageModelType] ?? COMFY_MODEL_DEFAULTS.unknown
        workflow = await buildLocalOpWorkflow({
          op: localOp,
          model: activeModel,
          prompt,
          negativePrompt,
          seed: runSeed, steps, cfgScale, sampler, scheduler,
          // The shared width/height/frames sliders follow the picked model via
          // setLocalOpModel; fall back to the architecture defaults when a
          // stale persisted value would be off-grid for the lane.
          width: width || laneDefaults.width,
          height: height || laneDefaults.height,
          frames: laneFrames || laneDefaults.frames,
          fps: mode === 'video' ? fps : laneDefaults.fps,
          seconds: state.musicDuration,
          lyrics: state.musicLyrics,
          audioFile,
          refImage: source?.filename || undefined,
          drivingVideo,
        })
        builderUsed = 'dynamic'
      }

      // Check for custom workflow assignment — but verify it's compatible with the model
      let customWf = localOp ? null : useWorkflowStore.getState().getWorkflowForModel(activeModel, imageModelType)
      if (customWf) {
        const wfNodes = apiNodes(customWf.workflow).map(([, n]) => n.class_type)
        const needsUnet = imageModelType === 'flux' || imageModelType === 'flux2' || imageModelType === 'zimage' || imageModelType === 'wan' || imageModelType === 'hunyuan'
        const hasUnet = wfNodes.includes('UNETLoader')
        const hasCheckpoint = wfNodes.includes('CheckpointLoaderSimple')
        if (needsUnet && !hasUnet && hasCheckpoint) {
          console.warn('[useCreate] Custom workflow incompatible: model needs UNETLoader but workflow has CheckpointLoaderSimple. Using auto.')
          customWf = null
        } else if (!needsUnet && hasUnet && !hasCheckpoint) {
          console.warn('[useCreate] Custom workflow incompatible: model needs CheckpointLoaderSimple but workflow has UNETLoader. Using auto.')
          customWf = null
        }
      }
      console.log('[useCreate] Custom workflow check:', { activeModel, imageModelType, found: customWf?.name ?? 'NONE (auto)' })

      if (customWf) {
        builderUsed = 'custom'
        setProgress(5, `Using workflow: ${customWf.name}...`)
        const params = mode === 'video' ? { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}) } : baseParams
        workflow = await injectParameters(customWf.workflow, customWf.parameterMap, params, imageModelType)
      } else if (!localOp) {
        // Dynamic workflow builder — auto-detects nodes and builds the right pipeline
        setProgress(5, 'Building workflow...')
        try {
          const genParams = mode === 'video' ? { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}) } : baseParams
          workflow = await buildDynamicWorkflow(genParams, imageModelType)
          builderUsed = 'dynamic'
        } catch (dynErr) {
          // A WorkflowUnavailableError carries an actionable message ("download
          // <encoder> from the Model Manager") — surface it directly instead of
          // falling back to a legacy builder that would fail the same way with
          // a cryptic ComfyUI rejection.
          if (dynErr instanceof Error && dynErr.name === 'WorkflowUnavailableError') {
            throw dynErr
          }
          // Fallback to legacy builders if dynamic fails
          console.warn('[useCreate] Dynamic builder failed, using legacy:', dynErr)
          builderUsed = 'legacy'
          setProgress(5, 'Using legacy builder...')
          if (mode === 'video') {
            workflow = await buildTxt2VidWorkflow({ ...baseParams, frames, fps }, videoBackend)
          } else {
            workflow = await buildTxt2ImgWorkflow(baseParams, imageModelType)
          }
        }
        // Bug A (v2.4.5 — miguelkodoatie Discord 2026-05-14, Turbulent_Tomato7559
        // Reddit 2026-05-10): when ComfyUI lacks VHS_VideoCombine the video
        // workflow falls back to SaveAnimatedWEBP and produces an animated
        // .webp instead of an .mp4. v2.4.4 added a warning banner; v2.4.5
        // turns it into a blocking modal with a one-click install, so users
        // get actual videos instead of trying to figure out why "video gen"
        // gave them an image.
        if (mode === 'video' && builderUsed === 'dynamic') {
          try {
            const caps = await checkVideoOutputCapability()
            if (caps.webpOnly) {
              const choice = await new Promise<'install' | 'webp' | 'cancel'>((resolve) => {
                useCreateStore.getState().setVhsInstallPrompt(resolve)
              })
              useCreateStore.getState().setVhsInstallPrompt(null)

              if (choice === 'cancel') {
                setIsGenerating(false)
                setProgress(0, '')
                return
              }
              if (choice === 'install') {
                setProgress(8, 'Installing VHS_VideoCombine (git clone + pip)...')
                try {
                  await installCustomNodes(['videohelpersuite'])
                  setProgress(9, 'Restarting ComfyUI to register the new node...')
                  // Shared with the Create surface on purpose. The version that
                  // used to live here trusted "something answers on the port"
                  // as proof of a restart, which is exactly wrong when the
                  // engine was started outside LU: the old process keeps the
                  // port and its old node list, and the error below then sent
                  // people hunting an IMPORT FAILED line nobody ever wrote.
                  await restartComfyForNewNodes()
                  // Wait for ComfyUI to come back; poll /object_info up to 30s
                  let backUp = false
                  for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 2000))
                    try {
                      const ok = await checkComfyConnection()
                      if (ok) { backUp = true; break }
                    } catch { /* not yet */ }
                  }
                  if (!backUp) {
                    setError('VHS_VideoCombine installed but ComfyUI did not come back online within 30s. Please restart ComfyUI manually and re-generate.')
                    setIsGenerating(false)
                    return
                  }
                  // #72 (bob): the node catalogue is cached for 5 minutes, so
                  // without a forced refresh the rebuild below still saw the
                  // pre-install catalogue (no VHS) and silently produced a
                  // .webp even after a successful install + restart.
                  clearNodeCache()
                  const capsAfter = await checkVideoOutputCapability()
                  if (!capsAfter.mp4Capable) {
                    setError(
                      'VHS_VideoCombine was installed and ComfyUI restarted, but ComfyUI still does not list the node. ' +
                      'Check the ComfyUI startup log for "IMPORT FAILED: ComfyUI-VideoHelperSuite" (usually a Python requirements problem), then generate again.'
                    )
                    setIsGenerating(false)
                    return
                  }
                  // Re-build the workflow now that the new node is available
                  const genParams = { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}) }
                  workflow = await buildDynamicWorkflow(genParams, imageModelType)
                  setProgress(10, 'VHS installed, generating MP4...')
                } catch (instErr) {
                  setError(`Failed to install VHS_VideoCombine: ${instErr instanceof Error ? instErr.message : String(instErr)}. You can install it manually in ComfyUI Manager.`)
                  setIsGenerating(false)
                  return
                }
              } else {
                // 'webp' — user opted to continue with the animated .webp
                setProgress(8, 'Continuing with animated .webp output (no VHS_VideoCombine)')
              }
            }
          } catch { /* non-fatal */ }
        }
      }

      // Native HiRes is a graph transform, not a special workflow. Apply
      // it after Auto/custom workflow construction so the same switch works on
      // every compatible local text-to-image graph. Unsupported custom graphs
      // fail with an actionable message rather than silently ignoring the knob.
      if (hiresFixEnabled && intent === 'image') {
        setProgress(8, 'Adding native HiRes Fix...')
        const hires = applyNativeHiresFix(workflow, {
          baseWidth: width,
          baseHeight: height,
          scale: hiresScale,
          denoise: hiresDenoise,
          steps: hiresSteps,
          upscaleMethod: hiresUpscaleMethod,
        })
        workflow = hires.workflow
        outputWidth = hires.width
        outputHeight = hires.height
      }

      // Open the progress socket BEFORE the submit, and remember where the
      // stream stands, because ComfyUI starts executing the instant the submit
      // lands and addresses this run's frames at our client id alone.
      //
      // R16 Befund 1: the connect used to sit AFTER the submit. On the first
      // render of an app run that costs a dynamic import, two Tauri listener
      // registrations and the Rust websocket handshake, and every frame
      // ComfyUI sent in that window went to a socket that did not exist yet.
      // ComfyUI buffers nothing, so the three load lines (model, text encoder,
      // VAE) were simply gone, and the waiting area showed nothing at all
      // until the render was 34 s old. From the second render on the socket
      // was already up, the connect returned at once, and the lines appeared,
      // which is why this only ever hit the first picture after a start.
      //
      // The mark closes the rest of the window: the listener below cannot be
      // registered until the submit has returned the prompt id it filters on,
      // so anything that arrives in between is replayed instead of raced for.
      const maxTime = mode === 'video' ? 60 * 60 * 1000 : 20 * 60 * 1000
      let useWS = false
      let wsMark = 0
      try {
        await comfyWS.connect(3000)
        useWS = true
        wsMark = comfyWS.mark()
      } catch {
        console.warn('[useCreate] WebSocket unavailable, using polling fallback')
      }

      setProgress(10, 'Submitting to ComfyUI...')
      let promptId: string
      try {
        promptId = await submitWorkflow(workflow, CLIENT_ID)
      } catch (err) {
        setError(`Failed to submit: ${err instanceof Error ? err.message : String(err)}`)
        setIsGenerating(false)
        return
      }
      setCurrentPromptId(promptId)
      addToPromptHistory(prompt)

      // Build node ID → class_type map from workflow for phase detection
      const nodeClassMap = new Map<string, string>()
      // `apiNodes` IS the "is this an object with a class_type" test, and it
      // hands back the class name already narrowed to a string — the old
      // version wrote a non-string class_type into a Map<string, string>.
      for (const [nodeId, node] of apiNodes(workflow)) {
        nodeClassMap.set(nodeId, node.class_type)
      }

      // Ask which device ComfyUI is on while the render is still healthy: both
      // stall watchdogs below fire from a timer and cannot await anything, and
      // a stall message that never names the processor is the reason an AMD
      // customer blames his settings for a hardware switch.
      void cpuRenderFacts()

      if (useWS) {
        // ── WebSocket-driven progress ──
        await new Promise<void>((resolve, reject) => {
          const startTime = Date.now()
          const store = useCreateStore.getState()
          // The bar and its seconds used to repaint only when ComfyUI sent an
          // event. Long silent stretches are normal here (a 14B sampling step
          // or a VAE decode on a full card emits nothing for minutes), so the
          // label froze mid-run: David watched "Decoding... 266s" stand still
          // for 10+ minutes while the GPU sat at 100% (2026-08-02). Events now
          // only change phase and percent; a ticker repaints the elapsed time
          // every second so a working render never looks hung.
          let phasePct = 10
          let phaseLabel = 'Queued...'
          const paint = () => {
            const elapsed = Math.round((Date.now() - startTime) / 1000)
            setProgress(phasePct, `${phaseLabel} ${elapsed}s`)
          }
          const setPhase = (pct: number, label: string) => {
            phasePct = pct
            phaseLabel = label
            paint()
          }
          store.setProgressPhase('queued')
          setPhase(10, 'Queued...')
          const ticker = setInterval(paint, 1000)

          // Activity watchdog (2.5.8): the old hard wall-clock cap killed a
          // REAL render at exactly 60 minutes while ComfyUI was still
          // sampling (live-caught on the extend lane: 3060 + TI2V-5B, file
          // landed on disk seconds after the app gave up). maxTime now bounds
          // the SILENT gap — every WS event for our prompt, and a still-queued
          // prompt on the periodic check, count as life signs.
          let lastActivity = Date.now()
          const timeoutTimer = setInterval(() => {
            if (Date.now() - lastActivity > maxTime) {
              cleanup()
              reject(new Error(`Generation stalled: no progress from ComfyUI for ${Math.round(maxTime / 60000)} minutes.${cpuCauseSuffix(lastCpuRenderFacts())}`))
            }
          }, 15000)

          // Heartbeat: check ComfyUI every 10s + poll for completion (catches missed WS events)
          let completionHandled = false
          let queueCheckCounter = 0
          const heartbeat = setInterval(async () => {
            if (completionHandled) return
            const alive = await checkComfyConnection()
            if (!alive) { cleanup(); reject(new Error('ComfyUI stopped responding during generation')); return }
            // A prompt still in ComfyUI's queue is alive even when the socket
            // goes quiet (long model loads emit no events) — refresh the
            // watchdog once a minute from the queue itself.
            queueCheckCounter += 1
            if (queueCheckCounter >= 6) {
              queueCheckCounter = 0
              if (await isPromptQueued(promptId).catch(() => false)) lastActivity = Date.now()
            }
            // Poll history to catch completion if WebSocket event was missed
            try {
              const history = await getHistory(promptId)
              if (!history) return
              const statusStr = history.status?.status_str
              if (statusStr === 'success') {
                completionHandled = true
                console.log('[useCreate] Completion detected via polling (WS event missed)')
                cleanup()
                useCreateStore.getState().setProgressPhase('complete')
                setProgress(95, 'Fetching results...')
                const messages = historyMessages(history)
                const startMsg = messages.find(([t]) => t === 'execution_start')
                const endMsg = messages.find(([t]) => t === 'execution_success')
                const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                  ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1) : null
                setProgress(100, 'Complete!')
                useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)
                const outputs = history.outputs ?? {}
                let found = false
                for (const nodeId of Object.keys(outputs)) {
                  // Extract files from ANY keyed array, not just images/gifs/
                  // videos — custom save nodes post under other keys (audio,
                  // result, files, …); previously those outputs were dropped
                  // even though they existed on disk.
                  const files: ComfyUIOutput[] = extractComfyOutputFiles(outputs[nodeId])
                  for (const file of files) {
                    found = true
                    addToGallery({
                      id: uuid(), type: galleryTypeForFile(file.filename, mode),
                      filename: file.filename, subfolder: file.subfolder ?? '', comfyType: file.type ?? 'output',
                      prompt, negativePrompt, model: activeModel,
                      modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                      seed: runSeed,
                      steps, cfgScale, sampler, scheduler, width: outputWidth, height: outputHeight, batchSize,
                      createdAt: Date.now(), builderUsed, intent,
                    })
                  }
                }
                if (!found) setError('Generation completed but no output was produced.')
                resolve()
              } else if (statusStr === 'error') {
                completionHandled = true
                cleanup()
                const msgs = historyMessages(history)
                const errEntry = msgs.find(([t]) => t === 'execution_error')?.[1]
                const raw = errEntry?.exception_message || 'ComfyUI execution error'
                const hint = comfyErrorHint(errEntry?.node_type, errEntry?.exception_type, String(raw))
                reject(new Error(hint ? `${raw}\n\n${hint}` : raw))
              }
            } catch { /* polling failure is non-fatal */ }
          }, 10000)

          let abortCheck: ReturnType<typeof setInterval> | null = null

          const cleanup = () => {
            clearInterval(ticker)
            clearInterval(timeoutTimer)
            clearInterval(heartbeat)
            if (abortCheck) clearInterval(abortCheck)
            removeListener()
          }

          // `wsMark` was taken before the submit, so the frames ComfyUI sent
          // while this closure was being built are handed over first.
          const removeListener = comfyWS.on((event: ComfyWSEvent) => {
            // Only handle events for our prompt
            if ('prompt_id' in event.data && event.data.prompt_id !== promptId) return
            lastActivity = Date.now()

            const st = useCreateStore.getState()

            switch (event.type) {
              case 'executing': {
                const nodeId = event.data.node
                if (nodeId === null) {
                  // null node means execution finished for this prompt
                  break
                }
                const classType = nodeClassMap.get(nodeId) || ''
                const step = phaseForExecutingNode(classType, mode === 'video' ? 'video' : 'image')
                if (step) {
                  st.setProgressPhase(step.phase)
                  setPhase(step.pct, step.label)
                }
                break
              }
              case 'progress': {
                const { value, max } = event.data
                const step = phaseForProgressStep(value, max, st.progressPhase)
                if (step) {
                  st.setProgressPhase(step.phase)
                  setPhase(step.pct, step.label)
                }
                break
              }
              case 'execution_complete': {
                if (completionHandled) break
                completionHandled = true
                cleanup()
                st.setProgressPhase('complete')
                setProgress(95, 'Fetching results...')
                // Fetch history to get output files
                getHistory(promptId).then(history => {
                  if (!history) { setError('No history found after completion.'); resolve(); return }
                  const messages = historyMessages(history)
                  const startMsg = messages.find(([t]) => t === 'execution_start')
                  const endMsg = messages.find(([t]) => t === 'execution_success')
                  const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                    ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1) : null
                  setProgress(100, 'Complete!')
                  useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)
                  const outputs = history.outputs ?? {}
                  let found = false
                  for (const nodeId of Object.keys(outputs)) {
                    // Same generic extraction as the heartbeat branch above.
                    const files: ComfyUIOutput[] = extractComfyOutputFiles(outputs[nodeId])
                    for (const file of files) {
                      found = true
                      addToGallery({
                        id: uuid(), type: galleryTypeForFile(file.filename, mode),
                        filename: file.filename, subfolder: file.subfolder ?? '', comfyType: file.type ?? 'output',
                        prompt, negativePrompt, model: activeModel,
                        modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                        seed: runSeed,
                        steps, cfgScale, sampler, scheduler, width: outputWidth, height: outputHeight, batchSize,
                        createdAt: Date.now(), builderUsed,
                      })
                    }
                  }
                  if (!found) setError('Generation completed but no output was produced. Check ComfyUI logs.')
                  resolve()
                }).catch(() => { resolve() })
                break
              }
              case 'execution_error': {
                cleanup()
                const msg = event.data.exception_message || 'Unknown ComfyUI error'
                const nodeType = event.data.node_type ? ` (${event.data.node_type})` : ''
                const hint = comfyErrorHint(event.data.node_type, event.data.exception_type, msg)
                reject(new Error(msg.trim() + nodeType + (hint ? `\n\n${hint}` : '')))
                break
              }
            }
          }, wsMark)

          // Also check abort
          abortCheck = setInterval(() => {
            if (abortRef.current?.signal.aborted) {
              cleanup()
              reject(new Error('Cancelled'))
            }
          }, 500)
        })
      } else {
        // ── Polling fallback (original approach) ──
        await new Promise<void>((resolve, reject) => {
          let attempts = 0
          let comfyCheckCounter = 0
          const startTime = Date.now()
          // Same activity watchdog as the WS branch: the deadline only fires
          // when the prompt has also LEFT ComfyUI's queue — a slow render
          // that is still queued extends its own window.
          let lastActivity = Date.now()

          pollRef.current = setInterval(async () => {
            if (abortRef.current?.signal.aborted) {
              if (pollRef.current) clearInterval(pollRef.current)
              reject(new Error('Cancelled'))
              return
            }

            const elapsed = Date.now() - startTime
            if (Date.now() - lastActivity > maxTime) {
              if (await isPromptQueued(promptId).catch(() => false)) {
                lastActivity = Date.now()
              } else {
                if (pollRef.current) clearInterval(pollRef.current)
                reject(new Error(`Generation stalled: no progress from ComfyUI for ${Math.round(maxTime / 60000)} minutes.${cpuCauseSuffix(lastCpuRenderFacts())}`))
                return
              }
            }

            attempts++
            comfyCheckCounter++

            if (comfyCheckCounter >= 30) {
              comfyCheckCounter = 0
              const alive = await checkComfyConnection()
              if (!alive) {
                if (pollRef.current) clearInterval(pollRef.current)
                reject(new Error('ComfyUI stopped responding during generation'))
                return
              }
            }

            const elapsedSec = Math.round(elapsed / 1000)
            const expectedSteps = mode === 'video'
              ? steps * frames * 0.5
              : steps + (hiresFixEnabled && intent === 'image' ? hiresSteps : 0)
            const pct = Math.min(10 + (attempts / expectedSteps * 85), 95)

            try {
              const history = await getHistory(promptId)
              setProgress(pct, `Generating... ${elapsedSec}s elapsed`)
              if (!history) return

              if (history.status?.completed) {
                if (pollRef.current) clearInterval(pollRef.current)
                const messages = historyMessages(history)
                const startMsg = messages.find(([t]) => t === 'execution_start')
                const endMsg = messages.find(([t]) => t === 'execution_success')
                const comfyTime = startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp
                  ? ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1) : null
                setProgress(100, 'Complete!')
                useCreateStore.getState().setLastGenTime(comfyTime ? `${comfyTime}s` : null)
                const outputs = history.outputs ?? {}
                let found = false
                for (const nodeId of Object.keys(outputs)) {
                  // Extract files from ANY keyed array, not just images/gifs/
                  // videos — custom save nodes post under other keys (audio,
                  // result, files, …); previously those outputs were dropped
                  // even though they existed on disk.
                  const files: ComfyUIOutput[] = extractComfyOutputFiles(outputs[nodeId])
                  for (const file of files) {
                    found = true
                    addToGallery({
                      id: uuid(), type: galleryTypeForFile(file.filename, mode),
                      filename: file.filename, subfolder: file.subfolder ?? '', comfyType: file.type ?? 'output',
                      prompt, negativePrompt, model: activeModel,
                      modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                      seed: runSeed,
                      steps, cfgScale, sampler, scheduler, width: outputWidth, height: outputHeight, batchSize,
                      createdAt: Date.now(), builderUsed, intent,
                    })
                  }
                }
                if (!found) setError('Generation completed but no output was produced. Check ComfyUI logs.')
                resolve()
              } else if (history.status?.status_str === 'error') {
                if (pollRef.current) clearInterval(pollRef.current)
                const messages = historyMessages(history)
                const errorEntry = messages.find(([t]) => t === 'execution_error')
                const errMsg = errorEntry?.[1]?.exception_message
                  || errorEntry?.[1]?.message
                  || messages[messages.length - 1]?.[1]?.message
                  || 'Unknown ComfyUI error'
                const nodeType = errorEntry?.[1]?.node_type ? ` (${errorEntry[1].node_type})` : ''
                const hint = comfyErrorHint(errorEntry?.[1]?.node_type, errorEntry?.[1]?.exception_type, String(errMsg))
                reject(new Error(errMsg.trim() + nodeType + (hint ? `\n\n${hint}` : '')))
              }
            } catch (err) {
              console.warn('[useCreate] Poll error:', err)
            }
          }, 1000)
        })
      }
    } catch (err) {
      // However this render ended — Stop, the stall watchdog, a dead ComfyUI,
      // a node error — our prompt can still be sitting in ComfyUI's queue with
      // nobody watching it. The watchdogs used to just stop polling and walk
      // away, which is how a "stalled" job kept the GPU busy for another hour
      // and delivered its file to nowhere. Remove exactly OURS; a blanket
      // /interrupt here would kill the Create render or the external ComfyUI
      // tab that is actually running.
      const ownPromptId = useCreateStore.getState().currentPromptId
      if (ownPromptId) {
        try { await abandonPrompt(ownPromptId) } catch { /* best effort */ }
      }
      if (err instanceof Error && err.message === 'Cancelled') {
        // User cancelled, not an error
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        useCreateStore.getState().setError(`Generation failed: ${msg}`)
        console.error('[useCreate] Generation error:', err)
      }
    } finally {
      useCreateStore.getState().setIsGenerating(false)
      useCreateStore.getState().setProgress(0)
      useCreateStore.getState().setCurrentPromptId(null)
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      abortRef.current = null
      // Bring the evicted chat backends back (Z36). Fire and forget: the
      // reload can take a minute and must not hold the Create UI or the
      // next render (the helper serialises and a follow-up render inherits
      // the haul instead of waiting for it to load).
      if (renderEviction) void restoreChatBackendsAfterRender(renderEviction)
    }
    // `videoModelsList` ist State: seine Referenz wechselt nur, wenn
    // setVideoModelsList wirklich eine neue Liste schreibt (fetchModels), und
    // generateInner schreibt sie nicht. Der Callback wird also genau dann neu
    // gebaut, wenn sich die Modellliste aendert — vorher las er sie aus einer
    // veralteten Closure und leitete daraus den falschen `modelType` ab.
  }, [videoBackend, runCharacterTraining, videoModelsList])

  // Double-click idempotence: isGenerating only flips after the first await,
  // so a second click racing the first must be blocked SYNCHRONOUSLY — two
  // fast clicks were live-reproduced queueing two ComfyUI jobs.
  const generateInFlight = useRef(false)
  const generate = useCallback(async () => {
    if (generateInFlight.current) return
    generateInFlight.current = true
    try {
      await generateInner()
    } finally {
      generateInFlight.current = false
    }
  }, [generateInner])

  const cancel = useCallback(async () => {
    abortRef.current?.abort()
    if (trainingActive.current) {
      // Best effort, and deliberately not fatal: Stop's real job is the
      // abandonPrompt below. A training cancel that fails must not stop us
      // from taking the render out of the queue — that was the R32 defect
      // (job left running, file on disk, nobody watching).
      try { await cancelCharacterTraining() } catch { /* Stop continues regardless */ }
    }
    // Take OUR job out of the queue — do not blanket-/interrupt.
    //
    // /interrupt kills whatever ComfyUI is executing RIGHT NOW, which is only
    // our render when ours happens to be at the front. Queued behind three
    // others (R32 sat at position 4), Stop killed a stranger's job and left
    // ours to start seconds later, unwatched: the GPU kept working, the file
    // landed on disk, and nothing ever put it in the gallery because the poller
    // was already gone. The same /interrupt also reaches an external ComfyUI
    // tab on the same server. abandonPrompt deletes ours from pending and only
    // interrupts when ours is the one running.
    const ownPromptId = useCreateStore.getState().currentPromptId
    if (ownPromptId) {
      try { await abandonPrompt(ownPromptId) } catch { /* best effort */ }
    }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    useCreateStore.getState().setIsGenerating(false)
    useCreateStore.getState().setProgress(0)
    useCreateStore.getState().setCurrentPromptId(null)
    useCreateStore.getState().setError(null)
  }, [])

  return {
    connected,
    imageModels,
    videoModels: videoModelsList,
    samplerList,
    schedulerList,
    videoBackend,
    modelsLoaded,
    modelLoadError,
    mlxMissing,
    checkConnection,
    fetchModels,
    generate,
    cancel,
  }
}
