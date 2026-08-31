import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelType, ClassifiedModel } from '../api/comfyui'
import { classifyModel } from '../api/comfyui'
import type { HiresUpscaleMethod } from '../api/hires-fix'
import { releaseVideoBlobUrl } from '../api/mlx-video'
// ModelType includes: flux, flux2, zimage, sdxl, sd15, wan, hunyuan, unknown

export type ProgressPhase = 'idle' | 'queued' | 'loading-model' | 'loading-clip' | 'loading-vae' | 'sampling' | 'decoding' | 'complete'

/**
 * Backend the redesigned Create page generates against. Runtime-only — derived
 * from session/license (a paired Bridge → `local`; a logged-in hosted tier →
 * `cloud`) and never persisted. Orthogonal to `videoBackend` (comfy|mlx), which
 * stays a local-only concern.
 */
export type CreateBackend = 'local' | 'cloud'

/**
 * The redesigned Create page's flat creation intents, derived over
 * mode / image sub-mode / video sub-mode / removebg. The `mode` + sub-mode
 * enums stay the load-bearing state; `intent` is a derived view over them.
 */
export type CreateIntent =
  | 'image' | 'edit' | 'removebg' | 'video' | 'animate' | 'upscale' | 'eraser'
  | CloudOp

/** Cloud-only single-purpose WaveSpeed endpoints (2.5.7): super-resolution
 *  and masked object removal. Local backends have no lane for them, so the
 *  IntentBar only offers these while the cloud backend is active. */
export type UtilityOp = 'upscale' | 'eraser'

/** 2.5.8 specialized Create categories (2026-07-17 David):
 *  Character-Studio (LoRA training + generation), talking character (lipsync),
 *  music, video extend and motion control. Like `utilityOp`, an escape hatch
 *  over the image/video mode axis: when set it wins the intent derivation. */
export type CloudOp = 'character' | 'lipsync' | 'music' | 'extend' | 'motion'

/** Which of the specialized categories ALSO run on the local ComfyUI backend
 *  (2.5.8 local lanes: ACE music, Wan S2V talking character, last-frame-chain
 *  extend, Wan VACE/Animate motion). Single source of truth for the intent
 *  metadata, the IntentBar lock state and the backend-flip cleanup below —
 *  lives here (lowest layer) so intents.ts can derive from it without a
 *  component→store import cycle. */
// Character joined in 2.6.0: trainer.rs ships the musubi venv install, so
// the train lane is a real local tab now (it was cloud-first while 2.5.8
// had no trainer runtime).
export const LOCAL_LANE_OPS: ReadonlySet<CloudOp> = new Set(['music', 'lipsync', 'extend', 'motion', 'character'])

/** An audio/video file (or training image) staged in the composer before
 *  upload. `blob` carries the bytes for the cloud upload; `url` is a local
 *  object URL for preview. Runtime-only — blobs can never persist. */
export interface MediaRef { name: string; url: string; blob: Blob }

/** A trained character on the user's cloud shelf (server: user_loras). */
export interface CharacterRef { id: string; name: string; triggerWord: string; family: string }

/**
 * A source or mask image loaded into the Stage input slot. `filename` is the
 * backend handle (a ComfyUI /upload/image name on the local path, or a
 * render-inputs storage path on the cloud path); `url` is a local object/data
 * URL for preview. Runtime-only — never persisted.
 */
export interface ImageRef { filename: string; url: string; width: number; height: number }

/** Flatten mode / sub-mode / removebg / utilityOp / cloudOp into the single
 *  intent the UI drives. */
export function deriveIntent(s: {
  removebg: boolean
  utilityOp: UtilityOp | null
  cloudOp: CloudOp | null
  mode: 'image' | 'video'
  imageSubMode: 'text2img' | 'img2img'
  videoSubMode: 't2v' | 'i2v'
}): CreateIntent {
  if (s.removebg) return 'removebg'
  if (s.utilityOp) return s.utilityOp
  if (s.cloudOp) return s.cloudOp
  if (s.mode === 'video') return s.videoSubMode === 'i2v' ? 'animate' : 'video'
  return s.imageSubMode === 'img2img' ? 'edit' : 'image'
}

/**
 * Where video generation runs.
 *
 * - `comfy` — local ComfyUI server. Works on every OS; FP8 quirks on Mac
 *   MPS, fastest on CUDA. Default for Windows + Linux.
 *
 * - `mlx` — `mlx-video` subprocess driven by the Bridge. Apple Silicon
 *   only, uses Apple's MLX framework against unified memory. Faster than
 *   ComfyUI-on-MPS for the models it supports (Wan 2.2, LTX-2). Default
 *   for Apple Silicon Macs with ≥32 GB unified memory.
 */
export type VideoBackendKind = 'comfy' | 'mlx'

// ─── Optimal defaults per model type (research-backed: Draw Things, Fooocus, ComfyUI) ───

export const MODEL_TYPE_DEFAULTS: Record<ModelType, {
  steps: number; cfgScale: number; sampler: string; scheduler: string
  width: number; height: number; frames?: number; fps?: number
}> = {
  sd15:        { steps: 25, cfgScale: 7.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512 },
  sdxl:        { steps: 25, cfgScale: 7.0, sampler: 'dpmpp_2m',       scheduler: 'karras', width: 1024, height: 1024 },
  flux:        { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  flux2:       { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  zimage:      { steps: 12, cfgScale: 3.5, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  ernie_image: { steps: 20, cfgScale: 4.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  wan:         { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 16 },
  wan22:       { steps: 30, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 576, frames: 49, fps: 24 },
  hunyuan:     { steps: 30, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 45, fps: 15 },
  ltx:         { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 768,  height: 512, frames: 97, fps: 24 },
  mochi:       { steps: 40, cfgScale: 4.5, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 24 },
  cosmos:      { steps: 30, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1280, height: 704, frames: 57, fps: 24 },
  cogvideo:    { steps: 50, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 720,  height: 480, frames: 49, fps: 8  },
  svd:         { steps: 25, cfgScale: 2.5, sampler: 'euler',           scheduler: 'karras', width: 1024, height: 576, frames: 25, fps: 6  },
  framepack:   { steps: 30, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 832,  height: 480, frames: 33, fps: 16 },
  pyramidflow: { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1280, height: 768, frames: 121, fps: 24 },
  allegro:     { steps: 100, cfgScale: 7.5, sampler: 'euler',          scheduler: 'normal', width: 1280, height: 720, frames: 88, fps: 15 },
  // 2.5.8 specialized local lanes (see comfyui.ts MODEL_TYPE_DEFAULTS for the
  // node-default provenance). ACE width/height are unused by the audio graph.
  ace:         { steps: 50, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  wans2v:      { steps: 20, cfgScale: 6.0, sampler: 'euler',           scheduler: 'simple', width: 832,  height: 480, frames: 77, fps: 16 },
  wananimate:  { steps: 20, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 832,  height: 480, frames: 77, fps: 16 },
  wanvace:     { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 832,  height: 480, frames: 81, fps: 16 },
  // The AnimateDiff lane runs on an SD1.5 checkpoint plus a motion module, so
  // these are the SD1.5 numbers with a frame count (see comfyui.ts
  // MODEL_TYPE_DEFAULTS.animatediff, which the workflow builder reads).
  animatediff: { steps: 20, cfgScale: 7.5, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512, frames: 16, fps: 8  },
  unknown:     { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1024, height: 1024 },
}

export interface GalleryItem {
  id: string
  type: 'image' | 'video' | 'audio'
  filename: string
  comfyType?: string
  subfolder: string
  prompt: string
  negativePrompt: string
  model: string
  modelType: ModelType
  seed: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  width: number
  height: number
  batchSize: number
  createdAt: number
  builderUsed?: 'dynamic' | 'legacy' | 'custom'
  resolvedVAE?: string
  resolvedCLIP?: string
  /** Self-contained media URL for backends that don't serve files over
   *  ComfyUI's /view route (e.g. MLX on Apple Silicon): a `data:` PNG URL for
   *  MLX images, or a `blob:` URL for MLX video (built from bytes read via
   *  the `read_media_file` Tauri command — the CSP's media-src allows `blob:`
   *  but not `data:` for video). When set, display + download read from this
   *  instead of filename/subfolder. In-memory only — partialize strips it so
   *  media bytes never hit the localStorage quota (and a blob: URL wouldn't
   *  survive a reload anyway). */
  dataUrl?: string
  /** Cloud jobs: signed result URL from the render queue. Display prefers
   *  `remoteUrl` → `dataUrl` → the ComfyUI /view path (filename/subfolder). */
  remoteUrl?: string
  /** Cloud jobs: TEE attestation receipt (null on non-attested lanes). */
  attestation?: { quote: string; verify_url: string } | null
  /** Cloud jobs: the render_jobs id, so the client can re-poll/re-sign. */
  jobId?: string
  /** Which redesign intent produced this item (gallery tagging). */
  intent?: CreateIntent
  /** MLX video (Mac, Apple Silicon): absolute filesystem path of the finished
   *  mp4, as returned by `video_generate`'s `output` field. Playback/download
   *  go through `dataUrl` (a blob: URL, see above) instead — this is kept
   *  around as the real on-disk path for any future save-to-disk flow that
   *  wants to reference the file directly instead of re-encoding the blob. */
  localPath?: string
  /** Runtime-only (stripped by partialize): the item's media failed to load
   *  and can't be recovered right now — a local ComfyUI item while the engine
   *  is unreachable. Tiles render an honest offline state and Download
   *  disables instead of silently no-oping. */
  unavailable?: boolean
}

interface CreateState {
  mode: 'image' | 'video'
  videoBackend: VideoBackendKind
  /** Set once auto-detect has run (or the user clicked the backend picker)
   *  so we don't keep overriding their choice on every launch. */
  videoBackendInitialized: boolean
  imageSubMode: 'text2img' | 'img2img'
  prompt: string
  negativePrompt: string
  imageModel: string
  imageModelType: ModelType
  videoModel: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
  frames: number
  fps: number
  denoise: number  // Denoise strength for I2I (0.0–1.0)
  /** Native text-to-image latent upscale + refinement pass (local ComfyUI). */
  hiresFixEnabled: boolean
  hiresScale: number
  hiresDenoise: number
  hiresSteps: number
  hiresUpscaleMethod: HiresUpscaleMethod
  i2iImage: string | null  // Uploaded image filename for I2I
  i2vImage: string | null  // Uploaded image filename for I2V models (SVD, FramePack)

  // ── redesign additions: flat-intent model + unified inputs + extra params ──
  videoSubMode: 't2v' | 'i2v'
  removebg: boolean
  /** Cloud-only utility intents (upscale/eraser); null = normal generate axis. */
  utilityOp: UtilityOp | null
  /** 2.5.8 cloud-only categories (character/lipsync/music/extend/motion);
   *  null = normal generate axis. Runtime-only like utilityOp. */
  cloudOp: CloudOp | null
  /** Character-Studio sub-surface: train a new character vs generate with one. */
  characterTab: 'train' | 'use'
  /** Character-Studio training set (4-30 images). Runtime-only (blobs). */
  trainImages: MediaRef[]
  /** Character-Studio trigger word — the token that summons the character. */
  triggerWord: string
  /** Local training length (musubi steps). Quality/time tradeoff, persisted. */
  trainSteps: number
  /** The shelf character selected for use-mode generation. Runtime-only. */
  selectedCharacter: CharacterRef | null
  /** Lipsync speech / voice-clone reference audio. Runtime-only (blob). */
  audioInput: MediaRef | null
  /** Lipsync speech from a prior cloud voice/music render instead of an
   *  upload ({jobId} → fresh signed audio_url at submit). Runtime-only. */
  voiceFromJob: { jobId: string; label: string } | null
  /** Lipsync base clip / motion driving video. Runtime-only (blob). */
  videoInput: MediaRef | null
  /** Extend: the prior cloud render to continue ({jobId} → fresh signed URL
   *  at submit). Runtime-only. */
  extendSource: { jobId: string; url: string; label: string } | null
  /** Music track length in seconds (billed per second on the cloud). */
  musicDuration: number
  /** Music: optional lyrics passed to models that take them. Runtime-only. */
  musicLyrics: string
  /** Music: the how-to note next to the lyrics box was opened once, which
   *  retires its notification dot. Persisted. */
  musicHowtoSeen: boolean
  /** Upscale target for the cloud super-resolution endpoint. */
  targetResolution: '2k' | '4k' | '8k'
  showNegative: boolean
  selectedLoras: { name: string; strength: number }[]
  selectedVae: string
  clipSkip: number
  growMaskBy: number  // inpaint mask edge feather (VAEEncodeForInpaint grow_mask_by)
  /** Unified Stage input slot (runtime-only). On the local path source.filename
   *  maps to i2iImage/i2vImage; on the cloud path it is a render-inputs path. */
  source: ImageRef | null
  sourceSetAt: number
  mask: ImageRef | null
  /** Runtime-only: local (Bridge) vs cloud (/api/jobs), derived from session. */
  backend: CreateBackend
  /** Runtime-only: hosted model slugs (lib/render/cloud-models) for the cloud
   *  backend — separate from the persisted local checkpoint names. */
  cloudImageModel: string
  cloudVideoModel: string
  /** Runtime-only: the model picked inside a 2.5.8 specialized intent
   *  (trainer/lipsync/music/extend/motion). One slot for all — modelForOp
   *  coerces a stale cross-intent pick onto the op's own list. */
  cloudOpModel: string
  /** Runtime-only: the LOCAL model picked inside a specialized lane (ACE
   *  checkpoint / S2V UNet / Animate-VACE UNet). One slot for all lanes —
   *  resolveLocalOpPick coerces a stale cross-lane pick onto the lane's list
   *  (the same one-rule guard the cloud picker got after take-01). */
  localOpModel: string
  /** Bumped when the character shelf changed (training delivered / deleted)
   *  so the Character-Studio surface refetches /api/loras. */
  charactersVersion: number
  /** Runtime-only: which local custom-node capabilities are installed. */
  caps: Record<'rmbg' | 'inpaint-nodes' | 'dwpose', boolean>

  isGenerating: boolean
  /** Runtime-only: the user-managed ComfyUI (0.19+) blocked the WebView's
   *  cross-origin media/WS with a Sec-Fetch 403. Set when the proxy blob
   *  fallback rescues a /view that the direct <video>/<img> couldn't load, so
   *  the Create tab can show the exact --enable-cors-header fix (#75). */
  comfyCorsBlocked: boolean
  progress: number
  progressText: string
  progressPhase: ProgressPhase
  currentPromptId: string | null
  error: string | null
  lastGenTime: string | null
  gallery: GalleryItem[]
  promptHistory: string[]
  /** Runtime-only (not persisted): populated by useCreate.fetchModels so the
   * header-level CreateTopControls can render its model dropdown + Lichtschalter
   * without hosting its own ComfyUI fetching. */
  imageModelList: ClassifiedModel[]
  videoModelList: ClassifiedModel[]
  /** 2.5.8 local lanes: installed specialized models, mirrored by fetchModels
   *  like the image/video lists (music ACE checkpoints, S2V UNets,
   *  Animate/VACE UNets). Runtime-only. */
  audioModelList: ClassifiedModel[]
  lipsyncModelList: ClassifiedModel[]
  motionModelList: ClassifiedModel[]
  comfyRunning: boolean
  /** Bug A (v2.4.5) + #72 (bob): resolver for the VHS_VideoCombine install
   *  prompt. Runtime-only — useCreate sets it when a video gen would fall
   *  back to animated .webp; the modal resolves with the user's choice. */
  vhsInstallPrompt: ((choice: 'install' | 'webp' | 'cancel') => void) | null

  setMode: (mode: 'image' | 'video') => void
  setVideoBackend: (backend: VideoBackendKind) => void
  setImageSubMode: (subMode: 'text2img' | 'img2img') => void
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setImageModel: (model: string, type: ModelType) => void
  setVideoModel: (model: string) => void
  setSampler: (sampler: string) => void
  setScheduler: (scheduler: string) => void
  setSteps: (steps: number) => void
  setCfgScale: (cfgScale: number) => void
  setSize: (width: number, height: number) => void
  setSeed: (seed: number) => void
  setBatchSize: (batchSize: number) => void
  setFrames: (frames: number) => void
  setFps: (fps: number) => void
  setDenoise: (denoise: number) => void
  setHiresFixEnabled: (enabled: boolean) => void
  setHiresScale: (scale: number) => void
  setHiresDenoise: (denoise: number) => void
  setHiresSteps: (steps: number) => void
  setHiresUpscaleMethod: (method: HiresUpscaleMethod) => void
  setI2iImage: (image: string | null) => void
  setI2vImage: (image: string | null) => void

  // ── redesign additions ──
  intent: () => CreateIntent
  setIntent: (intent: CreateIntent) => void
  toggleNegative: () => void
  toggleLora: (name: string) => void
  setLoraStrengthFor: (name: string, strength: number) => void
  clearLoras: () => void
  setSelectedVae: (name: string) => void
  setClipSkip: (n: number) => void
  setGrowMaskBy: (n: number) => void
  setTargetResolution: (r: '2k' | '4k' | '8k') => void
  setCharacterTab: (tab: 'train' | 'use') => void
  addTrainImages: (imgs: MediaRef[]) => void
  removeTrainImage: (name: string) => void
  clearTrainImages: () => void
  setTriggerWord: (w: string) => void
  setTrainSteps: (n: number) => void
  setSelectedCharacter: (c: CharacterRef | null) => void
  setAudioInput: (m: MediaRef | null) => void
  setVoiceFromJob: (v: { jobId: string; label: string } | null) => void
  setVideoInput: (m: MediaRef | null) => void
  bumpCharactersVersion: () => void
  setCloudOpModel: (id: string) => void
  setLocalOpModel: (name: string) => void
  setAudioModelList: (list: ClassifiedModel[]) => void
  setLipsyncModelList: (list: ClassifiedModel[]) => void
  setMotionModelList: (list: ClassifiedModel[]) => void
  setExtendSource: (s: { jobId: string; url: string; label: string } | null) => void
  setMusicDuration: (s: number) => void
  setMusicLyrics: (l: string) => void
  setMusicHowtoSeen: (v: boolean) => void
  setSource: (img: ImageRef | null) => void
  setMask: (img: ImageRef | null) => void
  setBackend: (backend: CreateBackend) => void
  setCloudImageModel: (id: string) => void
  setCloudVideoModel: (id: string) => void
  setCaps: (caps: Record<'rmbg' | 'inpaint-nodes' | 'dwpose', boolean>) => void
  resetParamsToModelDefaults: () => void

  setIsGenerating: (generating: boolean) => void
  setComfyCorsBlocked: (blocked: boolean) => void
  setProgress: (progress: number, text?: string) => void
  setProgressPhase: (phase: ProgressPhase) => void
  setCurrentPromptId: (id: string | null) => void
  setVhsInstallPrompt: (resolver: ((choice: 'install' | 'webp' | 'cancel') => void) | null) => void
  setError: (error: string | null) => void
  setLastGenTime: (time: string | null) => void
  addToGallery: (item: GalleryItem) => void
  /** Patch a gallery item in place (e.g. a lazily re-signed remoteUrl). */
  updateGalleryItem: (id: string, patch: Partial<GalleryItem>) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
  addToPromptHistory: (prompt: string) => void
  setImageModelList: (list: ClassifiedModel[]) => void
  setVideoModelList: (list: ClassifiedModel[]) => void
  setComfyRunning: (running: boolean) => void
}

/** The gallery keeps the newest N renders. */
const GALLERY_CAP = 200

/**
 * Hand a gallery item's in-memory media back to the renderer.
 *
 * `dataUrl` is a `blob:` URL for everything produced locally — MLX video via
 * `readVideoAsBlobUrl`, images restored from disk via `galleryUrl.ts` — and a
 * blob: URL pins its bytes for the lifetime of the document unless somebody
 * revokes it. Nothing ever did, so a long Create session grew monotonically
 * until the WebView ran out of memory. Every path that drops an item from the
 * gallery goes through here.
 *
 * `releaseVideoBlobUrl` ignores anything that is not a `blob:` string, so
 * cloud `https://` results and legacy `data:` previews pass through untouched.
 */
function releaseItemMedia(item: GalleryItem): void {
  releaseVideoBlobUrl(item.dataUrl)
}

/**
 * Replacing a staged input file must free the one it replaces.
 *
 * `mediaRefFrom` in SpecialIntentControls mints a fresh `blob:` URL for every
 * pick, so re-choosing a driving video or a voice clip five times used to pin
 * five files in the renderer with only the last one reachable. The lifetime is
 * closed HERE rather than at the call site because these two setters are the
 * only way a slot is ever written — a future caller cannot forget.
 *
 * Only the preview URL is dropped; every consumer (local + cloud upload) reads
 * `MediaRef.blob`, which is unaffected by revoking the URL.
 */
function releaseReplacedMediaRef(previous: MediaRef | null, next: MediaRef | null): void {
  if (!previous || previous.url === next?.url) return
  if (previous.url.startsWith('blob:')) URL.revokeObjectURL(previous.url)
}

export const useCreateStore = create<CreateState>()(
  persist(
    // Explicit param/return types: LU compiles with `strict: true` (the web
    // repo does not), and zustand v5's persist loses contextual typing of the
    // state-creator there — annotating restores set/get and setter types.
    (
      set: (p: Partial<CreateState> | ((s: CreateState) => Partial<CreateState>)) => void,
      get: () => CreateState,
    ): CreateState => ({
      mode: 'image',
      // Default to ComfyUI; AppShell/Onboarding flips this to 'mlx' on
      // Apple Silicon Macs with enough RAM after the bridge reports
      // arch + memory. Persisted across sessions so the auto-detect only
      // runs once.
      videoBackend: 'comfy' as VideoBackendKind,
      videoBackendInitialized: false,
      imageSubMode: 'text2img' as 'text2img' | 'img2img',
      prompt: '',
      negativePrompt: '',
      imageModel: '',
      imageModelType: 'unknown' as ModelType,
      videoModel: '',
      sampler: 'euler',
      scheduler: 'normal',
      steps: 20,
      cfgScale: 7,
      width: 1024,
      height: 1024,
      seed: -1,
      batchSize: 1,
      frames: 24,
      fps: 8,
      denoise: 0.7,
      hiresFixEnabled: false,
      hiresScale: 1.5,
      hiresDenoise: 0.5,
      hiresSteps: 12,
      hiresUpscaleMethod: 'nearest-exact' as HiresUpscaleMethod,
      i2iImage: null,
      i2vImage: null,

      // ── redesign additions ──
      videoSubMode: 't2v' as 't2v' | 'i2v',
      removebg: false,
      utilityOp: null as UtilityOp | null,
      cloudOp: null as CloudOp | null,
      characterTab: 'train' as 'train' | 'use',
      trainImages: [] as MediaRef[],
      triggerWord: '',
      trainSteps: 1200,
      selectedCharacter: null as CharacterRef | null,
      audioInput: null as MediaRef | null,
      voiceFromJob: null as { jobId: string; label: string } | null,
      videoInput: null as MediaRef | null,
      extendSource: null as { jobId: string; url: string; label: string } | null,
      musicDuration: 60,
      musicLyrics: '',
      musicHowtoSeen: false,
      targetResolution: '4k' as '2k' | '4k' | '8k',
      showNegative: false,
      selectedLoras: [] as { name: string; strength: number }[],
      selectedVae: 'auto',
      clipSkip: 0,
      growMaskBy: 6,
      source: null as ImageRef | null,
      sourceSetAt: 0,
      mask: null as ImageRef | null,
      backend: 'local' as CreateBackend,
      cloudImageModel: '',
      cloudVideoModel: '',
      cloudOpModel: '',
      localOpModel: '',
      charactersVersion: 0,
      caps: { rmbg: false, 'inpaint-nodes': false, dwpose: false } as Record<'rmbg' | 'inpaint-nodes' | 'dwpose', boolean>,

      isGenerating: false,
      comfyCorsBlocked: false,
      progress: 0,
      progressText: '',
      progressPhase: 'idle' as ProgressPhase,
      currentPromptId: null,
      error: null,
      lastGenTime: null,
      gallery: [],
      promptHistory: [],
      imageModelList: [],
      videoModelList: [],
      audioModelList: [],
      lipsyncModelList: [],
      motionModelList: [],
      comfyRunning: false,
      vhsInstallPrompt: null,

      setVideoBackend: (videoBackend) => set({ videoBackend, videoBackendInitialized: true }),
      setMode: (mode) => set((state) => {
        // Reset parameters to the correct defaults when switching modes
        // This prevents image resolution (1024x1024) leaking into video mode (causes HTTP 500)
        if (mode === 'video' && state.videoModel) {
          const type = classifyModel(state.videoModel)
          const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
            ...(defaults.frames ? { frames: defaults.frames } : {}),
            ...(defaults.fps ? { fps: defaults.fps } : {}),
          }
        }
        if (mode === 'image' && state.imageModel) {
          const defaults = MODEL_TYPE_DEFAULTS[state.imageModelType] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
          }
        }
        return { mode }
      }),
      setImageSubMode: (subMode) => set({ imageSubMode: subMode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setImageModel: (model, type) => {
        const defaults = MODEL_TYPE_DEFAULTS[type]
        set({
          imageModel: model, imageModelType: type,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
        })
      },
      setVideoModel: (model) => {
        const type = classifyModel(model)
        const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
        // Lightning/rapid merges are distilled to few steps at cfg 1 — the
        // architecture defaults (30 steps, cfg 5+) render them to mush.
        const lightning = /rapid|lightning|lightx2v/i.test(model)
        set({
          videoModel: model,
          steps: lightning ? 6 : defaults.steps, cfgScale: lightning ? 1.0 : defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
          ...(defaults.frames ? { frames: defaults.frames } : {}),
          ...(defaults.fps ? { fps: defaults.fps } : {}),
        })
      },
      setSampler: (sampler) => set({ sampler }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSteps: (steps) => set({ steps: Math.max(1, Math.min(200, Math.floor(steps))) }),
      setCfgScale: (cfgScale) => set({ cfgScale: Math.max(0, Math.min(30, cfgScale)) }),
      setSize: (width, height) => set({
        width: Math.max(64, Math.min(4096, Math.floor(width))),
        height: Math.max(64, Math.min(4096, Math.floor(height))),
      }),
      setSeed: (seed) => set({ seed: Math.floor(seed) }),
      setBatchSize: (batchSize) => set({ batchSize: Math.max(1, Math.min(8, Math.floor(batchSize))) }),
      setFrames: (frames) => set({ frames: Math.max(1, Math.min(120, Math.floor(frames))) }),
      setFps: (fps) => set({ fps: Math.max(1, Math.min(60, Math.floor(fps))) }),
      setDenoise: (denoise) => set({ denoise: Math.max(0, Math.min(1, denoise)) }),
      setHiresFixEnabled: (hiresFixEnabled) => set({ hiresFixEnabled }),
      setHiresScale: (hiresScale) => set({
        hiresScale: Math.max(1.1, Math.min(3, Math.round(hiresScale * 10) / 10)),
      }),
      setHiresDenoise: (hiresDenoise) => set({
        hiresDenoise: Math.max(0.05, Math.min(1, hiresDenoise)),
      }),
      setHiresSteps: (hiresSteps) => set({
        hiresSteps: Math.max(1, Math.min(200, Math.floor(hiresSteps))),
      }),
      setHiresUpscaleMethod: (hiresUpscaleMethod) => set({ hiresUpscaleMethod }),
      setI2iImage: (image) => set({ i2iImage: image }),
      setI2vImage: (image) => set({ i2vImage: image }),

      // ── redesign additions ──
      intent: () => deriveIntent(get()),
      setIntent: (intent) => set((s) => {
        // Clear intent-incompatible inputs: intents without a source drop both;
        // removebg/animate keep the source but drop a stale mask. Video/animate
        // mirror setMode's reset so image resolution never leaks into video.
        // A stale error from the previous intent never carries over.
        const dropAll = { source: null, mask: null, sourceSetAt: 0 }
        const base = { removebg: false, utilityOp: null, cloudOp: null, error: null }
        switch (intent) {
          // ── 2.5.8 cloud categories. Inputs specific to each (train set,
          // audio, driving video, extend pick) live in their own slots and are
          // only read by their own intent — no cross-intent bleed to clear.
          case 'character':
            return { ...base, cloudOp: 'character' as const, mode: 'image' as const, imageSubMode: 'text2img' as const, ...dropAll }
          case 'lipsync': {
            // Keeps the source slot (the portrait a photo-avatar model speaks).
            // Adopts the S2V architecture defaults so the local lane never
            // inherits an Image-tab 1024×1024 into a 14B video graph.
            const d = MODEL_TYPE_DEFAULTS.wans2v
            return { ...base, cloudOp: 'lipsync' as const, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
          case 'music': {
            // Pin the underlying mode: an inherited img2img mode would trip
            // the local flow's "add a source image" guard for a prompt-only op.
            const d = MODEL_TYPE_DEFAULTS.ace
            return { ...base, cloudOp: 'music' as const, mode: 'image' as const, imageSubMode: 'text2img' as const, ...dropAll,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler }
          }
          case 'extend': {
            // The local lane continues from the picked clip's last frame —
            // regular I2V models, regular video defaults.
            const d = MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown
            return { ...base, cloudOp: 'extend' as const, mode: 'video' as const, videoSubMode: 't2v' as const, ...dropAll,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
          case 'motion': {
            // Keeps the source slot (the character image the video drives).
            const d = MODEL_TYPE_DEFAULTS.wananimate
            return { ...base, cloudOp: 'motion' as const, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
          case 'image':    return { ...base, mode: 'image' as const, imageSubMode: 'text2img' as const, ...dropAll }
          case 'edit':     return { ...base, mode: 'image' as const, imageSubMode: 'img2img' as const }
          case 'removebg': return { ...base, removebg: true, mode: 'image' as const, imageSubMode: 'img2img' as const, mask: null }
          // Cloud-only utility endpoints: upscale keeps the source (no mask,
          // no prompt); eraser keeps source + mask (paint what to remove).
          case 'upscale':  return { ...base, utilityOp: 'upscale' as const, mode: 'image' as const, imageSubMode: 'img2img' as const, mask: null }
          case 'eraser':   return { ...base, utilityOp: 'eraser' as const, mode: 'image' as const, imageSubMode: 'img2img' as const }
          case 'video': {
            const d = MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown
            return { ...base, mode: 'video' as const, videoSubMode: 't2v' as const, ...dropAll,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
          case 'animate': {
            const d = MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown
            return { ...base, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
        }
      }),
      toggleNegative: () => set((s) => ({ showNegative: !s.showNegative })),
      toggleLora: (name) => set((s) => ({ selectedLoras: s.selectedLoras.some((l) => l.name === name) ? s.selectedLoras.filter((l) => l.name !== name) : [...s.selectedLoras, { name, strength: 0.8 }] })),
      setLoraStrengthFor: (name, strength) => set((s) => ({ selectedLoras: s.selectedLoras.map((l) => l.name === name ? { ...l, strength: Math.max(0, Math.min(2, strength)) } : l) })),
      clearLoras: () => set({ selectedLoras: [] }),
      setSelectedVae: (name) => set({ selectedVae: name || 'auto' }),
      setClipSkip: (n) => set({ clipSkip: Math.max(0, Math.min(12, Math.floor(n))) }),
      setGrowMaskBy: (n) => set({ growMaskBy: Math.max(0, Math.min(64, Math.floor(n))) }),
      setTargetResolution: (targetResolution) => set({ targetResolution }),
      setCharacterTab: (characterTab) => set({ characterTab }),
      // Cap at 30 (the server's image_paths limit) and de-dupe by filename so
      // a re-drop of the same files doesn't double the set.
      addTrainImages: (imgs) => set((s) => {
        const have = new Set(s.trainImages.map((i) => i.name))
        return { trainImages: [...s.trainImages, ...imgs.filter((i) => !have.has(i.name))].slice(0, 30) }
      }),
      removeTrainImage: (name) => set((s) => ({ trainImages: s.trainImages.filter((i) => i.name !== name) })),
      clearTrainImages: () => set({ trainImages: [] }),
      setTriggerWord: (w) => set({ triggerWord: w.replace(/\s+/g, '').slice(0, 30) }),
      // Same clamp as the Rust command so the UI can never book a rejected run.
      setTrainSteps: (n) => set({ trainSteps: Math.max(100, Math.min(4000, Math.floor(n))) }),
      setSelectedCharacter: (selectedCharacter) => set({ selectedCharacter }),
      // Upload and voice-pick are mutually exclusive speech sources.
      setAudioInput: (audioInput) => {
        releaseReplacedMediaRef(get().audioInput, audioInput)
        set({ audioInput, ...(audioInput ? { voiceFromJob: null } : {}) })
      },
      setVoiceFromJob: (voiceFromJob) => set({ voiceFromJob, ...(voiceFromJob ? { audioInput: null } : {}) }),
      setVideoInput: (videoInput) => {
        releaseReplacedMediaRef(get().videoInput, videoInput)
        set({ videoInput })
      },
      bumpCharactersVersion: () => set((s) => ({ charactersVersion: s.charactersVersion + 1 })),
      setCloudOpModel: (cloudOpModel) => set({ cloudOpModel }),
      // Picking a lane model adopts its architecture defaults (like
      // setVideoModel does) — an inherited 1024×1024 from the Image tab would
      // OOM a 14B S2V run on consumer VRAM.
      setLocalOpModel: (localOpModel) => {
        const d = MODEL_TYPE_DEFAULTS[classifyModel(localOpModel)]
        set(d
          ? {
              localOpModel,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height,
              ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}),
            }
          : { localOpModel })
      },
      setAudioModelList: (audioModelList) => set({ audioModelList }),
      setLipsyncModelList: (lipsyncModelList) => set({ lipsyncModelList }),
      setMotionModelList: (motionModelList) => set({ motionModelList }),
      setExtendSource: (extendSource) => set({ extendSource }),
      setMusicDuration: (s2) => set({ musicDuration: Math.max(5, Math.min(240, Math.floor(s2))) }),
      setMusicLyrics: (musicLyrics) => set({ musicLyrics: musicLyrics.slice(0, 2000) }),
      setMusicHowtoSeen: (musicHowtoSeen) => set({ musicHowtoSeen }),
      setSource: (source) => set({ source, sourceSetAt: source ? Date.now() : 0, ...(source ? {} : { mask: null }) }),
      setMask: (mask) => set({ mask }),
      // Flipping to local clears the intents that have no local lane
      // (upscale/eraser plus character training — all hosted-only) so the
      // surface never strands on a dead op the IntentBar no longer shows. Edit
      // keeps its state since 2.5.7 (checkpoint mask inpaint), removebg keeps
      // its RMBG lane, and animate keeps its i2v state since 2026-07-17 — the
      // local I2V lane is back (buildDynamicWorkflow wires the family's
      // image-to-video node).
      setBackend: (backend) =>
        set((s) => {
          if (backend !== 'local') return { backend }
          const patch: Record<string, unknown> = { backend }
          if (s.utilityOp) Object.assign(patch, { utilityOp: null, mask: null, error: null })
          // music/lipsync/extend/motion (2.5.8) and character (2.6.0, local
          // musubi trainer) run locally, so a backend flip keeps them
          // selected; only the genuinely hosted-only ops (upscale/eraser)
          // drop. LOCAL_LANE_OPS is the single source of truth.
          if (s.cloudOp && !LOCAL_LANE_OPS.has(s.cloudOp)) {
            Object.assign(patch, { cloudOp: null, error: null })
          }
          return patch
        }),
      setCloudImageModel: (cloudImageModel) => set({ cloudImageModel }),
      setCloudVideoModel: (cloudVideoModel) => set({ cloudVideoModel }),
      setCaps: (caps) => set({ caps }),
      resetParamsToModelDefaults: () => {
        const s = get()
        const d = s.mode === 'video'
          ? (MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown)
          : MODEL_TYPE_DEFAULTS[s.imageModelType]
        set({
          sampler: d.sampler,
          scheduler: d.scheduler,
          steps: d.steps,
          cfgScale: d.cfgScale,
          width: d.width,
          height: d.height,
          hiresFixEnabled: false,
          hiresScale: 1.5,
          hiresDenoise: 0.5,
          hiresSteps: 12,
          hiresUpscaleMethod: 'nearest-exact',
          ...(d.frames ? { frames: d.frames } : {}),
          ...(d.fps ? { fps: d.fps } : {}),
        })
      },

      setIsGenerating: (generating) => set({ isGenerating: generating, ...(generating ? {} : { progressPhase: 'idle' as ProgressPhase }) }),
      setComfyCorsBlocked: (blocked) => set({ comfyCorsBlocked: blocked }),
      setProgress: (progress, text) => set({ progress, progressText: text ?? '' }),
      setProgressPhase: (phase) => set({ progressPhase: phase }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      setVhsInstallPrompt: (resolver) => set({ vhsInstallPrompt: resolver }),
      setError: (error) => set({ error }),
      setLastGenTime: (time) => set({ lastGenTime: time }),
      addToGallery: (item) => set((s) => {
        const next = [item, ...s.gallery]
        // The cap used to drop the oldest renders silently, taking the only
        // reference to their blob: URLs with them — the bytes stayed pinned
        // for the rest of the session with nothing left to revoke them by.
        for (const dropped of next.slice(GALLERY_CAP)) releaseItemMedia(dropped)
        return { gallery: next.slice(0, GALLERY_CAP) }
      }),
      updateGalleryItem: (id, patch) =>
        // NOT revoking a replaced dataUrl here on purpose: a patch lands while
        // the tile is on screen (a lazy re-sign, a restore-from-disk), and
        // revoking a URL an <img>/<video> may still be loading would break the
        // very media this patch exists to fix.
        set((s) => ({ gallery: s.gallery.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
      removeFromGallery: (id) => set((s) => {
        const gone = s.gallery.find((g) => g.id === id)
        if (gone) releaseItemMedia(gone)
        return { gallery: s.gallery.filter((g) => g.id !== id) }
      }),
      clearGallery: () => set((s) => {
        for (const g of s.gallery) releaseItemMedia(g)
        return { gallery: [] }
      }),
      addToPromptHistory: (prompt) => set((s) => {
        const filtered = s.promptHistory.filter(p => p !== prompt)
        return { promptHistory: [prompt, ...filtered].slice(0, 50) }
      }),
      setImageModelList: (list) => set({ imageModelList: list }),
      setVideoModelList: (list) => set({ videoModelList: list }),
      setComfyRunning: (running) => set({ comfyRunning: running }),
    }),
    {
      name: 'create-store',
      partialize: (state) => ({
        mode: state.mode,
        videoBackend: state.videoBackend,
        videoBackendInitialized: state.videoBackendInitialized,
        imageModel: state.imageModel,
        imageModelType: state.imageModelType,
        videoModel: state.videoModel,
        sampler: state.sampler,
        scheduler: state.scheduler,
        steps: state.steps,
        cfgScale: state.cfgScale,
        width: state.width,
        height: state.height,
        batchSize: state.batchSize,
        frames: state.frames,
        fps: state.fps,
        denoise: state.denoise,
        hiresFixEnabled: state.hiresFixEnabled,
        hiresScale: state.hiresScale,
        hiresDenoise: state.hiresDenoise,
        hiresSteps: state.hiresSteps,
        hiresUpscaleMethod: state.hiresUpscaleMethod,
        // Media bytes never go to localStorage — a handful of multi-MB base64
        // dataUrls would blow the origin quota (~5-10 MB in WebView2/WKWebView)
        // and every subsequent set() would throw, killing ALL create-store
        // persistence. Cloud items carry remoteUrl + jobId and re-sign lazily.
        gallery: state.gallery.map(({ dataUrl, unavailable, ...g }: GalleryItem) => g),
        promptHistory: state.promptHistory,
        // ── redesign additions (advanced params only; runtime inputs
        //    source/mask/backend/caps stay unpersisted). No version bump: these
        //    are additive and merge() backfills missing keys from defaults. ──
        showNegative: state.showNegative,
        selectedLoras: state.selectedLoras,
        selectedVae: state.selectedVae,
        clipSkip: state.clipSkip,
        growMaskBy: state.growMaskBy,
        // 2.5.8 cloud categories: only the cheap scalar prefs persist — the
        // staged media (blobs / object URLs) and cloudOp are runtime-only.
        musicDuration: state.musicDuration,
        musicHowtoSeen: state.musicHowtoSeen,
        triggerWord: state.triggerWord,
        trainSteps: state.trainSteps,
      }),
      // Future schema bumps hook into migrate. NOTE: zustand only invokes it
      // when the stored blob carries a NUMERIC version that differs — legacy
      // pre-version blobs skip it entirely, so their fixups must live in merge.
      version: 1,
      migrate: (persisted: any) => persisted,
      merge: (persisted: any, current: any) => {
        // Never let runtime-only fields rehydrate (a foreign/corrupt blob must
        // not flip the backend axis or inject a stale source/mask), backfill
        // missing keys from defaults, and fix up legacy pre-version blobs
        // ('i2i' mode from the v2.3.0 refactor).
        const { backend, source, mask, caps, isGenerating, comfyCorsBlocked, ...safe } =
          persisted ?? {}
        const merged = { ...current, ...safe }
        if (merged.mode === 'i2i') {
          merged.mode = 'image'
          merged.imageSubMode = 'img2img'
        }
        return merged
      },
    }
  )
)
