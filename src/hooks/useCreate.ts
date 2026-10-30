import { useState, useCallback, useRef, useEffect } from 'react'
import { blobFromUrl } from '../lib/render/data-url'
import { videoRunGivenUp, videoRunProgress, videoRunStatus } from '../lib/mlx-video-progress'
import { featherMaskBlob } from '../lib/mask-feather'
import { macHiresPass } from '../lib/mac-hires'
import { v4 as uuid } from 'uuid'
import {
  checkComfyConnection,
  refreshComfyModels,
  getImageModels,
  getVideoModels,
  getAudioModels,
  getLipsyncModels,
  getMotionModels,
  getUpscaleModels,
  getCLIPModels,
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
  legacyBuilderFits,
  listedLoras,
  canRunVideoIntent,
  classifyModel,
  isI2VModel,
  isRunnableRef2V,
  ref2vRefusal,
  withReferenceModels,
  videoLaneModels,
  extractComfyOutputFiles,
  freeMemory,
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
  type RenderEvictionPhase,
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
import { phaseForExecutingNode, phaseForExecutionStart, phaseForProgressStep, phaseForSaveNode } from '../lib/render-phase-labels'
import { buildDynamicWorkflow, buildLocalOpWorkflow, buildLocalUpscaleWorkflow, checkVideoOutputCapability, qwenEditResolution } from '../api/dynamic-workflow'
import { normalizeUpscaleFactor, pickUpscaleModel, upscaleTarget, upscaleToolLabel, upscaleTooLargeLine } from '../lib/local-upscale'
import { getAllNodeInfo, clearNodeCache } from '../api/comfyui-nodes'
import { cutoutModelOf, cutoutDownloadLine } from '../api/cutout-model'
import { apiNodes, type ComfyApiGraph, type ComfyExecutionMessage, type ComfyHistoryEntry } from '../types/comfy-graph'
import { restartComfyForNewNodes } from '../api/comfy-restart'
import { installCustomNodes } from '../api/discover'
import { buildWithFixups, wasDeclined, WAITING_FOR_ANSWER } from '../lib/render-fixups'
import { renderFixupDeps } from '../api/render-fixup-deps'
import { checkPromptSafety, SAFETY_BLOCK_MESSAGE } from '../lib/render/safety'
import { transparentPrompt, wantsTransparent } from '../lib/transparent-image'
import { scenePromptFor } from '../lib/ltx-multishot'
import { intentTakesOptionalPrompt, intentTakesPrompt } from '../components/create/experimental/intents'
import { knownMacMemoryGb } from '../lib/mac-memory'
import { MIN_TRAIN_IMAGES, maxTrainImages, tooFewTrainPhotosLine } from '../lib/train-image-cap'
import { improveKindForIntent, IMPROVING_PROMPT, type ImproveOutcome } from '../lib/render/improve-prompt'
import { elapsedLine } from '../lib/elapsed-line'
import { cancelFreeAfterRender, freeAfterRenderMode, scheduleFreeAfterRender } from '../lib/free-after-render'
import { improvePrompt } from '../lib/render/improve-prompt-run'
import { currentChatModelList, currentHelperModel } from '../lib/cloud-helper-model'
import { enhancerLine, enhancerNames, pickQwenEnhancer, rewrittenByName, type ImproveWriter } from '../lib/render/qwen-enhancer'
import { buildQwenEnhancerWorkflow, runQwenEnhancer } from '../api/qwen-enhancer'
import { enhancePromptOnMac } from '../api/mlx-enhancer'
import { extraReferenceSlots, referenceSide } from '../lib/edit-references'
import { END_IMAGE_ONE_CLIP, createReferenceSupport, localAnimateReferenceSlots, localEndFrame } from '../lib/frame-refs'
import { canonicalImageRefs } from '../lib/image-ref-names'
import { macEditReferenceRoom } from '../lib/mac-edit-memory'
import { getSharedMemoryGb } from '../lib/hardware'
import { resolveRunSeed } from '../lib/run-seed'
import { bumpSeed } from '../lib/render/image-count'
import {
  clearTrainingSet, stageTrainingImage, startCharacterTraining,
  characterTrainingStatus, cancelCharacterTraining,
} from '../api/trainer'
import { getMacTrainStatus, macTrainMissing } from '../api/mlx-train'
import { buildTrainCaption } from '../lib/train-captions'
import { trainTriggerWord } from '../lib/train-trigger'
import { characterThisWouldReplace, useTrainReplaceStore } from '../stores/trainReplaceStore'
import { buildStyleCaption, missingNameLine, trainedLine, trainedLoraFile } from '../lib/train-kind'
import { useCreateStore, EDIT_MAX_DENOISE, characterImageRun, deriveIntent, type CreateState, type GalleryItem } from '../stores/createStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRenderPreviewStore } from '../stores/renderPreviewStore'
import { renderStallLimitMs, renderStallMessage } from '../lib/tool-timeout'
import { injectParameters, injectLaneParameters } from '../api/workflows'
import { applyEditBatch } from '../api/edit-batch'
import { ranLoras } from '../lib/render/run-settings'
import { applyNativeHiresFix, latentDownscale } from '../api/hires-fix'
import { editHiresBase } from '../lib/edit-hires'
import { lorasForRun, skippedLorasLine } from '../lib/lora-stack'
import { macNoLocalLaneLine, macNoModelLine } from '../lib/mac-create-wording'
import {
  cutOutOnMac, generateMlxImageDataUrl, isMlxImageHost, isMlxImageModel, MAC_CUTOUT_TOOL,
  mlxStatus, listMlxImageModels, buildMlxImageModels, mergeImageModels, mlxModelIdFor,
  mlxUpscalerInstalled, upscaleOnMac, MAC_UPSCALE_TOOL,
} from '../api/mlx-image'
import { anyImageEngineReady, editCanvas, imageLaneModels, installedMlxEnhancers, macEditCanvas, macEditSide, takesMlxLoras } from '../lib/image-engines'
import { characterBaseModel, characterRunBlock } from '../lib/character-base'
import {
  CHAIN_STEP_IMAGE, CHAIN_STEP_VIDEO, CharacterChainCancelled, characterLoraFile, characterStartImage,
  isLocalCharacter, listLocalCharacters, withTriggerWord,
} from '../lib/characters'
import {
  characterImagePrompt, characterImageSize, characterRunPlan, characterVideoLaneEmpty, CHARACTER_VIDEO_LANES, withCharacterLora, withoutCharacterLoras,
} from '../lib/character-run'
import { defaultLoraStrength } from '../lib/lora-strength'
import { fetchGalleryItemBlob } from '../components/create/experimental/galleryUrl'
import { LongRunStopped, longVideoRequest, runLongVideo, type ClipItem } from '../lib/long-video-run'
import { settleSeams } from '../api/video-settle'
import { ownWorkflowMisfit } from '../lib/own-workflow-fit'
import { loadImageRef } from '../components/create/experimental/loadImage'
import { listMlxLoras } from '../api/mlx-loras'
import {
  getVideoStatus, listVideoModels, generateVideo, getVideoProgress, cancelVideo,
  buildMlxVideoModels, mlxFramesOnGrid, mlxTakesStartImage, mlxVideoModelIdFor, mlxVideoRunSize, mlxVideoRunSteps, mlxVideoSeconds, readVideoAsBlobUrl, stageStartImage, mlxTalking, mlxTalkingEntry, stageVoice,
  buildMlxMotionModels, mlxFollowsMotion, stageMotionVideo, MLX_MOTION_PROMPT,
} from '../api/mlx-video'
import { MAC_TALKING_NO_MODEL, macTalkingPrompt } from '../lib/mac-talking'
import { getMusicStatus, buildMacMusicModels, macMusicSeconds, runMacMusic, MusicRunCancelled, MAC_MUSIC_MODEL_NAME } from '../api/mlx-music'

/** What the stage says while the graphics card is handed to the render
 *  (api/vram-handoff, RenderEvictionPhase). */
const HANDOFF_LINE: Record<RenderEvictionPhase, string> = {
  'waiting-for-chat-model': 'Waiting for the chat model to finish loading...',
  freeing: 'Freeing graphics memory...',
}

/** The same two waits on a Mac, where the chat model and the render share one
 *  pool of memory and there is no graphics memory to name. */
const MAC_HANDOFF_LINE: Record<RenderEvictionPhase, string> = {
  'waiting-for-chat-model': HANDOFF_LINE['waiting-for-chat-model'],
  freeing: 'Freeing memory...',
}

/**
 * Take the resident chat model out of memory before a render on a Mac.
 *
 * The two MLX branches used to start with the chat model still loaded: only
 * the ComfyUI path handed the memory over. A Mac has one pool for both, so a
 * 23 GB chat model stayed beside the image model and macOS paged 16 GB to
 * disk for a single picture (48 GB Mac, 11.10.2026). The haul goes back
 * through restoreChatBackendsAfterRender in the caller's finally.
 * exclusiveVramMode 'never' skips it, as everywhere. Never throws.
 */
async function freeMacMemoryForRender(say: (text: string) => void): Promise<RenderEviction | null> {
  const handoff = elapsedLine(say, MAC_HANDOFF_LINE.freeing)
  try {
    return await evictChatBackendsForRender((phase) => handoff.setLabel(MAC_HANDOFF_LINE[phase]))
  } catch {
    return null
  } finally {
    handoff.stop()
  }
}

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

interface RunOpts {
  /** "Step 1 of 2: character image" and so on, in front of every line. */
  stepLabel?: string
  /** The character's trigger word, kept in a prompt the chat model rewrote. */
  trigger?: string
  /** A later section of a long clip (B18): the clip so far in ComfyUI's
   *  input folder and the frames this section repeats from it. */
  continueFrom?: { video: string; overlap: number }
  /** One pass with context windows past the native length (B18). */
  contextWindows?: boolean
}

/** The long clip fields of one run, as the workflow builder takes them. */
function longVideoParams(opts: RunOpts): { continueFrom?: { video: string; overlap: number }; contextWindows?: boolean } {
  return {
    ...(opts.continueFrom ? { continueFrom: opts.continueFrom } : {}),
    ...(opts.contextWindows ? { contextWindows: true } : {}),
  }
}

/** The store as one run reads it: the live state with this run's fields
 *  over it. The intent is derived from the merged fields, and the progress
 *  line carries the step of a chain. Nothing is written to the store. */
function withRunOverride(live: CreateState, override?: Partial<CreateState>, stepLabel?: string): CreateState {
  if (!override && !stepLabel) return live
  const merged: CreateState = { ...live, ...override }
  return {
    ...merged,
    intent: () => deriveIntent(merged),
    ...(stepLabel ? { setProgress: (p: number, text?: string) => live.setProgress(p, text ? `${stepLabel}. ${text}` : stepLabel) } : {}),
  }
}

/** A click on Create after Cancel, while the engine is still at the image. */
const PREVIOUS_IMAGE_FINISHING = 'The previous image is still finishing. Try again in a moment.'

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
  // A Mac image that was cancelled and that the engine has not let go of yet.
  const imageStillFinishing = useRef(false)
  // A local character-training run is a Rust child process, not a ComfyUI
  // prompt — cancel() must reach it through its own command.
  const trainingActive = useRef(false)
  /** Stop pressed while a training run was being set up or running. */
  const trainingCancelRequested = useRef(false)
  /** The character chain in flight (image, then video), for Stop. */
  const chainAbort = useRef<AbortController | null>(null)

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
        // The prompt enhancers come in the same catalogue (GH #148). A read
        // that finds no engine or fails leaves none, and not the last list:
        // an enhancer removed since must not be offered.
        let mlxEnhancers: string[] = []
        // Enhance Image is a local tab while an upscaler is installed. It is
        // no model of the picker, so the store carries it apart.
        let upscaler = false
        try {
          const mlx = await mlxStatus()
          if (anyImageEngineReady(mlx)) {
            const catalog = await listMlxImageModels()
            mlxImageModels = buildMlxImageModels(catalog)
            mlxEnhancers = installedMlxEnhancers(catalog)
            upscaler = mlxUpscalerInstalled(catalog)
          }
        } catch { /* MLX engine not set up yet — treat as no MLX models */ }
        useCreateStore.getState().setMlxEnhancerList(mlxEnhancers)
        useCreateStore.getState().setMlxUpscale(upscaler)
        try {
          mlxVideoModels = buildMlxVideoModels(await listVideoModels())
        } catch { /* mlx-video status unavailable yet — treat as no MLX video models */ }
        // Motion Control's lane: the packs that follow a motion video, once
        // its LoRA is installed. Empty, the Stage offers the LoRA.
        let macMotion: ClassifiedModel[] = []
        if (mlxFollowsMotion(mlxVideoModels)) {
          try {
            macMotion = buildMlxMotionModels(mlxVideoModels, (await getVideoStatus()).motionInstalled === true)
          } catch { /* the status cannot answer: the Stage offers the LoRA */ }
        }
        useCreateStore.getState().setMotionModelList(macMotion)
        setMlxMissing({ image: mlxImageModels.length === 0, video: mlxVideoModels.length === 0 })
        // The music engine (commands/music.rs) has one model. Its list is the
        // lane's, as the audio checkpoints are on a ComfyUI host, and it is
        // set whatever the image and video lanes found: a Mac with only the
        // music engine has a Music tab and nothing else.
        let musicStatus: Awaited<ReturnType<typeof getMusicStatus>> | null = null
        try {
          musicStatus = await getMusicStatus()
        } catch { /* the music engine cannot answer: no local Music tab */ }
        useCreateStore.getState().setAudioModelList(buildMacMusicModels(musicStatus))
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
          setVideoModelsList(mlxVideoModels)
          st.setVideoModelList(mlxVideoModels)
          // A model that is picked here writes its own steps, CFG and size
          // into the one set of sliders both lanes share. So the lane on
          // screen is picked last: a fresh Mac opened Image on the video
          // model's CFG 5.0, and Qwen-Image 2.1 takes the CFG it is given.
          // A pick whose family the catalogue names differently now (Qwen-Image
          // 2.1 was listed as SDXL) gets its family and its values again.
          const listedImage = mlxImageModels.find((m) => m.name === st.imageModel)
          const imagePick = mlxImageModels.length === 0 ? null
            : !listedImage ? mlxImageModels[0]
            : listedImage.type !== st.imageModelType ? listedImage : null
          const videoPick = mlxVideoModels.length > 0 && !mlxVideoModels.find((m) => m.name === st.videoModel)
            ? mlxVideoModels[0].name
            : null
          if (st.mode === 'video') {
            if (imagePick) st.setImageModel(imagePick.name, imagePick.type)
            const video = videoPick ?? (imagePick ? st.videoModel : '')
            if (video) st.setVideoModel(video)
          } else {
            if (videoPick) st.setVideoModel(videoPick)
            const image = imagePick ?? (videoPick ? listedImage : undefined)
            if (image) st.setImageModel(image.name, image.type)
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

      const [comfyImgModels, comfyVidModels, samplers, schedulers, vBackend, _nodeInfo, audModels, lipModels, motModels, upModels] = await Promise.all([
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
        // Enhance Image (3.0.7): the files in models/upscale_models.
        getUpscaleModels().catch(() => [] as string[]),
      ])
      // The text encoder files, for the prompt enhancers among them
      // ("Improve my prompt" on local Qwen-Image 2.1). Best effort.
      const textEncoders = await getCLIPModels().catch(() => [] as string[])
      // MLX entries go first so one is the default on a fresh Apple-Silicon box.
      const imgModels = mlxImageModels.length
        ? mergeImageModels(comfyImgModels, mlxImageModels)
        : comfyImgModels
      // Mac video is MLX-only — never surface ComfyUI video checkpoints there,
      // even in the rare case ComfyUI happens to be reachable (a manual install
      // the user started outside LU).
      // Animate also offers the reference models (D24), and Wan VACE sits on
      // the Motion lane's list, not on the video list.
      const vidModels = mlxHost ? mlxVideoModels : withReferenceModels(comfyVidModels, motModels)
      setImageModels(imgModels)
      setVideoModelsList(vidModels)
      setSamplerList(samplers)
      setSchedulerList(schedulers)
      setVideoBackend(vBackend)

      // Mirror the fetched lists into createStore so the header-level
      // CreateTopControls dropdown (which does NOT host its own useCreate)
      // can render without crashing on undefined. Discord-reported by
      // A user (console: `activeList is undefined`).
      const st = useCreateStore.getState()
      st.setImageModelList(imgModels)
      st.setVideoModelList(vidModels)
      st.setAudioModelList(audModels)
      st.setLipsyncModelList(lipModels)
      st.setMotionModelList(motModels)
      st.setUpscaleModelList(upModels)
      st.setTextEncoderList(textEncoders)

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
  // fetch immediately after the event was leaving a user + cprovencher
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
    // A Mac trains with its own image engine (api/mlx-train.ts). The calls
    // below go there by themselves (api/trainer.ts); what differs is how the
    // memory is handed over.
    const mac = isMlxImageHost()
    // 3.0.9 P8: a style / concept run shares the whole path; it differs in
    // the captions, the file name and where it lands (lib/train-kind.ts).
    // The field holds the character's trigger word or the style's name.
    // C7: the same word Rust names the LoRA file after, so captions, file
    // name and the Use shelf's prompt token are one word (lib/train-trigger.ts).
    // Also catches a persisted "Jörg" saved before the field cleaned it.
    const kind = state.trainKind
    const trigger = trainTriggerWord(state.triggerWord)
    if (!trigger) {
      setError(missingNameLine(kind))
      return
    }
    // Blobs are runtime-only — after an app restart the thumbnails would
    // still render (object URLs die too, but names persist) with no bytes.
    const staged = state.trainImages.filter((i) => i.blob instanceof Blob)
    if (staged.length < MIN_TRAIN_IMAGES) {
      setError(staged.length < state.trainImages.length
        ? 'Your photos did not survive the app restart. Re-add them, then train.'
        // The local trainer's cap (100), the one the drop zone names, not
        // the cloud's 30. A Mac trains locally too.
        : kind === 'style'
          ? `Add at least ${MIN_TRAIN_IMAGES} pictures in the style first (up to ${maxTrainImages('local')}).`
          : tooFewTrainPhotosLine('local'))
      return
    }
    // GH #194: the Train tab of a Mac without Z-Image Turbo takes a trigger
    // word and photos now; say what is missing before staging any of them.
    if (mac) {
      const st = await getMacTrainStatus().catch(() => null)
      const missing = st && (st.memoryRefusal ?? macTrainMissing(st))
      if (missing) {
        setError(st.memoryRefusal ?? `${missing} Install it in the Model Manager, then hit Create again.`)
        return
      }
    }
    // C8: the run ends by writing char_<trigger>_zimage.safetensors, the same
    // path an existing character of that name lives at. Ask before that
    // character is replaced, not after (stores/trainReplaceStore.ts). A list
    // that cannot be read (ComfyUI not up) does not block the run.
    const existing = characterThisWouldReplace(trigger, await listLocalCharacters().catch(() => []))
    if (existing) {
      if (await useTrainReplaceStore.getState().ask(existing) !== 'replace') {
        setError(`A character named “${existing}” already exists. Pick another trigger word, or confirm that the new training replaces it.`)
        return
      }
    }
    setError(null)
    setIsGenerating(true)
    trainingActive.current = true
    trainingCancelRequested.current = false
    // The trainer is a 12 GB recipe on a 12 GB card. A resident chat model
    // (the built-in engine, Ollama, LM Studio) squats 2 to 9 GB of that and
    // the run dies in the text-encoder cache or the first training step with
    // CUDA out of memory. Same hand-off as a render (Z36): capture what is
    // resident, save the built-in engine's KV slot, evict, and bring it all
    // back in the finally below. exclusiveVramMode 'never' skips it.
    let trainingEviction: RenderEviction | null = null
    try {
      // A style gets a set of its own: a character's set holds the photos
      // Edit hands out as that character's references (character_files.rs),
      // and clearing it for a style of the same name would take them.
      const setId = kind === 'style' ? `style-${trigger}` : trigger
      await clearTrainingSet(setId)
      let n = 0
      for (const img of staged) {
        const bytes = Array.from(new Uint8Array(await img.blob.arrayBuffer()))
        // Musubi has no trigger flag, the token must lead every caption. A
        // photo's own description (D28: clothes, hair, place) follows it, so
        // only what stays the same is learned into the trigger word.
        // A style's line names what is in the picture, with the name in front
        // only when it is to be a trigger word (P8).
        const caption = kind === 'style'
          ? buildStyleCaption(state.trainStyleTrigger ? trigger : '', state.trainCaptions[img.name])
          : buildTrainCaption(trigger, state.trainCaptions[img.name])
        await stageTrainingImage(setId, img.name, bytes, caption)
        n += 1
        setProgress(2 + Math.round((n / staged.length) * 5), `Staging photos (${n}/${staged.length})...`)
      }
      if (mac) {
        // One pool of memory on a Mac: the chat model leaves it for the run.
        trainingEviction = await freeMacMemoryForRender((line) => setProgress(7, line))
      } else {
        setProgress(7, 'Freeing the card for training (the local chat model pauses until the run ends)...')
        try {
          trainingEviction = await evictChatBackendsForRender()
        } catch { /* VRAM housekeeping is best-effort */ }
      }
      // Stop pressed during the hand-off: there is no run to cancel yet, and
      // starting one now would hand the card to a trainer nobody is watching
      // (the box, 06.09.2026: Cancel 0.6 s after Create, training ran on to
      // step 27 while the chat model was brought back beside it).
      if (trainingCancelRequested.current) return
      setProgress(8, 'Starting the training run...')
      await startCharacterTraining(setId, trigger, trigger, state.trainSteps, state.trainVramPreset, kind)
      let cancelRounds = 0
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000))
        if (!useCreateStore.getState().isGenerating && !trainingCancelRequested.current) return
        const s = await characterTrainingStatus().catch(() => null)
        if (!s) continue
        if (s.status === 'running') {
          if (trainingCancelRequested.current) {
            // Stop was pressed and the backend still reports a run: the
            // cancel raced the start (the start resets the flag) or landed
            // in the environment probe. Send it again until the run is
            // really gone; the card is only given back below, after that.
            try { await cancelCharacterTraining() } catch { /* next round */ }
            if (++cancelRounds >= 20) return
            continue
          }
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
          setProgress(100, trainedLine(kind))
          // The LoRA file just landed in models/loras — drop the node cache so
          // the Use shelf and the LoRA picker list it without a restart.
          clearNodeCache()
          const store = useCreateStore.getState()
          store.bumpCharactersVersion()
          if (kind === 'style') {
            // No shelf for a style: it is a LoRA of the Image tab, switched
            // on there, with its strength slider (P8).
            const file = trainedLoraFile('style', trigger)
            store.setIntent('image')
            if (!useCreateStore.getState().selectedLoras.some((l) => l.name === file)) store.toggleLora(file)
          } else {
            store.setCharacterTab('use')
          }
          return
        } else if (s.status === 'cancelled') {
          return
        } else {
          // The whole message, with its line breaks. It used to be the last
          // three log lines glued together with spaces and cut at 420
          // characters, which is how GitHub #121 reached us as "the error is
          // cut off and I cannot copy it": the one line that matters is the
          // traceback's last, and it was the one being dropped. `phase` is
          // what the backend set as the failure; the log tail is the fallback
          // for a status that arrived without one.
          const detail = s.phase?.trim() || s.logs.slice(-8).join('\n').trim()
          setError(detail ? `Training failed.\n${detail}` : 'Training failed.')
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

  // One run of the hook. `override` lays fields over the live store for this
  // run only (the character chain runs its start image in the image tab's
  // shape while the user stays on a video tab); `opts.stepLabel` puts
  // "Step 1 of 2" in front of every progress line, `opts.trigger` keeps the
  // character's trigger word in a prompt the chat model rewrote.
  const runOnce = useCallback(async (override?: Partial<CreateState>, opts: RunOpts = {}) => {
    const state = withRunOverride(useCreateStore.getState(), override, opts.stepLabel)
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
    //
    // The prompt of this run. A view without a prompt field (Talking Character,
    // Motion Control, Remove Background, training) sends none: the store holds
    // one prompt for every tab, and the text left from another tab would steer
    // the run unseen or fail this check for words nobody sees here.
    // Motion Control has an optional field here and sends what is typed in it.
    const typedPrompt = intentTakesPrompt(state.intent(), state.cloudOp === 'character' && state.characterTab === 'use')
      || intentTakesOptionalPrompt(state.intent(), 'local')
      ? state.prompt
      : ''
    // The negative prompt sits next to the prompt field (Composer shows it
    // only where there is one), so the same rule holds: Motion Control and
    // Talking Character have no such field, and a negative typed on Image or
    // Video went into their graphs unseen. Such a run takes its lane's own
    // default, which is empty.
    // The safety check below still reads the store's field, the same four
    // fields as the cloud path (lib/__tests__/render-safety.test.ts).
    const typedNegative = intentTakesPrompt(state.intent(), state.cloudOp === 'character' && state.characterTab === 'use')
      ? state.negativePrompt
      : ''
    {
      // The negative prompt is read apart (B30, safety.ts): there it keeps
      // things out of the picture.
      const verdict = checkPromptSafety(
        `${typedPrompt} ${state.musicLyrics} ${state.triggerWord} ${state.videoShots.join(' ')}`,
        { negative: state.negativePrompt },
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
    const negativePrompt = typedNegative
    const {
      mode, imageModel, videoModel,
      sampler, scheduler, steps, cfgScale, width, height, seed, batchSize, frames, fps, denoise,
      hiresFixEnabled, hiresScale, hiresDenoise, hiresSteps, hiresUpscaleMethod, i2iImage, i2vImage,
      source, references, mask, growMaskBy, removebg, selectedLoras, selectedVae, clipSkip,
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
    // Enhance Image on local ComfyUI (3.0.7): core upscale nodes, its own
    // model from models/upscale_models, no prompt and no picker model. A Mac
    // never gets here with it (setBackend closes the tab there).
    const isUpscale = mode === 'image' && state.utilityOp === 'upscale'
    const upscaleModel = isUpscale ? pickUpscaleModel(state.upscaleModelList) : null
    const upscaleFactor = normalizeUpscaleFactor(state.upscaleFactor)

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
    // On the Mac, Edit runs the models that take an image and no other
    // (imageLaneModels); a ComfyUI list is the whole list on every tab.
    const imageLane = imageLaneModels(state.imageModelList, intent)
    const effImageModel =
      imageLane.some((m) => m.name === imageModel)
        ? imageModel
        : (imageLane[0]?.name ?? imageModel)

    // GH #161: "Use character" on a model the character was not trained for
    // stops here with the reason. The run used to leave the character out and
    // render somebody else.
    // 'local:' and the Mac's 'mlx:' both count (lib/characters).
    const file = state.cloudOp === 'character' && state.characterTab === 'use' ? characterLoraFile(state.selectedCharacter) : null
    if (file) {
      const runType = state.imageModelList.find((m) => m.name === effImageModel)?.type ?? classifyModel(effImageModel)
      const stop = characterRunBlock(file, runType, !!characterBaseModel(file, imageLane, effImageModel))
      if (stop) {
        setError(stop)
        return
      }
    }

    // LTX 2.5 multishot: the prompt field is shot 1, the shots from the advanced
    // settings follow, each cut written out in plain words (lib/ltx-multishot).
    // The rewrite below sees the whole scene, so it keeps the cuts.
    // The model the run really uses: the picker shows the first capable one when
    // the stored pick cannot run the intent, and so does the submit below.
    const capableVideo = !localOp && mode === 'video' && state.videoModelList.length > 0 ? videoLaneModels(state.videoModelList, intent) : []
    const effVideoModel = capableVideo.length > 0 && !capableVideo.some((m) => m.name === videoModel) ? capableVideo[0].name : videoModel
    const effVideoEntry = state.videoModelList.find((m) => m.name === effVideoModel)
    const scenePrompt = scenePromptFor({
      prompt: typedPrompt, shots: state.videoShots, mode, intent, onMlxHost: isMlxImageHost(),
      modelType: effVideoEntry?.type ?? classifyModel(effVideoModel),
      macMultishot: effVideoEntry?.mlxVideo?.multishot === true,
    })
    // "Improve my prompt": the chat model the user picked rewrites the prompt
    // for this model before the run. Local chat models run on this machine,
    // LU Cloud ones are billed like chat. The field itself is never touched:
    // the run uses `prompt`, the gallery keeps both. A rewrite that fails never
    // stops the run, it goes on with the user's own prompt.
    let prompt = scenePrompt
    let improveFields: { promptOriginal?: string; rewrittenBy?: string; improveFailed?: true } = {}
    // The safety check covers the rewrite too: the user wrote an allowed
    // prompt, the model must not turn it into a refusal.
    const takeRewrite = (out: ImproveOutcome, writer: ImproveWriter['id']) => {
      if (out.status === 'improved' && !checkPromptSafety(out.prompt).blocked) {
        prompt = opts.trigger ? withTriggerWord(out.prompt, opts.trigger) : out.prompt
        improveFields = { promptOriginal: scenePrompt, rewrittenBy: rewrittenByName(writer, currentHelperModel(), currentChatModelList()) }
      } else if (out.status !== 'unchanged') {
        improveFields = { improveFailed: true }
      }
    }
    // A local Qwen-Image 2.1 run with a prompt enhancer installed: the
    // enhancer writes instead of the chat model (GH #148), for a new picture
    // and for an edit. On Windows it is a ComfyUI job, so it runs further
    // down, once ComfyUI is up and the chat model is off the card. On a Mac
    // it is the MLX edition from the Model Manager, and it runs in the MLX
    // image branch, once the chat model is out of memory and before the
    // image model loads.
    const onMac = isMlxImageHost()
    // Only where the MLX branch runs the picture: a ComfyUI model on a Mac
    // keeps the chat model's rewrite it had (`enhancerNames`).
    const pickedEnhancer = state.improvePrompt && !localOp && scenePrompt.trim()
      ? pickQwenEnhancer({
          local: true,
          intent,
          modelType: state.imageModelList.find((m) => m.name === effImageModel)?.type ?? classifyModel(effImageModel),
          textEncoders: enhancerNames(
            { onMac, mlxModel: isMlxImageModel(effImageModel) },
            state.textEncoderList,
            state.mlxEnhancerList,
          ),
        }, state.improveWith)
      : null
    const qwenEnhancer = onMac ? null : pickedEnhancer
    const macEnhancer = onMac ? pickedEnhancer : null
    const improveKind = state.improvePrompt && !qwenEnhancer && !macEnhancer ? improveKindForIntent(intent) : null
    if (improveKind && scenePrompt.trim()) {
      const own = new AbortController()
      abortRef.current = own
      setIsGenerating(true)
      const improving = elapsedLine((text) => setProgress(3, text), IMPROVING_PROMPT)
      const runModel = improveKind === 'music' ? state.localOpModel : improveKind === 'video' ? effVideoModel : effImageModel
      let out: ImproveOutcome = { status: 'failed' }
      try {
        out = await improvePrompt(scenePrompt, {
          kind: improveKind,
          modelLabel: runModel || undefined,
          tags: improveKind === 'image' && ['sd15', 'sdxl'].includes(state.imageModelList.find((m) => m.name === runModel)?.type ?? classifyModel(runModel)),
        }, own.signal)
      } finally {
        improving.stop()
        if (abortRef.current === own) abortRef.current = null
        setIsGenerating(false)
        setProgress(0)
      }
      // Cancel pressed while the chat model was writing: the run does not start.
      if (own.signal.aborted) return
      takeRewrite(out, 'chat')
    }

    // ── Remove Background on a Mac: no ComfyUI and no RMBG node. Vision in
    // macOS finds the subject and its mask becomes the alpha channel
    // (commands/mlx_cutout.rs). Nothing to install, nothing to free: the run
    // takes well under a second and a few hundred MB. The image is read from
    // disk, so one picked in cloud mode is staged first, as for an edit. ──
    if (isRemoveBg && isMlxImageHost()) {
      setError(null)
      if (!source) { setError('Please add an image to remove its background.'); return }
      const own = new AbortController()
      abortRef.current = own
      setIsGenerating(true)
      state.setProgressPhase('sampling')
      setProgress(30, 'Cutting out the subject...')
      try {
        const startTime = Date.now()
        const staged = source.filename || await stageStartImage(await blobFromUrl(source.url))
        const made = await cutOutOnMac(staged)
        // Cancel came while Vision was at it: the result is not wanted.
        if (own.signal.aborted) return
        state.setLastGenTime(`${Math.round((Date.now() - startTime) / 1000)}s`)
        addToGallery({
          id: uuid(), type: 'image', filename: `cutout-${Date.now()}.png`, subfolder: '',
          // localPath survives the restart, as for every image of this Mac.
          dataUrl: made.dataUrl, localPath: made.localPath, prompt: '', negativePrompt: '',
          model: MAC_CUTOUT_TOOL, modelType: 'unknown', toolModel: MAC_CUTOUT_TOOL,
          seed: 0, steps: 0, cfgScale: 0, sampler, scheduler,
          width: made.width, height: made.height, batchSize: 1,
          createdAt: Date.now(), builderUsed: 'dynamic', intent,
        })
        state.setProgressPhase('complete')
        setProgress(100, 'Complete!')
      } catch (e) {
        if (!own.signal.aborted) {
          useCreateStore.getState().setError(`Remove Background failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      } finally {
        if (abortRef.current === own) {
          abortRef.current = null
          useCreateStore.getState().setIsGenerating(false)
          useCreateStore.getState().setProgress(0)
        }
      }
      return
    }

    // ── Enhance Image on a Mac: no ComfyUI graph and no hosted endpoint.
    // SeedVR2 on the second engine makes the picture on the Stage larger by
    // the factor picked under the prompt field (commands/mlx.rs mlx_upscale).
    // It loads seven gigabytes, so the chat model is moved out of the way
    // first, as for an image, and Rust unloads the other image engine. The
    // picture is read from disk, so one without a file yet is staged first. ──
    if (intent === 'upscale' && state.backend === 'local' && isMlxImageHost()) {
      setError(null)
      if (!state.mlxUpscale) { setError('No local model that enhances images is installed. Install SeedVR2 3B in the Model Manager.'); return }
      if (!source) { setError('Please add an image to enhance.'); return }
      const own = new AbortController()
      abortRef.current = own
      own.signal.addEventListener('abort', () => { imageStillFinishing.current = true })
      setIsGenerating(true)
      state.setProgressPhase('loading-model')
      const macEviction = await freeMacMemoryForRender((text) => setProgress(5, text))
      setProgress(10, 'Loading SeedVR2...')
      try {
        const startTime = Date.now()
        const scale = state.macUpscaleScale
        const staged = source.filename || await stageStartImage(await blobFromUrl(source.url))
        state.setProgressPhase('sampling')
        setProgress(40, `Enhancing ${scale}x with MLX...`)
        const made = await upscaleOnMac(staged, { scale, seed: runSeed }, {
          signal: own.signal,
          onStep: (step, of) => setProgress(Math.min(95, 40 + Math.round((step / of) * 55)), `Enhancing ${scale}x, step ${step}/${of}`),
        })
        // Cancel ends the engine's process, and its last word is no result.
        if (own.signal.aborted) return
        state.setLastGenTime(`${Math.round((Date.now() - startTime) / 1000)}s`)
        addToGallery({
          id: uuid(), type: 'image', filename: `enhance-${Date.now()}.png`, subfolder: '',
          // localPath survives the restart, as for every image of this Mac.
          dataUrl: made.dataUrl, localPath: made.localPath, prompt: '', negativePrompt: '',
          model: MAC_UPSCALE_TOOL, modelType: 'unknown', toolModel: MAC_UPSCALE_TOOL,
          seed: runSeed, steps: made.steps ?? 1, cfgScale: 0, sampler, scheduler,
          width: made.width, height: made.height, batchSize: 1,
          createdAt: Date.now(), builderUsed: 'dynamic', intent,
        })
        state.setProgressPhase('complete')
        setProgress(100, 'Complete!')
      } catch (e) {
        if (!own.signal.aborted) {
          useCreateStore.getState().setError(`Enhance failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      } finally {
        if (macEviction) void restoreChatBackendsAfterRender(macEviction)
        imageStillFinishing.current = false
        if (useCreateStore.getState().error === PREVIOUS_IMAGE_FINISHING) useCreateStore.getState().setError(null)
        if (abortRef.current === own) {
          abortRef.current = null
          useCreateStore.getState().setIsGenerating(false)
          useCreateStore.getState().setProgress(0)
        }
      }
      return
    }

    // ── MLX image pipeline (Apple Silicon) — hard rule: Mac local image is the
    // in-process MLX path, never ComfyUI. Gated on the derived `image` intent
    // (which already means: no cloudOp, no utilityOp, no removebg, text2img)
    // AND on the SELECTED model being a synthetic MLX entry, so a real ComfyUI
    // checkpoint from a manual install is never hijacked. Generation returns a
    // base64 PNG stored as a data URL on the gallery item, so display +
    // download work with no ComfyUI /view route.
    //
    // `edit` arrives here too: Qwen-Image 2.1 on the second engine edits the
    // image on the Stage, with the references under it, from the prompt, and
    // where a mask was painted only under it. The images are files already:
    // loadImageRef stages them on disk on this host, and their paths go to
    // the engine. The mask is written next to them with its edge softened by
    // the feather slider. ──
    const mlxEdit = intent === 'edit' && isMlxImageHost()
    if (mlxEdit && !imageLane.some((m) => m.name === effImageModel && (m.editImages ?? 0) > 0)) {
      setError('No local model that edits images is installed. Install Qwen-Image 2.1 in the Model Manager.')
      return
    }
    // "Use character" on a Mac: the character's LoRA from the Mac's LoRA
    // folder is on the stack, and the run is a plain image from text on the
    // second engine, as the local Use tab is a plain image run on Windows.
    const macCharacter = intent === 'character' && state.characterTab === 'use' && isMlxImageHost()
    if ((intent === 'image' || mlxEdit || macCharacter) && isMlxImageHost() && isMlxImageModel(effImageModel)) {
      setError(null)
      if (!prompt.trim()) { setError('Please enter a prompt.'); return }
      if (mlxEdit && !source) { setError('Please add a source image first.'); return }
      const listed = state.imageModelList.find((m) => m.name === effImageModel)
      // An edit: the source first, then as many references as the model
      // reads on Windows (lib/edit-references). The canvas set in Create is
      // the pixel budget every image is scaled to, the number Windows hands
      // TextEncodeQwenImage21. The result takes the shape of the source: with
      // one image the engine does that itself, with several it would follow
      // the last one, so the size is worked out here.
      // Never 1024 by 1024: the model does not edit on that canvas, the
      // engine would move the run to 1056, and the request names the size
      // that runs (`edit_side` and `canvas` in image_mflux.rs, mirrored).
      const editBudget = qwenEditResolution(width, height)
      // As many as this Mac's memory takes at that canvas, the number the
      // reference strip offers (lib/mac-edit-memory); the ones past it stay
      // in the strip, marked not sent.
      const macRoom = mlxEdit && source && references.length > 0
        ? macEditReferenceRoom(editBudget, listed?.packGb ?? 0, await Promise.resolve().then(() => getSharedMemoryGb()).catch(() => 0))
        : null
      const editRefs = mlxEdit && source
        ? [source, ...references.slice(0, Math.min(extraReferenceSlots(listed?.type, effImageModel), macRoom ?? Infinity))]
        : []
      // More than four images share a pixel budget (referenceSide in
      // lib/edit-references). Here only the images shrink: the engine takes
      // the canvas apart from the budget, and the canvas below stays at the
      // full size of the source.
      const editSide = macEditSide(referenceSide(editBudget, editRefs.length))
      const editSize = mlxEdit && source && editRefs.length > 1 ? macEditCanvas(editCanvas(editBudget, source)) : null
      // "Transparent background": the same prompt wrapper the Windows graph
      // uses. The model writes the alpha channel and the engine keeps it.
      const transparent = wantsTransparent({
        enabled: state.transparentBackground, intent, isImageToImage: mlxEdit, isSpecializedLane: false, modelType: listed?.type,
      })
      const own = new AbortController()
      abortRef.current = own
      // From Cancel until the engine has let go of the image, a click on
      // Create is answered (see `generate`): a model that is loading cannot
      // be interrupted, and the second engine takes a moment to end.
      own.signal.addEventListener('abort', () => { imageStillFinishing.current = true })
      setIsGenerating(true)
      state.setProgressPhase('loading-model')
      setProgress(10, 'Starting MLX image generation...')
      addToPromptHistory(typedPrompt)
      // Batch size: one run per image, each with its own seed, so every one
      // of them can be made again.
      const count = Math.max(1, Math.min(8, Math.floor(batchSize) || 1))
      // The LoRA stack, for a model of the second engine: the picks whose
      // files are still in the Mac's LoRA folder and that fit this model, by
      // the rule the Windows run applies (lib/lora-stack). What is left out
      // is said under the result. Every image of a batch and every edit
      // takes the same stack.
      let runLoras: { name: string; strength: number }[] = []
      let macSkippedNote: string | null = null
      if (selectedLoras.length && takesMlxLoras(state.imageModelList, effImageModel)) {
        const listedLoras = await listMlxLoras().then((l) => l.loras.map((f) => f.name)).catch(() => null)
        const pick = lorasForRun(selectedLoras, listedLoras, listed?.type ?? 'unknown')
        if (listedLoras && pick.missing.length) useCreateStore.getState().keepListedLoras(listedLoras)
        macSkippedNote = skippedLorasLine(pick.missing, pick.otherModel)?.replace('models/loras', 'the LoRA folder') ?? null
        runLoras = pick.use
      }
      const macEviction = await freeMacMemoryForRender((text) => setProgress(5, text))
      setProgress(10, 'Starting MLX image generation...')
      try {
        // An image picked in cloud mode has no file yet. It is written to
        // disk here, the way a start image is before a local video.
        const editImages: string[] = []
        for (const ref of editRefs) {
          editImages.push(ref.filename || await stageStartImage(await blobFromUrl(ref.url)))
        }
        const editMask = mlxEdit && mask?.url
          ? await stageStartImage(await featherMaskBlob(await blobFromUrl(mask.url), growMaskBy))
          : undefined
        // "Improve my prompt" with the Qwen enhancer (GH #148): it rewrites
        // now, with the chat model out of memory, and its process has ended
        // before the image model loads. An edit shows it the same images, in
        // the same order, that the edit reads. A rewrite that fails leaves
        // the user's prompt; Cancel ends the enhancer and starts no image.
        if (macEnhancer && !own.signal.aborted) {
          const improving = elapsedLine((text) => setProgress(5, text), IMPROVING_PROMPT)
          const out = await enhancePromptOnMac({
            model: macEnhancer.file,
            mode: macEnhancer.mode,
            prompt: scenePrompt,
            images: macEnhancer.mode === 'i2i' ? editImages : [],
            seed: runSeed,
          }, own.signal).finally(improving.stop)
          if (!own.signal.aborted) takeRewrite(out, macEnhancer.variant)
          setProgress(10, 'Starting MLX image generation...')
        }
        // mflux labels the images of a Qwen-Image 2.1 edit <image1>,
        // <image2>, so the prompt names them so (lib/image-ref-names).
        const macRefs = mlxEdit && listed?.type === 'qwenimage'
        for (let n = 0; n < count && !own.signal.aborted; n++) {
          const startTime = Date.now()
          const imageSeed = bumpSeed(runSeed, n)
          const nth = count > 1 ? `Image ${n + 1} of ${count}. ` : ''
          state.setProgressPhase('sampling')
          setProgress(40, `${nth}Generating with MLX...`)
          const made = await generateMlxImageDataUrl({
            prompt: macRefs ? canonicalImageRefs(prompt, editImages.length, 'qwen21') : transparent ? transparentPrompt(prompt) : prompt,
            steps, seed: imageSeed, guidance: cfgScale,
            ...(mlxEdit
              ? { images: editImages, resolution: editSide, ...(editSize ?? {}), mask: editMask, strength: state.editStrength }
              : { width, height }),
            model: mlxModelIdFor(effImageModel),
            negativePrompt: (macRefs ? canonicalImageRefs(negativePrompt, editImages.length, 'qwen21') : negativePrompt) || undefined,
            ...(runLoras.length ? { loras: runLoras } : {}),
          }, {
            signal: own.signal,
            onStep: (step, of) => setProgress(Math.min(95, 10 + Math.round((step / of) * 85)), `${nth}Step ${step}/${of}`),
          })
          if (own.signal.aborted) break
          // HiRes fix: the picture goes back in as the image of an edit at
          // the larger size, started partway down the schedule (lib/mac-hires).
          // Only a model that edits can, and only the final picture is kept,
          // as on Windows. After an edit the same: the edited picture is the
          // image of the second pass (Discord feature request 21.10.2026).
          let first = made
          const pass = hiresFixEnabled && (listed?.editImages ?? 0) > 0
            ? macHiresPass(made.width || width, made.height || height, { scale: hiresScale, steps: hiresSteps, denoise: hiresDenoise })
            : null
          if (pass) {
            setProgress(60, `${nth}HiRes pass at ${pass.width}×${pass.height}...`)
            const staged = await stageStartImage(await blobFromUrl(made.dataUrl))
            first = await generateMlxImageDataUrl({
              prompt: transparent ? transparentPrompt(prompt) : prompt,
              steps: pass.steps, seed: imageSeed, guidance: cfgScale,
              images: [staged], resolution: pass.resolution, width: pass.width, height: pass.height, strength: pass.strength,
              model: mlxModelIdFor(effImageModel),
              negativePrompt: negativePrompt || undefined,
              ...(runLoras.length ? { loras: runLoras } : {}),
            }, {
              signal: own.signal,
              onStep: (step, of) => setProgress(Math.min(95, 60 + Math.round((step / of) * 35)), `${nth}HiRes step ${step}/${of}`),
            })
            if (own.signal.aborted) break
          }
          const elapsed = Math.round((Date.now() - startTime) / 1000)
          state.setLastGenTime(`${elapsed}s`)
          addToGallery({
            id: uuid(), type: 'image', filename: `mlx-${Date.now()}.png`, subfolder: '',
            // localPath is what survives the restart: partialize strips dataUrl,
            // and there is no ComfyUI /view to fall back to on a Mac.
            dataUrl: first.dataUrl, localPath: first.localPath, prompt, ...improveFields, negativePrompt, model: effImageModel, modelType: 'unknown',
            // What the run took: a pack with a Turbo adapter runs at its own
            // steps and guidance whatever the sliders say.
            seed: imageSeed, steps: made.steps ?? steps, cfgScale: made.guidance ?? cfgScale, sampler, scheduler,
            width: first.width || made.width || width, height: first.height || made.height || height, batchSize: 1,
            createdAt: Date.now(), builderUsed: 'dynamic', intent,
            ...(transparent ? { transparent: true as const } : {}),
            ...(macSkippedNote ? { runNote: macSkippedNote } : {}),
            ...ranLoras(runLoras),
          })
        }
        if (!own.signal.aborted) {
          state.setProgressPhase('complete')
          setProgress(100, 'Complete!')
        }
      } catch (e) {
        // Cancel ends the engine's process, and its last word is not an error.
        if (!own.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e)
          useCreateStore.getState().setError(`Generation failed: ${msg}`)
        }
      } finally {
        if (macEviction) void restoreChatBackendsAfterRender(macEviction)
        imageStillFinishing.current = false
        // The line that answered a click in the meantime has done its work.
        if (useCreateStore.getState().error === PREVIOUS_IMAGE_FINISHING) useCreateStore.getState().setError(null)
        // A run that was cancelled must not clear the state of the next one.
        if (abortRef.current === own) {
          abortRef.current = null
          useCreateStore.getState().setIsGenerating(false)
          useCreateStore.getState().setProgress(0)
        }
      }
      return
    }

    // ── MLX video pipeline (Apple Silicon) — hard rule: Mac local video is the
    // in-process mlx-video path, never ComfyUI. Unlike the image branch this
    // needs no model-name marker: on Mac the video picker IS the MLX catalog
    // (fetchModels above), so every local video generation routes here. Two
    // intents arrive: `video` is text to video, and `animate` hands the engine
    // the image on the Stage as its first frame. Which models take one is the
    // catalogue's word (`startImage` on the list entry). Generation is a
    // subprocess polled via video_progress every 2s (no WebSocket/node graph).
    // Motion Control runs here too (3.0.8): the character image on the Stage
    // is the start image, and the motion video goes along, on an LTX-2.3 pack
    // with its IC-LoRA (commands/video_motion.rs). The prompt is optional,
    // as on ComfyUI; an empty one becomes MLX_MOTION_PROMPT.
    // Extend Video runs here too (14.10.2026): as on Windows, the last frame
    // of the picked clip is on the Stage (LocalExtendControls), and the run
    // is an image to video run from it on a model that takes a start image. ──
    // Talking Character runs here too (3.0.8): the portrait on the Stage and
    // the voice become a clip whose lips follow the speech, on a model whose
    // entry talks (the engine's a2v, api/mlx-video mlxTalking). The clip is as
    // long as the voice; Rust reads that length itself.
    const talking = intent === 'lipsync'
    if ((intent === 'video' || intent === 'animate' || intent === 'extend' || intent === 'motion' || talking) && isMlxImageHost()) {
      setError(null)
      const motionRun = intent === 'motion'
      // The model on the chip: the first one this lane can run when the stored
      // pick cannot (see effVideoModel above). Motion Control picks from its
      // own list, the way the chip does (localPick), and Talking Character
      // takes the model that talks.
      const talkEntry = talking ? mlxTalkingEntry(state.videoModelList, state.localOpModel) : undefined
      const mlxModel = talking ? (talkEntry?.name ?? '') : motionRun ? localOpModel : effVideoModel
      const mlxEntry = (motionRun ? state.motionModelList : state.videoModelList).find((m) => m.name === mlxModel)
      if (talking) {
        if (!talkEntry) { setError(MAC_TALKING_NO_MODEL); return }
        if (talkEntry.mlxVideo?.talking !== 'ready') { setError('Get Talking Character first, with the button above the voice.'); return }
        if (!source) { setError('Add the portrait the character should speak from.'); return }
        if (!state.audioInput) { setError('Add a voice first. Upload the speech audio.'); return }
        // What the voice says goes into the prompt, and passes the same check.
        if (checkPromptSafety(state.talkingWords).blocked) { setError(SAFETY_BLOCK_MESSAGE); return }
      }
      if (motionRun && !prompt.trim()) prompt = MLX_MOTION_PROMPT
      if (!talking && !prompt.trim()) { setError('Please enter a prompt.'); return }
      const talkPrompt = macTalkingPrompt(state.talkingWords)
      // With nothing installed the picker is empty, and "pick one" has
      // nothing to pick from.
      if (!mlxModel) {
        setError(motionRun
          ? 'Motion Control is not installed yet. Use Download & install above, then Create again.'
          : state.videoModelList.length === 0 ? macNoModelLine('video') : 'No local video model selected. Pick one from the model picker.')
        return
      }
      const catalogId = mlxVideoModelIdFor(mlxModel)
      if (!catalogId) { setError(`Unknown MLX video model "${mlxModel}". Select it again from the picker.`); return }
      // Before anything loads: a model that animates a start image would
      // spend minutes loading and then fail on a tensor shape.
      if (intent === 'animate' && !source) { setError('Add a start image first.'); return }
      if (intent === 'extend' && !source) { setError('Pick the clip to extend first. Its last frame becomes the starting point.'); return }
      if (motionRun && !source) { setError('Add the character image that should perform the motion.'); return }
      if (motionRun && !state.videoInput) { setError('Add the driving video whose motion the character should copy.'); return }
      // Step 2 of a character chain hands its picture over as the source.
      const chainStart = opts.stepLabel === CHAIN_STEP_VIDEO && !!source
      if (intent === 'video' && mlxEntry?.startImage === 'required' && !chainStart) {
        setError(`"${mlxModel}" needs a start image. Open Animate Image to give it one.`)
        return
      }
      // The engine reads the image from disk. One picked on this Mac in local
      // mode is staged already, one picked in cloud mode is staged now.
      let startImage: string | undefined
      if ((intent === 'animate' || intent === 'extend' || motionRun || talking || chainStart) && source) {
        try {
          startImage = source.filename || await stageStartImage(await blobFromUrl(source.url))
        } catch (e) {
          setError(`Could not prepare the start image: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
      }
      // The voice is read from disk as well.
      let voice: string | undefined
      if (talking && state.audioInput) {
        try {
          voice = await stageVoice(state.audioInput.blob)
        } catch (e) {
          setError(`Could not prepare the voice: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
      }
      try {
        const status = await getVideoStatus()
        if (!status.available) { setError('Local video generation is Apple Silicon only.'); return }
        if (!status.mlxInstalled && !status.ltx2MlxInstalled) { setError('The local video engine is not set up on this Mac yet (a one-time setup is needed before local video works).'); return }
        if (!status.installedModels.includes(catalogId)) { setError(`The local video model "${mlxModel}" isn't downloaded yet.`); return }
        if (motionRun && !status.motionInstalled) { setError('Motion Control is not installed yet. Use Download & install above, then Create again.'); return }
      } catch (e) {
        setError(`Local video status check failed: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      // The motion video goes to disk the same way as the start image.
      let motionVideo: string | undefined
      if (motionRun && state.videoInput) {
        try {
          motionVideo = await stageMotionVideo(state.videoInput.blob)
        } catch (e) {
          setError(`Could not prepare the motion video: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
      }

      const clip = mlxEntry?.mlxVideo
      const clipFps = clip?.fps ?? fps
      const clipSeconds = clip
        // The slider's grid and ceiling, by the same memory (lib/mac-memory).
        ? mlxVideoSeconds(mlxFramesOnGrid(frames, clip.frameStep, motionRun ? null : knownMacMemoryGb()), clip.fps)
        : Math.max(0.5, frames / Math.max(1, fps))
      // The negative prompt reaches the models that read one (Wan, and the
      // dev pipelines of LTX). For every other one the field is not shown,
      // and what an earlier tab left in it goes neither out nor into the
      // gallery entry.
      const clipNegative = clip?.negativePrompt ? negativePrompt.trim() : ''
      // The size and the steps the settings show (api/mlx-video): the canvas
      // put on the model's grid and inside its own pixels, and the steps of
      // a model that takes a count. The run makes exactly this. A talking
      // clip takes the shape of its portrait: the tab shows no size.
      const shape = talking && source?.width && source?.height ? { width: source.width, height: source.height } : { width, height }
      const clipSize = clip ? mlxVideoRunSize(shape.width, shape.height, clip) : null
      const clipSteps = clip ? mlxVideoRunSteps(steps, clip) : undefined
      // The LoRA stack, for a model whose engine takes one (`loras` of its
      // entry: the quantized LTX packs and Wan). The same rule as the image
      // run above: the picks whose files are still in the LoRA folder and
      // that fit this model. What is left out is said under the result.
      let videoLoras: { name: string; strength: number }[] = []
      let videoSkippedNote: string | null = null
      if (selectedLoras.length && clip?.loras && !talking) {
        const listedLoras = await listMlxLoras().then((l) => l.loras.map((f) => f.name)).catch(() => null)
        const pick = lorasForRun(selectedLoras, listedLoras, mlxEntry?.type ?? 'unknown')
        if (listedLoras && pick.missing.length) useCreateStore.getState().keepListedLoras(listedLoras)
        videoSkippedNote = skippedLorasLine(pick.missing, pick.otherModel)?.replace('models/loras', 'the LoRA folder') ?? null
        videoLoras = pick.use
      }

      setIsGenerating(true)
      state.setProgressPhase('loading-model')
      setProgress(0, 'Starting MLX video generation...')
      if (!talking) addToPromptHistory(typedPrompt)
      const startTime = Date.now()
      abortRef.current = new AbortController()
      const macEviction = await freeMacMemoryForRender((text) => setProgress(0, text))
      setProgress(0, 'Starting MLX video generation...')
      let result: Awaited<ReturnType<typeof generateVideo>>
      try {
        result = await generateVideo({
          id: catalogId,
          // The tab has no prompt field: the scene is the portrait's, and
          // what the voice says is the line under the chips.
          prompt: talking ? talkPrompt : prompt,
          // The length in frames, on the model's grid and at the model's
          // rate, so the engine makes the clip the slider showed. The rate in
          // the store belongs to the stored pick, which on Animate may be
          // another model than the one the lane runs. A talking clip is as
          // long as its voice.
          seconds: talking ? undefined : clipSeconds,
          ...(voice ? { audio: voice } : {}),
          fps: clipFps,
          seed: runSeed,
          initImage: startImage,
          negativePrompt: clipNegative || undefined,
          ...(videoLoras.length ? { loras: videoLoras } : {}),
          ...(clip?.sizeGrid && clipSize ? { width: clipSize.width, height: clipSize.height } : {}),
          ...(clipSteps ? { steps: clipSteps } : {}),
          ...(motionVideo ? { motionVideo } : {}),
        })
      } catch (e) {
        useCreateStore.getState().setError(`Failed to start: ${e instanceof Error ? e.message : String(e)}`)
        useCreateStore.getState().setIsGenerating(false)
        abortRef.current = null
        if (macEviction) void restoreChatBackendsAfterRender(macEviction)
        return
      }
      try {
        state.setProgressPhase('sampling')
        await new Promise<void>((resolve, reject) => {
          let lastStep: number | null = null
          let lastStepAt = Date.now()
          const tick = async () => {
            if (abortRef.current?.signal.aborted) {
              try { await cancelVideo() } catch { /* already finished/gone */ }
              reject(new Error('Cancelled'))
              return
            }
            // Safety net: never poll forever, and KILL the mlx-video
            // subprocess when the run is given up, so it stops pinning the
            // machine. A run that keeps making steps is not cut off at the
            // hour (lib/mlx-video-progress.ts, videoRunGivenUp).
            const givenUp = videoRunGivenUp({ elapsedMs: Date.now() - startTime, step: lastStep, sinceStepChangeMs: Date.now() - lastStepAt })
            if (givenUp) {
              try { await cancelVideo() } catch { /* already finished/gone */ }
              reject(new Error(givenUp))
              return
            }
            try {
              const prog = await getVideoProgress()
              const elapsed = Math.round((Date.now() - startTime) / 1000)
              // The step and what is left, from the engine's own lines
              // (lib/mlx-video-progress.ts).
              const at = videoRunStatus(prog.logs, elapsed)
              setProgress(at.percent, at.text)
              const step = videoRunProgress(prog.logs)?.step ?? null
              if (step !== lastStep) { lastStep = step; lastStepAt = Date.now() }
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
                  prompt: talking ? talkPrompt : prompt, ...(talking ? {} : improveFields), negativePrompt: clipNegative, model: mlxModel, modelType: mlxEntry?.type ?? 'wan',
                  seed: runSeed, steps: clipSteps ?? steps, cfgScale, sampler, scheduler,
                  // The size the run had: the one it was sent with, which is
                  // the entry's own for a model that takes none.
                  width: clipSize?.width ?? width, height: clipSize?.height ?? height, batchSize: 1,
                  createdAt: Date.now(), builderUsed: 'dynamic', intent,
                  ...(videoSkippedNote ? { runNote: videoSkippedNote } : {}),
                  ...ranLoras(videoLoras),
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
        if (macEviction) void restoreChatBackendsAfterRender(macEviction)
      }
      return
    }

    // ── Music on a Mac: ACE-Step 1.5 as a process of its own (commands/
    // music.rs, api/mlx-music.ts), no ComfyUI graph. It takes the style, the
    // lyrics, the length and the seed, and nothing else: the turbo model runs
    // at its own eight steps. Rust frees the image engine before the model
    // loads; the chat model is freed here, as before a picture. ──
    if (intent === 'music' && isMlxImageHost()) {
      setError(null)
      if (!prompt.trim()) { setError('Describe the track first. Genre, mood, tempo…'); return }
      if (!localOpModel) {
        setError('The music engine is not installed on this Mac. Get ACE-Step 1.5 in the Model Manager, under Music.')
        return
      }
      const seconds = macMusicSeconds(state.musicDuration)
      const own = new AbortController()
      abortRef.current = own
      setIsGenerating(true)
      state.setProgressPhase('loading-model')
      setProgress(0, 'Starting the music engine...')
      addToPromptHistory(typedPrompt)
      const macEviction = await freeMacMemoryForRender((text) => setProgress(0, text))
      try {
        state.setProgressPhase('sampling')
        const track = await runMacMusic(
          { prompt, lyrics: state.musicLyrics, seconds, seed: runSeed },
          { signal: own.signal, onProgress: (percent, text) => setProgress(percent, text) },
        )
        setProgress(100, 'Complete!')
        useCreateStore.getState().setLastGenTime(`${track.elapsedSec}s`)
        addToGallery({
          id: uuid(), type: 'audio', filename: '', subfolder: '',
          dataUrl: track.url,
          localPath: track.output,
          prompt, ...improveFields, negativePrompt: '', model: MAC_MUSIC_MODEL_NAME, modelType: 'ace',
          // What the run had: the seed Rust used, the engine's own steps, and
          // no sampler, scheduler or guidance of Create's.
          seed: track.seed, steps: track.steps, cfgScale: 0, sampler: '', scheduler: '',
          width: 0, height: 0, batchSize: 1,
          createdAt: Date.now(), builderUsed: 'dynamic', intent,
        })
      } catch (e) {
        if (!(e instanceof MusicRunCancelled)) {
          useCreateStore.getState().setError(`Generation failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      } finally {
        useCreateStore.getState().setIsGenerating(false)
        useCreateStore.getState().setProgress(0)
        if (abortRef.current === own) abortRef.current = null
        if (macEviction) void restoreChatBackendsAfterRender(macEviction)
      }
      return
    }

    // Everything below is the ComfyUI path. A Mac has no ComfyUI and never
    // starts one, so a run that was not taken by one of the two MLX branches
    // above ends here, in the Mac's words, before a sentence about ComfyUI
    // can be said (persona walk, 09.10.2026, Fund 12).
    if (isMlxImageHost()) {
      const laneList = mode === 'image' ? state.imageModelList : state.videoModelList
      setError(macNoLocalLaneLine(mode, laneList.length > 0))
      return
    }

    setError(null)
    let activeModel = localOp ? localOpModel : isUpscale ? (upscaleModel ?? '') : (mode === 'image' ? effImageModel : videoModel)
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
      // showed a capable model (2026-08-02).
      setError('Video models are still loading. Give it a few seconds and hit Create again.')
      return
    }
    // The type comes from the freshly fetched list (never from the persisted
    // store value, which can be stale): that list carries the header sniff,
    // and a CivitAI name alone misroutes (Discord 2026-09-28). The name is the
    // fallback for a model the list does not hold.
    const listedModel = (mode === 'image' ? state.imageModelList : state.videoModelList)
      .find((m) => m.name === activeModel)
    const imageModelType = localOp ? classifyModel(activeModel) : (listedModel?.type ?? classifyModel(activeModel))
    // B38: Animate hands the builder an end image and further references only
    // for a model that reads them (lib/frame-refs). The Stage marks the ones
    // a model does not read as not sent, so nothing is dropped unseen.
    const animateSlots = intent === 'animate' ? localAnimateReferenceSlots(activeModel) : 0
    const animateExtras = intent === 'animate'
      ? {
        ...(state.endImage?.filename && localEndFrame(activeModel) ? { endImage: state.endImage.filename } : {}),
        ...(animateSlots > 0 && references.some((r) => r.filename)
          ? { referenceImages: references.map((r) => r.filename).filter(Boolean).slice(0, animateSlots) }
          : {}),
      }
      : {}
    // B45: reference images for text to image, as many as the model reads.
    const createRefSlots = intent === 'image' && !isI2I ? createReferenceSupport(imageModelType, activeModel).slots : 0
    const createRefNames = createRefSlots > 0
      ? state.imageReferences.map((r) => r.filename).filter(Boolean).slice(0, createRefSlots)
      : []

    // Background removal is prompt-free and model-independent (RMBG node);
    // lipsync/motion drive off their media inputs (the builder supplies a
    // neutral scene prompt when the field is empty).
    const promptOptional = isRemoveBg || isUpscale || localOp === 'lipsync' || localOp === 'motion'
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
    if (isUpscale) {
      if (!upscaleModel) {
        setError('No upscale model installed. Use Download & install above, then hit Create again.')
        return
      }
      const tooLarge = source ? upscaleTooLargeLine(source.width, source.height, upscaleFactor) : null
      if (tooLarge) {
        setError(tooLarge)
        return
      }
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
    if ((intent === 'animate' || intent === 'extend') && !opts.continueFrom) {
      if (!effI2vImage) {
        setError(intent === 'extend'
          ? 'Pick the clip to extend first. Its last frame becomes the starting point.'
          : 'Add the image you want to animate first.')
        return
      }
      const refusal = intent === 'animate' ? ref2vRefusal(activeModel) : null
      if (refusal) {
        setError(refusal)
        return
      }
      if (!isI2VModel(activeModel) && !(intent === 'animate' && isRunnableRef2V(activeModel))) {
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

    abortRef.current = new AbortController()
    // B27: a render starts, so a planned free of ComfyUI's memory is off.
    cancelFreeAfterRender()

    // Make VRAM room for the render. On a single local GPU a resident chat LLM
    // (Ollama / LM Studio / the bundled engine) squats the card, which forces
    // ComfyUI into heavy CPU offload, or a CUDA OOM on the 14B video lanes
    // (S2V / Animate). Z36: this used to be a bare offload_local_models call
    // that killed both llama processes with no KV save and no reload, costing
    // the next chat turn a 62 s cold start. The hand-off helper captures what
    // is resident, saves the built-in engine's KV slot, then evicts; the
    // finally below hands the haul back, and the chat backends return when a
    // chat needs them, Create is left, or nobody asked for a while (see
    // restoreChatBackendsAfterRender). exclusiveVramMode 'never' skips the
    // eviction. Best-effort, never blocks a render.
    //
    // The box, 03.10.2026: this wait stood for 25 to 30 s under "Preparing
    // workflow..." with no counter. No workflow is prepared in it: the card is
    // handed over, and most of the time goes into waiting for the previous
    // render's restore to finish reading the chat model back in. The line
    // says which it is and counts like every other waiting line.
    let renderEviction: RenderEviction | null = null
    // B28: the live preview of a video run, taken down in the finally below.
    let offPreview: (() => void) | null = null
    const handoff = elapsedLine((text) => setProgress(0, text), HANDOFF_LINE.freeing)
    try {
      renderEviction = await evictChatBackendsForRender((phase) => handoff.setLabel(HANDOFF_LINE[phase]))
    } catch { /* VRAM housekeeping is best-effort */ } finally {
      handoff.stop()
    }
    setProgress(0, 'Preparing workflow...')

    try {
      // The Qwen prompt enhancer writes now: the chat model has left the card,
      // and the enhancer leaves it again before the picture's models load
      // (runQwenEnhancer unloads it). An edit shows it the same pictures, in
      // the same order, that the picture's graph numbers as image 1, 2, 3.
      // A ComfyUI too old for it is offered the update, like the model itself.
      if (qwenEnhancer) {
        setProgress(3, IMPROVING_PROMPT)
        const signal = abortRef.current?.signal
        const images = qwenEnhancer.mode === 'i2i' && effInputImage
          ? [effInputImage, ...references.map((r) => r.filename).filter(Boolean).slice(0, extraReferenceSlots(imageModelType, activeModel))]
          : []
        const enhancerGraph = await buildWithFixups(
          () => buildQwenEnhancerWorkflow({ file: qwenEnhancer.file, mode: qwenEnhancer.mode, prompt: scenePrompt, images, seed: runSeed }),
          renderFixupDeps((line) => setProgress(3, line), signal),
        )
        // The rewrite is the long wait (70 to 175 s on a 12 GB card), so the
        // line counts from here; the build above has its own status lines.
        const improving = elapsedLine((text) => setProgress(3, text), IMPROVING_PROMPT)
        // B41: the line says which part runs and, while it writes, how many
        // tokens it has and how fast, from ComfyUI's own progress stream.
        const out = await runQwenEnhancer(enhancerGraph, scenePrompt, {
          clientId: CLIENT_ID,
          signal,
          onProgress: (p) => improving.setLabel(enhancerLine(p, qwenEnhancer.mode)),
        }).finally(improving.stop)
        if (signal?.aborted) throw new Error('Cancelled')
        takeRewrite(out, qwenEnhancer.variant)
      }
      // GH #146: the stack is checked against what ComfyUI lists right now.
      // A deleted file or a Z-Image character on another model is left out
      // with a line, instead of ComfyUI refusing the whole graph.
      let runLoras = selectedLoras
      // The progress line is gone a second later, so the result keeps it
      // too (3.0.4 Gegenprobe 8: a deleted LoRA was left out "silently").
      let skippedNote: string | undefined
      // Enhance runs no diffusion model, so the LoRA stack has nothing to say.
      if (selectedLoras.length && !isUpscale) {
        const listed = await listedLoras().catch(() => null)
        const pick = lorasForRun(selectedLoras, listed, imageModelType)
        if (listed && pick.missing.length) useCreateStore.getState().keepListedLoras(listed)
        const line = skippedLorasLine(pick.missing, pick.otherModel)
        if (line) setProgress(0, line)
        skippedNote = line ?? undefined
        runLoras = pick.use
      }
      let outputWidth = width
      let outputHeight = height
      // Local Qwen-Image 2.1 text-to-image with "Transparent background": the
      // builder wraps the prompt, SaveImage keeps the alpha channel. Only the
      // dynamic builder knows the switch, so a custom workflow or a fallback
      // graph runs as written and the entry is not marked transparent.
      const transparentRequested = wantsTransparent({
        enabled: state.transparentBackground, intent, isImageToImage: isI2I, isSpecializedLane: !!localOp, modelType: imageModelType,
      })
      const transparentFields = () => (transparentRequested && builderUsed === 'dynamic' ? { transparent: true as const } : {})
      const baseParams = {
        prompt, negativePrompt,
        ...(transparentRequested ? { transparent: true } : {}), model: activeModel, sampler, scheduler, steps, cfgScale, width, height, seed: runSeed, batchSize,
        ...(isRemoveBg && effInputImage ? { removebg: true, inputImage: effInputImage } : {}),
        // Discord 2026-09-25 (a user: "a house becomes a tennis court"): at
        // strength 1.00 the builder read denoise >= 1 as "no img2img" and
        // dropped the source without a word. Edit always keeps the source;
        // 0.95 is the most it repaints (the slider tops out there too).
        ...(isI2I && !isRemoveBg && effInputImage ? { inputImage: effInputImage, denoise: Math.min(denoise, EDIT_MAX_DENOISE) } : {}),
        // GH #144: further references ride along; the builder keeps only as
        // many as the model's family takes (lib/edit-references).
        ...(isI2I && !isRemoveBg && effInputImage && references.some((r) => r.filename)
          ? { referenceImages: references.map((r) => r.filename).filter(Boolean) }
          : {}),
        ...(createRefNames.length > 0 ? { referenceImages: createRefNames } : {}),
        ...(!isRemoveBg && maskFilename ? { maskImage: maskFilename, growMaskBy } : {}),
        // Advanced adjustments. LoRA feeds the builder's `lora`/`loraStrength`
        // contract (string[] + number[]); the old `loras` key was read by nobody,
        // so LoRA selection was a silent no-op for image too (D#80). VAE/clip-skip
        // stay image-only (the builder ignores them for video).
        ...(runLoras.length
          ? { lora: runLoras.map((l) => l.name), loraStrength: runLoras.map((l) => l.strength) }
          : {}),
        ...(selectedVae && selectedVae !== 'auto' ? { vae: selectedVae } : {}),
        ...(clipSkip > 0 ? { clipSkip } : {}),
        ...(listedModel?.parts ? { modelParts: listedModel.parts } : {}),
        // Qwen-Image 2.1: the text encoder picked in the advanced settings.
        // The builder reads it for that family only.
        ...(state.qwenTextEncoder !== 'auto' ? { qwenTextEncoder: state.qwenTextEncoder } : {}),
      }

      let workflow: ComfyApiGraph = {}
      let builderUsed: 'dynamic' | 'legacy' | 'custom' = 'dynamic'

      // ── Specialized-lane graphs: stage the media inputs in ComfyUI's input
      // dir, then build the lane's core-node workflow. No custom-workflow or
      // legacy fallback here — REJECT-AND-REPORT via WorkflowUnavailableError
      // is the whole point (an "Update ComfyUI" message instead of a broken
      // graph). ──
      if (isUpscale && upscaleModel && effInputImage) {
        setProgress(5, 'Building workflow...')
        const size = { width: source?.width || width, height: source?.height || height }
        workflow = await buildWithFixups(
          () => buildLocalUpscaleWorkflow({
            image: effInputImage, model: upscaleModel, factor: upscaleFactor,
            sourceWidth: size.width, sourceHeight: size.height,
          }),
          renderFixupDeps((line) => setProgress(5, line), abortRef.current?.signal),
        )
        builderUsed = 'dynamic'
        const target = upscaleTarget(size.width, size.height, upscaleFactor)
        outputWidth = target.width
        outputHeight = target.height
      }

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
        // The lanes carry the same version gate as a picture (YuE2, S2V,
        // Animate): a too-old ComfyUI is offered the update, then the build
        // runs again. The box, 03.10.2026: Music failed with the update
        // sentence because this build never went through the question.
        const laneParams = {
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
        }
        // A workflow of the user's own, picked for this model in Advanced
        // settings, runs instead of LU's Motion Control graph. Discord,
        // 15.10.2026: the Wan 2.2 Animate example workflow ran in ComfyUI
        // itself, and LU had no way to run it in this tab.
        const laneWf = localOp === 'motion'
          ? useWorkflowStore.getState().getWorkflowForModel(activeModel, imageModelType)
          : null
        if (laneWf) {
          setProgress(5, `Using workflow: ${laneWf.name}...`)
          workflow = injectLaneParameters(laneWf.workflow, laneWf.parameterMap, {
            model: activeModel, seed: runSeed,
            refImage: source?.filename || undefined, drivingVideo,
          }, useWorkflowStore.getState().paramOverrides[laneWf.id])
          builderUsed = 'custom'
        } else {
          workflow = await buildWithFixups(
            () => buildLocalOpWorkflow(laneParams),
            renderFixupDeps((line) => setProgress(5, line), abortRef.current?.signal),
          )
          builderUsed = 'dynamic'
        }
      }

      // Check for custom workflow assignment — but verify it's compatible with the model
      let customWf = localOp || isUpscale ? null : useWorkflowStore.getState().getWorkflowForModel(activeModel, imageModelType)
      if (customWf) {
        const misfit = ownWorkflowMisfit(apiNodes(customWf.workflow).map(([, n]) => n.class_type), imageModelType, listedModel?.source)
        if (misfit) {
          console.warn(`[useCreate] Custom workflow incompatible: ${misfit}. Using auto.`)
          customWf = null
        }
      }
      console.log('[useCreate] Custom workflow check:', { activeModel, imageModelType, found: customWf?.name ?? 'NONE (auto)' })

      if (customWf) {
        builderUsed = 'custom'
        setProgress(5, `Using workflow: ${customWf.name}...`)
        const params = mode === 'video' ? { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}), ...animateExtras } : baseParams
        // The values changed under "Workflow parameters" go in last (GitHub wish #8).
        const overrides = useWorkflowStore.getState().paramOverrides[customWf.id]
        workflow = await injectParameters(customWf.workflow, customWf.parameterMap, params, imageModelType, overrides)
      } else if (!localOp && !isUpscale) {
        // Dynamic workflow builder — auto-detects nodes and builds the right pipeline
        setProgress(5, 'Building workflow...')
        try {
          const genParams = mode === 'video' ? { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}), ...animateExtras, ...longVideoParams(opts) } : baseParams
          // A missing text encoder / VAE or a too-old ComfyUI is fixed in
          // place after one question, then the build runs again.
          workflow = await buildWithFixups(
            () => buildDynamicWorkflow(genParams, imageModelType),
            renderFixupDeps((line) => setProgress(5, line), abortRef.current?.signal),
          )
          builderUsed = 'dynamic'
        } catch (dynErr) {
          // A WorkflowUnavailableError carries an actionable message ("download
          // <encoder> from the Model Manager") — surface it directly instead of
          // falling back to a legacy builder that would fail the same way with
          // a cryptic ComfyUI rejection.
          if (dynErr instanceof Error && dynErr.name === 'WorkflowUnavailableError') {
            throw dynErr
          }
          if (!legacyBuilderFits(imageModelType, mode === 'video')) throw dynErr
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
        // Bug A (v2.4.5 — Discord 2026-05-14
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
              setProgress(5, WAITING_FOR_ANSWER)
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
                  const genParams = { ...baseParams, frames, fps, ...(effI2vImage ? { inputImage: effI2vImage } : {}), ...animateExtras, ...longVideoParams(opts) }
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

      // B35: an edit starts from a latent of one; the batch size repeats it,
      // so an edit run makes as many pictures as a Generate run (api/edit-batch).
      if (intent === 'edit' && isI2I && !isRemoveBg && effInputImage) {
        workflow = applyEditBatch(workflow, batchSize)
      }

      // Native HiRes is a graph transform, not a special workflow. Apply
      // it after Auto/custom workflow construction so the same switch works on
      // every compatible local text-to-image graph. Unsupported custom graphs
      // fail with an actionable message rather than silently ignoring the knob.
      // Edit (Discord feature request 21.10.2026, "Native HiRes Upscale in
      // the EDIT"): the same pass after the edit. Its canvas follows the
      // source (lib/edit-hires), and a masked edit is refused with a line
      // (api/hires-fix).
      const hiresEdit = intent === 'edit' && isI2I && !isRemoveBg && !!effInputImage
      if (hiresFixEnabled && (intent === 'image' || hiresEdit)) {
        setProgress(8, 'Adding native HiRes Fix...')
        const editBase = hiresEdit
          ? editHiresBase({ source, width, height, modelType: imageModelType, modelName: activeModel })
          : null
        const hires = applyNativeHiresFix(workflow, {
          baseWidth: editBase?.width ?? width,
          baseHeight: editBase?.height ?? height,
          scale: hiresScale,
          denoise: hiresDenoise,
          steps: hiresSteps,
          upscaleMethod: hiresUpscaleMethod,
          latentDownscale: latentDownscale(imageModelType),
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
      const maxTime = renderStallLimitMs(mode === 'video' ? 'video' : 'image', useSettingsStore.getState().settings)
      let useWS = false
      let wsMark = 0
      try {
        await comfyWS.connect(3000)
        useWS = true
        wsMark = comfyWS.mark()
      } catch {
        console.warn('[useCreate] WebSocket unavailable, using polling fallback')
      }

      // A cutout runs on the node's own model, which the node fetches inside
      // its first run. Asked before the submit, so the wait can say so.
      const cutoutModel = isRemoveBg ? cutoutModelOf(workflow) : undefined
      const cutoutDownload = cutoutModel ? await cutoutDownloadLine(cutoutModel) : null
      const toolFields = cutoutModel ? { toolModel: cutoutModel }
        : isUpscale && upscaleModel ? { toolModel: upscaleToolLabel(upscaleModel) }
        : {}

      setProgress(10, 'Submitting to ComfyUI...')
      // B28: a video asks ComfyUI for a picture per sampling step, so a wrong
      // start shows long before the end and Cancel can stop it. ComfyUI sends
      // previews only to this client and one prompt runs at a time here, so
      // every preview that arrives belongs to this run.
      const livePreview = mode === 'video'
      if (livePreview) {
        useRenderPreviewStore.getState().setUrl(null)
        offPreview = comfyWS.onPreview((url) => useRenderPreviewStore.getState().setUrl(url))
      }
      let promptId: string
      try {
        promptId = await submitWorkflow(workflow, CLIENT_ID, livePreview ? { previewMethod: 'auto' } : {})
      } catch (err) {
        setError(`Failed to submit: ${err instanceof Error ? err.message : String(err)}`)
        setIsGenerating(false)
        return
      }
      setCurrentPromptId(promptId)
      addToPromptHistory(typedPrompt)

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
          const store = useCreateStore.getState()
          // The bar and its seconds used to repaint only when ComfyUI sent an
          // event. Long silent stretches are normal here (a 14B sampling step
          // or a VAE decode on a full card emits nothing for minutes), so the
          // label froze mid-run: the owner watched "Decoding... 266s" stand still
          // for 10+ minutes while the GPU sat at 100% (2026-08-02). Events now
          // only change phase and percent; a ticker repaints the elapsed time
          // every second so a working render never looks hung.
          let phasePct = 10
          store.setProgressPhase('queued')
          const line = elapsedLine((text) => setProgress(phasePct, text), 'Queued...')
          const setPhase = (pct: number, label: string) => {
            phasePct = pct
            line.setLabel(label)
          }

          // Activity watchdog (2.5.8): the old hard wall-clock cap killed a
          // REAL render at exactly 60 minutes while ComfyUI was still
          // sampling (live-caught on the extend lane: 3060 + TI2V-5B, file
          // landed on disk seconds after the app gave up). maxTime now bounds
          // the SILENT gap — every WS event for our prompt, and a still-queued
          // prompt on the periodic check, count as life signs.
          let lastActivity = Date.now()
          // d308-a (Windows box, 15.10.2026): with the limit at 1 minute a
          // running Z-Image render was called stalled during its long VAE
          // decode (no events for 100 s) and its finished pictures were
          // dropped. The queue refresh below comes once a minute, so with a
          // short limit it lost the race. Like the polling path, the queue
          // is asked before a run is given up: a prompt ComfyUI still runs
          // or holds is alive, and one with a history entry has ended and
          // is collected by the heartbeat.
          let stallCheck = false
          const timeoutTimer = setInterval(async () => {
            if (stallCheck || Date.now() - lastActivity <= maxTime) return
            stallCheck = true
            try {
              if (await isPromptQueued(promptId).catch(() => false)) {
                lastActivity = Date.now()
                return
              }
              // Finished a moment ago: the heartbeat's next history poll
              // collects the pictures, so this is no stall either.
              if (completionHandled || await getHistory(promptId).catch(() => null)) return
              cleanup()
              reject(new Error(`${renderStallMessage(maxTime)}${cpuCauseSuffix(lastCpuRenderFacts())}`))
            } finally {
              stallCheck = false
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
                      prompt, ...improveFields, ...transparentFields(), negativePrompt, model: activeModel,
                      modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                      seed: runSeed,
                      steps, cfgScale, sampler, scheduler, width: outputWidth, height: outputHeight, batchSize, ...ranLoras(runLoras),
                      createdAt: Date.now(), builderUsed, intent, ...toolFields, ...(skippedNote ? { runNote: skippedNote } : {}),
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
            line.stop()
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
                const step = phaseForExecutingNode(classType, mode === 'video' ? 'video' : 'image', cutoutDownload)
                  ?? phaseForSaveNode(classType, st.progressPhase)
                if (step) {
                  st.setProgressPhase(step.phase)
                  setPhase(step.pct, step.label)
                }
                break
              }
              case 'execution_start':
              case 'execution_cached': {
                // d307-c H2: a cached Enhance sat on "Queued..." to the end.
                const cached = event.type === 'execution_cached'
                  ? (event.data.nodes ?? []).map((id) => nodeClassMap.get(id) || '')
                  : []
                const step = phaseForExecutionStart(st.progressPhase, cached)
                if (step) {
                  st.setProgressPhase(step.phase)
                  setPhase(step.pct, step.label)
                }
                break
              }
              case 'progress': {
                const { value, max } = event.data
                const step = phaseForProgressStep(value, max, st.progressPhase, isUpscale)
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
                        prompt, ...improveFields, ...transparentFields(), negativePrompt, model: activeModel,
                        modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                        seed: runSeed,
                        steps, cfgScale, sampler, scheduler, width: outputWidth, height: outputHeight, batchSize, ...ranLoras(runLoras),
                        createdAt: Date.now(), builderUsed, intent, ...toolFields, ...(skippedNote ? { runNote: skippedNote } : {}),
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
                reject(new Error(`${renderStallMessage(maxTime)}${cpuCauseSuffix(lastCpuRenderFacts())}`))
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
              : steps + (hiresFixEnabled && (intent === 'image' || hiresEdit) ? hiresSteps : 0)
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
                      prompt, ...improveFields, ...transparentFields(), negativePrompt, model: activeModel,
                      modelType: mode === 'image' ? imageModelType : (videoModelsList.find(m => m.name === activeModel)?.type ?? 'wan'),
                      seed: runSeed,
                      steps, cfgScale, sampler, scheduler, width: outputWidth, height: outputHeight, batchSize, ...ranLoras(runLoras),
                      createdAt: Date.now(), builderUsed, intent, ...toolFields, ...(skippedNote ? { runNote: skippedNote } : {}),
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
      } else if (err instanceof Error && wasDeclined(err)) {
        // A no to the download or update question: nothing failed, the run
        // never started, and the reason says what it would have needed.
        useCreateStore.getState().setError(`Not started. ${err.message}`)
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
      offPreview?.()
      useRenderPreviewStore.getState().setUrl(null)
      // B27: and ComfyUI's memory goes back when the setting says so.
      scheduleFreeAfterRender(
        freeAfterRenderMode(useSettingsStore.getState().settings.freeAfterRender),
        () => useCreateStore.getState().isGenerating,
      )
    }
    // `videoModelsList` ist State: seine Referenz wechselt nur, wenn
    // setVideoModelsList wirklich eine neue Liste schreibt (fetchModels), und
    // generateInner schreibt sie nicht. Der Callback wird also genau dann neu
    // gebaut, wenn sich die Modellliste aendert — vorher las er sie aus einer
    // veralteten Closure und leitete daraus den falschen `modelType` ab.
  }, [videoBackend, runCharacterTraining, videoModelsList])

  // The character on the chip (lib/character-run). Image and Edit carry its
  // LoRA and trigger word in the run; every video lane goes through the one
  // chain: step 1 renders the character's start image on the normal image
  // path, step 2 runs the video from it. The Mac wires its own engines into
  // the same chain: both steps go through runOnce, whose Mac branches run
  // the image on mflux with the LoRA and the video on MLX from that image.
  const generateInner = useCallback(async () => {
    const s = useCreateStore.getState()
    const mac = isMlxImageHost()
    // A long local clip (B18): several sections, each continuing the clip so
    // far, or one pass with context windows. ComfyUI only; the Mac's MLX
    // lanes keep their own lengths.
    if (!mac && s.backend === 'local' && !isLocalCharacter(s.selectedCharacter)) {
      const intent = s.intent()
      const lane = s.videoModelList.length > 0 ? videoLaneModels(s.videoModelList, intent) : []
      const model = lane.length > 0 && !lane.some((m) => m.name === s.videoModel) ? lane[0].name : s.videoModel
      const long = longVideoRequest({
        mode: s.mode, intent, model,
        type: s.videoModelList.find((m) => m.name === model)?.type ?? classifyModel(model),
        installed: s.videoModelList.map((m) => m.name),
        longVideoSeconds: s.longVideoSeconds, longVideoMode: s.longVideoMode,
        fps: s.fps, frames: s.frames, extendClip: s.extendClip,
      })
      if (long?.kind === 'error') { s.setError(long.message); return }
      // B38: a clip in sections would end its FIRST section on the end
      // image. Said instead of done wrong.
      if (long && intent === 'animate' && s.endImage && localEndFrame(model)) {
        s.setError(END_IMAGE_ONE_CLIP)
        return
      }
      if (long?.kind === 'one-pass') { await runOnce({ frames: long.frames }, { contextWindows: true }); return }
      if (long?.kind === 'sections') {
        const own = new AbortController()
        chainAbort.current = own
        s.setError(null)
        try {
          await runLongVideo(long.plan, long.start, {
            run: (override, opts) => runOnce(override as Partial<CreateState>, opts),
            gallery: () => useCreateStore.getState().gallery,
            error: () => useCreateStore.getState().error,
            fetchBlob: (item) => fetchGalleryItemBlob(item as GalleryItem),
            upload: (blob, name) => uploadMediaFile(blob, name),
            remove: (id) => useCreateStore.getState().removeFromGallery(id),
            settle: async (item: ClipItem, seams, anchorEnd, base) => {
              const settled = await settleSeams(item, seams, anchorEnd, base)
              if (!settled) return null
              const st = useCreateStore.getState()
              const old = st.gallery.find((g) => g.id === item.id)
              if (!old) return null
              const next = { ...old, id: uuid(), filename: settled.filename, subfolder: settled.subfolder }
              st.addToGallery(next)
              st.removeFromGallery(old.id)
              return next
            },
            aborted: () => own.signal.aborted,
          })
        } catch (e) {
          if (!(e instanceof LongRunStopped) || e.message !== 'Stopped.') {
            useCreateStore.getState().setError(e instanceof Error ? e.message : String(e))
          }
        } finally {
          if (chainAbort.current === own) chainAbort.current = null
          useCreateStore.getState().setIsGenerating(false)
          useCreateStore.getState().setProgress(0)
        }
        return
      }
    }
    if (s.backend !== 'local' || !isLocalCharacter(s.selectedCharacter)) {
      await runOnce()
      return
    }
    const intent = s.intent()
    const imageLane = imageLaneModels(s.imageModelList, intent)
    const effImage = imageLane.some((m) => m.name === s.imageModel) ? s.imageModel : (imageLane[0]?.name ?? s.imageModel)
    const videoLane = intent === 'video' ? videoLaneModels(s.videoModelList, 'video') : []
    const effVideo = videoLane.some((m) => m.name === s.videoModel) ? s.videoModel : (videoLane[0]?.name ?? s.videoModel)
    const character = s.selectedCharacter!
    const file = characterLoraFile(character)!
    const plan = characterRunPlan({
      intent,
      character,
      hasSource: !!s.source,
      hasMask: !!s.mask,
      imageModelType: s.imageModelList.find((m) => m.name === effImage)?.type ?? classifyModel(effImage),
      baseInstalled: !!characterBaseModel(file, s.imageModelList, effImage),
      // The Mac knows from its catalogue which model takes a start image;
      // the name rule below is the one for ComfyUI's files.
      videoModel: intent === 'video' && !mac ? effVideo : '',
      // On a Mac step 2 always starts from the picture, so the lane is empty
      // without an installed MLX video model that takes a start image.
      videoLaneEmpty: mac
        ? intent === 'motion' ? s.motionModelList.length === 0
          : intent === 'lipsync' ? !mlxTalking(s.videoModelList).ready
          : CHARACTER_VIDEO_LANES.has(intent) && !mlxTakesStartImage(s.videoModelList)
        : characterVideoLaneEmpty(intent, { video: s.videoModelList, lipsync: s.lipsyncModelList, motion: s.motionModelList }),
    })
    const strength = s.loraStrengths[file] ?? defaultLoraStrength(file)
    if (plan.kind === 'error') {
      s.setError(plan.message)
      return
    }
    if (plan.kind === 'image') {
      await runOnce(
        { prompt: withTriggerWord(s.prompt, character.triggerWord), selectedLoras: withCharacterLora(s.selectedLoras, file, strength) },
        { trigger: character.triggerWord },
      )
      return
    }
    if (plan.kind !== 'chain') {
      await runOnce()
      return
    }
    const takesStart = s.videoModelList.find((m) => m.name === effVideo)?.startImage
    // Motion Control needs its motion video, and is told before step 1
    // spends minutes on the character's image.
    if (mac && intent === 'motion' && !s.videoInput) {
      s.setError('Add the driving video whose motion the character should copy.')
      return
    }
    if (mac && intent === 'video' && (!takesStart || takesStart === 'none')) {
      s.setError(`${effVideo} makes video from text only and cannot start from your character. Pick a model that takes a start image (LTX) or remove the character.`)
      return
    }
    const own = new AbortController()
    chainAbort.current = own
    s.setError(null)
    try {
      const start = await characterStartImage(character, characterImagePrompt(intent, s.prompt, character.triggerWord), {
        models: s.imageModelList,
        currentModel: s.imageModel,
        strength,
        signal: own.signal,
        onProgress: (line) => useCreateStore.getState().setProgress(0, line),
        renderImage: async (req) => {
          const before = new Set(useCreateStore.getState().gallery.map((g) => g.id))
          await runOnce(characterImageRun(req, characterImageSize(s.width, s.height)), { stepLabel: CHAIN_STEP_IMAGE, trigger: character.triggerWord })
          if (own.signal.aborted) throw new CharacterChainCancelled()
          const after = useCreateStore.getState()
          // The image step said what went wrong already; the video does not start.
          if (after.error) throw new CharacterChainCancelled()
          const made = after.gallery.find((g) => !before.has(g.id) && g.type === 'image')
          if (!made) throw new Error('The character image did not come out, so the video did not start.')
          const blob = await fetchGalleryItemBlob(made)
          return loadImageRef(new File([blob], made.filename || 'character.png', { type: blob.type || 'image/png' }))
        },
      })
      // Between the two steps the card is handed over the way it is after
      // every render (vram-handoff): ComfyUI lets go of the image model
      // before the video model loads.
      // The Mac's image engine lets go of its model when the image is out,
      // and its video branch frees the rest itself; there is no ComfyUI.
      if (!mac) await freeMemory()
      if (own.signal.aborted) return
      await runOnce({ source: start, selectedLoras: withoutCharacterLoras(s.selectedLoras) }, { stepLabel: CHAIN_STEP_VIDEO })
    } catch (e) {
      if (!(e instanceof CharacterChainCancelled)) useCreateStore.getState().setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (chainAbort.current === own) chainAbort.current = null
      useCreateStore.getState().setIsGenerating(false)
      useCreateStore.getState().setProgress(0)
    }
  }, [runOnce])

  // Double-click idempotence: isGenerating only flips after the first await,
  // so a second click racing the first must be blocked SYNCHRONOUSLY — two
  // fast clicks were live-reproduced queueing two ComfyUI jobs.
  const generateInFlight = useRef(false)
  const generate = useCallback(async () => {
    if (generateInFlight.current) {
      // Not a double click: the run was cancelled, the surface is free, and
      // the engine is still at the image. Said, and not swallowed.
      if (imageStillFinishing.current) useCreateStore.getState().setError(PREVIOUS_IMAGE_FINISHING)
      return
    }
    generateInFlight.current = true
    try {
      await generateInner()
    } finally {
      generateInFlight.current = false
    }
  }, [generateInner])

  const cancel = useCallback(async () => {
    abortRef.current?.abort()
    // A character chain between or inside its two steps stops whole.
    chainAbort.current?.abort()
    if (trainingActive.current) {
      // The run's poll loop reads this: it holds the card until the backend
      // confirms the run is gone, and re-sends the cancel if it is not.
      trainingCancelRequested.current = true
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
