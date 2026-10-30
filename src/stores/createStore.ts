import { MAX_LOCAL_FRAMES } from '../lib/video-length'
import { wanSamplingFor, type VideoSpeed } from '../lib/wan-speed'
import { MAX_LONG_SECONDS, type LongVideoMode } from '../lib/long-video'
import { create } from 'zustand'
import { maxTrainImages } from '../lib/train-image-cap'
import { MAX_STORED_REFERENCES } from '../lib/edit-references'
import { clampImageCount } from '../lib/render/image-count'
import { BATCH_INTENTS, type BatchRunState } from '../lib/batch-edit'
import type { FixupPrompt } from '../lib/render-fixups'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { TRAIN_STEPS_DEFAULT, TRAIN_VRAM_PRESET_DEFAULT, isTrainVramPreset, type TrainVramPreset } from '../lib/trainer-presets'
import { TRAIN_KIND_DEFAULT, isTrainKind, trainPresetsFor, trainStepsDefaultFor, type TrainKind } from '../lib/train-kind'
import { TRAIN_CAPTION_MAX } from '../lib/train-captions'
import { isMobile } from '../lib/device-kind'
import { isRecord } from '../types/json-guards'
import { cleanFolderName, newFolderId, sanitizeFolders, FOLDER_CAP, type GalleryFolder } from '../lib/gallery-folders'

/**
 * Fields a persisted blob must never put back into live state: they steer the
 * backend axis or carry staged media (source image, mask, capability probe
 * results, the in-flight flag). Everything else in the blob is a preference.
 */
const RUNTIME_ONLY_KEYS: readonly string[] = [
  'backend', 'source', 'mask', 'references', 'endImage', 'imageReferences', 'caps', 'isGenerating', 'comfyCorsBlocked',
  // A queue of source images from yesterday must never start a run today.
  'batchSources', 'batchRun', 'batchOriginal',
  // Ein gespeicherter Preis von gestern ist eine Luege (siehe partialize
  // unten): auch wenn ein fremder/aelterer Blob ihn doch mitbringt, darf er
  // nie zurueckkommen.
  'cloudStudioCredits',
  // Die Zahl der Bilder pro Lauf ist Laufzeit: eine Zahl von gestern buchte
  // sonst unbemerkt mehrfach.
  'cloudImageCount',
  // The open gallery folder files new results, so it is never carried over.
  'galleryFolderOpen',
  // Review A kleiner Punkt 1 (studio-r2): the cloud video length selection,
  // own fields since this bugfix. Session-scratch like source/mask, not a
  // preference worth remembering across restarts.
  'cloudFrames', 'cloudFps',
  // Belongs to the tab switch that put it aside, not to a later session.
  'imageLaneKept',
  // A scene from yesterday must not ride along into today's run.
  'videoShots',
  // 3.0.8 D28: the captions belong to the staged photos, which are runtime
  // only (blobs); a caption from yesterday has no photo to stand under.
  'trainCaptions',
  // B18: the clip Extend Video continues is a blob of this session.
  'extendClip',
]
import type { ModelType, ClassifiedModel } from '../api/comfyui'
import { MAX_SHOTS, MAX_SHOT_CHARS } from '../lib/ltx-multishot'
import { clampLoraStrength, defaultLoraStrength } from '../lib/lora-strength'
import { IMPROVE_WITH, type ImproveWith } from '../lib/render/qwen-enhancer'
import { QWEN_ENCODER_CHOICES, type QwenEncoderChoice } from '../lib/render/qwen-text-encoder'
import { classifyModel, hidreamSampling, resolveLocalOpPick } from '../api/comfyui'
import type { HiresUpscaleMethod } from '../api/hires-fix'
import { mlxFollowsMotion, mlxTakesStartImage, mlxTalking, mlxVideoLaneEntry, releaseVideoBlobUrl } from '../api/mlx-video'
import { isMlxImageHost, type MacUpscaleFactor } from '../api/mlx-image'
import { QWEN21_TURBO_SAMPLING, isQwenImage21Turbo } from '../lib/render/qwen21-turbo'
import { mlxMakesMusic } from '../lib/mac-music'
import { MAC_EDIT_DEAD_SIDE, MAC_EDIT_SIDE_INSTEAD, imageLaneModels, mlxTakesEditImage } from '../lib/image-engines'
import { STUDIO_MODELS } from '../lib/render/studio-contract'
import { cloudModelsFor } from './cloudCatalogStore'
import { createRunModel } from '../lib/render/create-studio'
import { DEFAULT_UPSCALE_FACTOR, normalizeUpscaleFactor, type UpscaleFactor } from '../lib/local-upscale'
import { characterLoraFile, isLocalCharacter, type CharacterRef } from '../lib/character-ref'
import { triggerWordNote, typedTriggerWord } from '../lib/train-trigger'
import { loraLaneKey, sanitizeLoraLanes, switchLoraLane, type LoraPick } from '../lib/render/lora-lanes'
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

/** Single-purpose tools (2.5.7): super-resolution and masked object removal.
 *  Eraser is hosted only. Upscale also runs on the local ComfyUI backend
 *  since 3.0.7 (LOCAL_UTILITY_OPS), not on a Mac, which has no ComfyUI. */
export type UtilityOp = 'upscale' | 'eraser'

/** The utility tools with a local ComfyUI lane (core upscale nodes, see
 *  lib/local-upscale.ts). The backend flip below keeps these selected on
 *  Windows and Linux, the way LOCAL_LANE_OPS keeps the specialized lanes. */
export const LOCAL_UTILITY_OPS: ReadonlySet<UtilityOp> = new Set(['upscale'])

/** 2.5.8 specialized Create categories (2026-07-17):
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

/** A trained character, local or on the cloud shelf. Defined with the rest
 *  of the character logic in lib/characters.ts. */
export type { CharacterRef }

/**
 * A source or mask image loaded into the Stage input slot. `filename` is the
 * backend handle (a ComfyUI /upload/image name on the local path, or a
 * render-inputs storage path on the cloud path); `url` is a local object/data
 * URL for preview. Runtime-only — never persisted.
 */
import type { ImageRef } from '../lib/image-ref'
export type { ImageRef }

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

/** The model the tab in this state would run in the cloud. */
function runModelOf(s: Parameters<typeof deriveIntent>[0] & Pick<CreateState,
  'cloudImageModel' | 'cloudVideoModel' | 'cloudOpModel' | 'characterTab' | 'selectedCharacter'>): string {
  const intent = deriveIntent(s)
  return createRunModel(
    intent,
    { image: s.cloudImageModel, video: s.cloudVideoModel, op: s.cloudOpModel },
    intent === 'character' && s.characterTab === 'use' ? s.selectedCharacter?.family ?? '' : undefined,
  )
}

/** Studio options belong to the model they were chosen for. A change that moves
 *  the run onto another model (a pick, a tab change, a backend flip that closes
 *  the tab, a result that sets the picker) drops them: a longer clip or a higher
 *  resolution must never travel along unseen and be booked on a model the
 *  customer did not set it for. */
function withOwnStudioOptions(s: CreateState, patch: Partial<CreateState>): Partial<CreateState> {
  return runModelOf(s) === runModelOf({ ...s, ...patch }) ? patch : { ...patch, cloudStudioOptions: {} }
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
  // K9 (GH #136, corrected Runde 3): mirrors comfyui.ts's
  // MODEL_TYPE_DEFAULTS.krea2 - scheduler 'beta', the reporter's only
  // PROVEN successful run (FinePorn v4 NVFP4), not the unproven 'simple'
  // this used to copy from the OTHER author's recipe (LUSTIFY! v10 Krea2).
  krea2:       { steps: 8,  cfgScale: 1.0, sampler: 'euler',           scheduler: 'beta',   width: 1024, height: 1024 },
  zimage:      { steps: 12, cfgScale: 3.5, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  ernie_image: { steps: 20, cfgScale: 4.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  // Qwen-Image 2.1: mirrors comfyui.ts MODEL_TYPE_DEFAULTS.qwenimage, which
  // takes every number straight from the official Comfy-Org templates.
  qwenimage:   { steps: 25, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  // The five families below came in with the header sniff (Discord
  // 2026-09-28); numbers mirror comfyui.ts MODEL_TYPE_DEFAULTS, which takes
  // them from the official Comfy-Org templates. HiDream dev/full get their
  // own numbers in hidreamDefaults().
  qwenimage1:  { steps: 20, cfgScale: 4.0, sampler: 'euler',           scheduler: 'simple', width: 1328, height: 1328 },
  chroma:      { steps: 26, cfgScale: 3.5, sampler: 'euler',           scheduler: 'beta',   width: 1024, height: 1024 },
  hidream:     { steps: 16, cfgScale: 1.0, sampler: 'lcm',             scheduler: 'normal', width: 1024, height: 1024 },
  sd3:         { steps: 20, cfgScale: 4.0, sampler: 'euler',           scheduler: 'sgm_uniform', width: 1024, height: 1024 },
  lumina2:     { steps: 25, cfgScale: 4.0, sampler: 'res_multistep',   scheduler: 'simple', width: 1024, height: 1024 },
  wan:         { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 16 },
  wan22:       { steps: 30, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 576, frames: 49, fps: 24 },
  hunyuan:     { steps: 30, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 45, fps: 15 },
  ltx:         { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 768,  height: 512, frames: 97, fps: 24 },
  ltx25:       { steps: 8,  cfgScale: 1.0, sampler: 'euler_ancestral', scheduler: 'simple', width: 1280, height: 704, frames: 121, fps: 24 },
  minimaxh3:   { steps: 20, cfgScale: 1.0, sampler: 'res_multistep',   scheduler: 'simple', width: 1344, height: 768, frames: 124, fps: 24 },
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
  yue2:        { steps: 32, cfgScale: 1.0, sampler: 'dpm_2',           scheduler: 'sgm_uniform', width: 1024, height: 1024 },
  wans2v:      { steps: 20, cfgScale: 6.0, sampler: 'euler',           scheduler: 'simple', width: 832,  height: 480, frames: 77, fps: 16 },
  wananimate:  { steps: 20, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 832,  height: 480, frames: 77, fps: 16 },
  wanvace:     { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 832,  height: 480, frames: 81, fps: 16 },
  // The AnimateDiff lane runs on an SD1.5 checkpoint plus a motion module, so
  // these are the SD1.5 numbers with a frame count (see comfyui.ts
  // MODEL_TYPE_DEFAULTS.animatediff, which the workflow builder reads).
  animatediff: { steps: 20, cfgScale: 7.5, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512, frames: 16, fps: 8  },
  unknown:     { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1024, height: 1024 },
}

/** The strongest Edit repaint. At 1.0 an img2img sampler ignores the source
 *  entirely, which is never what Edit means (Discord 2026-09-25). */
export const EDIT_MAX_DENOISE = 0.95

/** HiDream I1 ships as fast, dev and full, three different samplers
 *  (hidream_i1_fast / _dev / _full templates). Fast is the type default. */
export function hidreamDefaults(model: string): (typeof MODEL_TYPE_DEFAULTS)['hidream'] {
  const s = hidreamSampling(model)
  return { ...MODEL_TYPE_DEFAULTS.hidream, steps: s.steps, cfgScale: s.cfg, sampler: s.sampler, scheduler: s.scheduler }
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
  /** What the run left out of the request, e.g. "Skipping LoRA no longer in
   *  models/loras: style". Shown under the result. */
  runNote?: string
  /** B40 (3.0.9): the LoRAs the run took, with their strengths. Shown in the
   *  settings of the result (lib/render/run-settings). Unset where none ran. */
  loras?: { name: string; strength: number }[]
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
  /** Cloud jobs: the server's job id, so the client can re-poll/re-sign. */
  jobId?: string
  /** Which redesign intent produced this item (gallery tagging). */
  intent?: CreateIntent
  /** Several source images, one edit: the file this result was made from. */
  sourceName?: string
  /** A tool that runs on its own model (Cutout on RMBG-2.0): that model.
   *  `model` is then only the picker's choice, which had no part in the run. */
  toolModel?: string
  /** Kurze Ueberschrift, wenn der Prompt nicht sagt, was dabei herauskam: der
   *  Titel des Presets, die Beschreibung des Schrittes. Siehe gallery-label.ts. */
  label?: string
  /** "Improve my prompt": what the user typed, when the run was sent with a
   *  rewritten prompt. `prompt` then holds the rewrite, the text that ran. */
  promptOriginal?: string
  /** Who wrote that rewrite: the enhancer edition or the chat model's name. */
  rewrittenBy?: string
  /** "Improve my prompt" was on but the rewrite failed, the run used the
   *  user's own prompt. Said in the details, nowhere else. */
  improveFailed?: boolean
  /** Local Qwen-Image 2.1 with "Transparent background": the PNG carries an
   *  alpha channel, so tiles and previews sit on a checkerboard. */
  transparent?: boolean
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
  /** Runtime-only: why. 'offline' = ComfyUI did not answer; 'gone' = ComfyUI
   *  answered and the file is not in its output any more. */
  unavailableReason?: 'offline' | 'gone'
  /** Runtime-only: bumped when ComfyUI comes back, so a tile that errored
   *  while it was down loads again (Discord 2026-09-26: "why do I
   *  keep getting that?" — the flag never cleared until a restart). */
  reloadKey?: number
  /** The gallery folder this entry is filed under (lib/gallery-folders.ts).
   *  Only a label in the app, the file stays where it is. Absent: no folder,
   *  the entry is found under "All" only. */
  folderId?: string
}

export interface CreateState {
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
  /** Fast (lightx2v 4 steps) or Quality sampling for the Wan 14B models
   *  (B18, lib/wan-speed). Other families ignore it. */
  videoSpeed: VideoSpeed
  /** A long local clip in seconds (B18, lib/long-video); 0 is one run at the
   *  Frames slider's length. */
  longVideoSeconds: number
  /** Sections (default) or one pass with context windows. */
  longVideoMode: LongVideoMode
  /** The clip Extend Video continues, as picked (runtime only, never
   *  persisted: partialize does not list it). */
  extendClip: Blob | null
  // Review A kleiner Punkt 1 (studio-r2): the cloud video Length control used
  // to read and write these SAME frames/fps fields, which the local video
  // lane also owns. Picking a cloud length silently rewrote the local
  // Frames slider's remembered value, so a later switch back to the local
  // track showed a number the user never chose there. Own fields, runtime
  // only (see RUNTIME_ONLY_KEYS): the cloud track keeps its own length
  // selection, the local track keeps its own, and neither can overwrite the
  // other by backend switch or model switch alone.
  cloudFrames: number
  cloudFps: number
  /** The image lane's sampling values while a video tab or Music has the
   *  shared fields, with the model they were tuned for. Runtime only. */
  imageLaneKept: ({ model: string } & Pick<CreateState, 'steps' | 'cfgScale' | 'sampler' | 'scheduler' | 'width' | 'height'>) | null
  denoise: number  // Denoise strength for I2I (0.0–1.0)
  /** The Mac's Edit (Qwen-Image 2.1 on the second engine): how far a run
   *  starts from noise. 1 is the engine's own default, a full edit from the
   *  prompt; lower keeps more of the image. Its own field, apart from
   *  `denoise`: that one starts at 0.7 for the Windows graph, and the Mac's
   *  edits ran at 1 until now. */
  editStrength: number
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
  /** C7: what the field did to the last typed trigger word (ö to oe, a
   *  dropped letter), shown under it. Null when nothing was changed. */
  triggerWordNote: string | null
  /** Local training length (musubi steps). Quality/time tradeoff, persisted. */
  trainSteps: number
  /** 3.0.8 D28: each staged photo's own description (clothes, hair, place),
   *  keyed by the photo's name. Empty or missing = the plain caption.
   *  Runtime-only like the photos it describes. */
  trainCaptions: Record<string, string>
  /** 3.0.8 D20: the local trainer's recipe, Normal or Low VRAM. Persisted:
   *  it follows the card, which does not change between sessions. */
  trainVramPreset: TrainVramPreset
  /** 3.0.9 P8: what the local trainer learns, a character or a style /
   *  concept / pose (lib/train-kind.ts). Persisted like the steps. */
  trainKind: TrainKind
  /** 3.0.9 P8: in style mode, whether the name leads every caption as a
   *  trigger word. Off: the LoRA works without one. Persisted. */
  trainStyleTrigger: boolean
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
  /** Talking Character on a Mac: what the voice says, written into the run's
   *  prompt so the lips follow the words (lib/mac-talking). Runtime-only. */
  talkingWords: string
  /** Music: the how-to note next to the lyrics box was opened once, which
   *  retires its notification dot. Persisted. */
  musicHowtoSeen: boolean
  /** Upscale target for the cloud super-resolution endpoint. */
  targetResolution: '2k' | '4k' | '8k'
  /** Enhance Image on a Mac: the factor SeedVR2 enlarges by
   *  (commands/image_mflux.rs `UPSCALE_FACTORS`). Runtime-only. */
  macUpscaleScale: MacUpscaleFactor
  showNegative: boolean
  /** Whether the Expert section of the advanced settings is unfolded. Kept
   *  here so it outlives the panel; this run of the app only, never saved. */
  expertOpen: boolean
  selectedLoras: { name: string; strength: number }[]
  /** The last strength set for each LoRA file, kept while the LoRA is off, so
   *  ticking it again brings its own value back instead of the default. */
  loraStrengths: Record<string, number>
  /** B24: the LoRA picks of every task + model the user left, keyed by
   *  lib/render/lora-lanes `loraLaneKey`. `selectedLoras` is the lane on
   *  screen; the subscriber at the end of this file swaps them. */
  loraLanes: Record<string, LoraPick[]>
  selectedVae: string
  clipSkip: number
  growMaskBy: number  // inpaint mask edge feather (VAEEncodeForInpaint grow_mask_by)
  /** Unified Stage input slot (runtime-only). On the local path source.filename
   *  maps to i2iImage/i2vImage; on the cloud path it is a render-inputs path. */
  source: ImageRef | null
  /** Edit: further reference images after the source, for a model that takes
   *  them (lib/edit-references). Runtime-only like `source`; cleared with it. */
  references: ImageRef[]
  /** Animate: the picture the clip ends on (B38), for a model that takes
   *  one (lib/frame-refs, studioReadsEndImage). Runtime-only like `source`;
   *  cleared with it. */
  endImage: ImageRef | null
  /** Image (text to image): reference images for style, pose and camera
   *  angle (B45), for a model that reads them (lib/frame-refs). Runtime-only,
   *  kept apart from the Edit references. */
  imageReferences: ImageRef[]
  /** Several source images, one edit (lib/batch-edit): the files that get the
   *  same run, one after the other. Empty for a single image, else two or more,
   *  and `source` shows the first. Runtime-only like `source`. */
  batchSources: MediaRef[]
  /** The queue of a running batch, null when none runs. */
  batchRun: BatchRunState | null
  /** The image a list was made from. A batch puts a new image on the Stage
   *  for every entry, so this one stays to pick after the run, however many
   *  results it made. Runtime-only like `source`. */
  batchOriginal: ImageRef | null
  sourceSetAt: number
  mask: ImageRef | null
  /** Runtime-only: local (Bridge) vs cloud (/api/jobs), derived from session. */
  backend: CreateBackend
  /** Runtime-only: hosted model slugs (lib/render/cloud-models) for the cloud
   *  backend — separate from the persisted local checkpoint names. */
  cloudImageModel: string
  cloudVideoModel: string
  /** Runtime-only: the model picked inside a 2.5.8 specialized intent
   *  (trainer/lipsync/music/extend/motion/enhance). Mirror of the current
   *  sub-category's entry in cloudOpPicks; modelForOp
   *  coerces a stale cross-intent pick onto the op's own list. */
  cloudOpModel: string
  /** The pick of EACH sub-category (see opSlot), runtime-only like cloudOpModel.
   *  cloudOpModel mirrors the entry of the current sub-category, so choosing a
   *  model in Lip Sync no longer wipes the music pick (02.10.2026). */
  cloudOpPicks: Record<string, string>
  /** Studio: the schema-driven option values for the picked cloudOpModel step
   *  (studio-contract.ts). Belongs to the model, not the run: a model switch
   *  drops them, see setCloudOpModel. */
  cloudStudioOptions: Record<string, unknown>
  /** Studio: the last confirmed studio-quote price, shown next to the start
   *  button. Never persisted: a stale price is a lie, see partialize. */
  cloudStudioCredits: number | null
  /** Runtime-only: images per cloud run, 1 to 4 (Image and Edit). */
  cloudImageCount: number
  /** LTX 2.5 multishot (lib/ltx-multishot.ts): the shots AFTER the prompt, which
   *  is shot 1. Empty means a single shot. Runtime-only like the prompt itself:
   *  a scene from yesterday must not ride along into today's run. */
  videoShots: string[]
  setVideoShotCount: (count: number) => void
  setVideoShot: (index: number, text: string) => void
  /** Local Qwen-Image 2.1 only: write the picture with a transparent background
   *  (lib/transparent-image.ts). A preference like the HiRes switch, so it is
   *  remembered. */
  transparentBackground: boolean
  setTransparentBackground: (on: boolean) => void
  /** Advanced settings switch: a chat model rewrites the prompt before a run. Off by default, remembered. */
  improvePrompt: boolean
  setImprovePrompt: (on: boolean) => void
  /** Who rewrites the prompt when a local Qwen-Image 2.1 run has a prompt
   *  enhancer installed (lib/render/qwen-enhancer.ts). Remembered. */
  improveWith: ImproveWith
  setImproveWith: (who: ImproveWith) => void
  /** Which text encoder reads the prompt on a local Qwen-Image 2.1 run when
   *  both editions are installed (lib/render/qwen-text-encoder.ts). Remembered. */
  qwenTextEncoder: QwenEncoderChoice
  setQwenTextEncoder: (which: QwenEncoderChoice) => void
  /** Runtime-only: the text encoder files ComfyUI lists, read with the model
   *  lists. The prompt enhancers and the Qwen-Image 2.1 encoders are found in it. */
  textEncoderList: string[]
  setTextEncoderList: (list: string[]) => void
  /** Runtime-only: on a Mac, the installed MLX prompt enhancers by their
   *  catalogue ids, read with the model lists. ComfyUI's list on Windows. */
  mlxEnhancerList: string[]
  setMlxEnhancerList: (list: string[]) => void
  /** Runtime-only: the LOCAL model picked inside a specialized lane (ACE
   *  checkpoint / S2V UNet / Animate-VACE UNet). One slot for all lanes —
   *  resolveLocalOpPick coerces a stale cross-lane pick onto the lane's list
   *  (the same one-rule guard the cloud picker got after take-01). */
  localOpModel: string
  /** Bumped when the character shelf changed (training delivered / deleted)
   *  so the Character-Studio surface refetches /api/loras. */
  charactersVersion: number
  /** Runtime-only: the LoRA names Create last read, as one key. The character
   *  pickers list again when it changes: the first read after the app starts
   *  runs while ComfyUI is still starting and finds nothing, and the chip
   *  stayed hidden until Create was opened again (box run d307-d). */
  loraListKey: string
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
  /** Folders of the gallery, only labels in the app (lib/gallery-folders.ts). Persisted. */
  galleryFolders: GalleryFolder[]
  /** The folder the gallery shows, null for "All". Runtime only: a new result
   *  lands in it, and a folder picked yesterday must not file today's renders
   *  without the user seeing it. */
  galleryFolderOpen: string | null
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
  /** Local Enhance Image: the files ComfyUI lists in models/upscale_models.
   *  Mirrored by fetchModels. Runtime-only. */
  upscaleModelList: string[]
  /** Local Enhance Image: 2x or 4x the side. A preference, persisted. */
  upscaleFactor: UpscaleFactor
  comfyRunning: boolean
  /** Runtime-only: an upscaler is installed on this Mac (SeedVR2 on the
   *  second engine), so Enhance Image is a local tab there. Set by
   *  useCreate.fetchModels from the catalogue. Always false off the Mac. */
  mlxUpscale: boolean
  /** Bug A (v2.4.5) + #72 (bob): resolver for the VHS_VideoCombine install
   *  prompt. Runtime-only — useCreate sets it when a video gen would fall
   *  back to animated .webp; the modal resolves with the user's choice. */
  vhsInstallPrompt: ((choice: 'install' | 'webp' | 'cancel') => void) | null
  /** A render is missing files or a newer ComfyUI; Create asks before fixing
   *  it (lib/render-fixups.ts). Never persisted. */
  fixupPrompt: (FixupPrompt & { resolve: (go: boolean) => void }) | null

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
  /** A click on Draft, Standard or High in the image tabs, see `imageQualityLadder`. */
  setImageQuality: (quality: ImageQuality) => void
  setCfgScale: (cfgScale: number) => void
  setSize: (width: number, height: number) => void
  setSeed: (seed: number) => void
  setBatchSize: (batchSize: number) => void
  setFrames: (frames: number) => void
  setFps: (fps: number) => void
  setVideoSpeed: (speed: VideoSpeed) => void
  setLongVideoSeconds: (seconds: number) => void
  setLongVideoMode: (mode: LongVideoMode) => void
  setExtendClip: (clip: Blob | null) => void
  setCloudFrames: (frames: number) => void
  setCloudFps: (fps: number) => void
  setDenoise: (denoise: number) => void
  setEditStrength: (strength: number) => void
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
  setExpertOpen: (open: boolean) => void
  toggleLora: (name: string) => void
  setLoraStrengthFor: (name: string, strength: number) => void
  clearLoras: () => void
  /** Drops picks whose file ComfyUI no longer lists (GH #146), and the local
   *  character that rode on one of them. */
  keepListedLoras: (listed: string[]) => void
  setSelectedVae: (name: string) => void
  setClipSkip: (n: number) => void
  setGrowMaskBy: (n: number) => void
  setTargetResolution: (r: '2k' | '4k' | '8k') => void
  setMacUpscaleScale: (scale: MacUpscaleFactor) => void
  setCharacterTab: (tab: 'train' | 'use') => void
  addTrainImages: (imgs: MediaRef[]) => void
  removeTrainImage: (name: string) => void
  clearTrainImages: () => void
  setTriggerWord: (w: string) => void
  setTrainSteps: (n: number) => void
  setTrainCaption: (name: string, text: string) => void
  setTrainVramPreset: (p: TrainVramPreset) => void
  setTrainKind: (k: TrainKind) => void
  setTrainStyleTrigger: (on: boolean) => void
  setSelectedCharacter: (c: CharacterRef | null) => void
  setAudioInput: (m: MediaRef | null) => void
  setVoiceFromJob: (v: { jobId: string; label: string } | null) => void
  setVideoInput: (m: MediaRef | null) => void
  bumpCharactersVersion: () => void
  setLoraListKey: (names: readonly string[]) => void
  setCloudOpModel: (id: string) => void
  setCloudStudioOptions: (options: Record<string, unknown>) => void
  setCloudStudioCredits: (credits: number | null) => void
  setLocalOpModel: (name: string) => void
  setAudioModelList: (list: ClassifiedModel[]) => void
  setLipsyncModelList: (list: ClassifiedModel[]) => void
  setMotionModelList: (list: ClassifiedModel[]) => void
  setUpscaleModelList: (list: string[]) => void
  setUpscaleFactor: (f: UpscaleFactor) => void
  setExtendSource: (s: { jobId: string; url: string; label: string } | null) => void
  setMusicDuration: (s: number) => void
  setMusicLyrics: (l: string) => void
  setTalkingWords: (w: string) => void
  setMusicHowtoSeen: (v: boolean) => void
  setSource: (img: ImageRef | null) => void
  setCloudImageCount: (count: number) => void
  addReference: (img: ImageRef) => void
  removeReference: (index: number) => void
  setReferences: (refs: ImageRef[]) => void
  setEndImage: (img: ImageRef | null) => void
  addImageReference: (img: ImageRef) => void
  removeImageReference: (index: number) => void
  setBatchSources: (list: MediaRef[]) => void
  setBatchRun: (run: BatchRunState | null) => void
  setBatchOriginal: (img: ImageRef | null) => void
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
  setFixupPrompt: (prompt: (FixupPrompt & { resolve: (go: boolean) => void }) | null) => void
  setError: (error: string | null) => void
  setLastGenTime: (time: string | null) => void
  addToGallery: (item: GalleryItem) => void
  /** Patch a gallery item in place (e.g. a lazily re-signed remoteUrl). */
  updateGalleryItem: (id: string, patch: Partial<GalleryItem>) => void
  /** Cloud hydration: merges freshly-listed jobs into the gallery. Existing
   *  items (matched by jobId/id) just get a fresh signed URL plus a
   *  backfilled prompt/label when they never had one, nothing here ever
   *  overwrites what is already on screen. See mergeGallery below. */
  mergeGallery: (items: GalleryItem[]) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
  /** Make a folder. Returns its id, or null for an empty name or a full list. */
  addGalleryFolder: (name: string) => string | null
  renameGalleryFolder: (id: string, name: string) => void
  /** Remove a folder. Its entries stay in the gallery and go back to "All";
   *  no entry and no file is deleted. */
  removeGalleryFolder: (id: string) => void
  /** File entries under a folder, or under none with null. */
  moveToGalleryFolder: (ids: readonly string[], folderId: string | null) => void
  setGalleryFolderOpen: (id: string | null) => void
  addToPromptHistory: (prompt: string) => void
  /** Drop a single remembered prompt (the X next to the entry). */
  removeFromPromptHistory: (prompt: string) => void
  /** Drop the whole prompt history (the Clear all button in the dropdown). */
  clearPromptHistory: () => void
  setImageModelList: (list: ClassifiedModel[]) => void
  setVideoModelList: (list: ClassifiedModel[]) => void
  setComfyRunning: (running: boolean) => void
  setMlxUpscale: (installed: boolean) => void
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
 * A staged input file that stops being reachable must give its `blob:` URL back.
 *
 * `mediaRefFrom` (`components/create/experimental/mediaRef.ts`) is the one place
 * such a URL is minted; this is the one place it dies. Everything a MediaRef
 * slot can do to a ref — replace it, clear it, drop it out of a set, refuse it
 * as a duplicate, cut it off past a cap — is the same event seen from a
 * different angle: it was in the slot before and it is not in the slot after.
 * So there is ONE rule, stated once, and every setter that writes a MediaRef
 * slot states its before and its after.
 *
 * The lifetime is closed HERE rather than at the call site because these
 * setters are the only way a slot is ever written — a future caller cannot
 * forget. That is what the previous, scalar-only version of this helper got
 * right for `audioInput` / `videoInput` and could not express for the third
 * slot, `trainImages`: an array whose members are dropped by a filter and by
 * a silent `.slice(0, 30)`, neither of which anybody was giving back.
 *
 * Membership is by URL, not by name: re-picking the same filename mints a
 * NEW URL, and the loser of that dedupe is exactly the one to revoke.
 *
 * Only the preview URL is dropped; every consumer (local + cloud upload) reads
 * `MediaRef.blob`, which is unaffected by revoking the URL. Non-`blob:` URLs
 * are left alone — they are not ours to revoke.
 */
function releaseDroppedMediaRefs(previous: readonly MediaRef[], next: readonly MediaRef[]): void {
  if (previous.length === 0) return
  const kept = new Set(next.map((r) => r.url))
  for (const r of previous) {
    if (kept.has(r.url)) continue
    if (r.url.startsWith('blob:')) URL.revokeObjectURL(r.url)
  }
}

/**
 * A training photo staged again: the same file as one already in the set, by
 * its original file name, size and modification time (the most a browser
 * knows about a file's identity). Only an earlier batch counts; one pick or
 * one drop never holds the same file twice, so two same-named files in it are
 * two photos.
 */
function isSameTrainFile(had: MediaRef, img: MediaRef): boolean {
  const a = had.blob
  const b = img.blob
  if (a === b) return true
  if (!(a instanceof File) || !(b instanceof File)) return false
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified
}

/** `name` if the set does not hold it yet (case-insensitive, like the Mac
 *  and Windows file systems the trainer writes to), else `stem_2.ext`,
 *  `stem_3.ext` and so on. */
function freeTrainImageName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const next = `${stem}_${n}${ext}`
    if (!taken.has(next.toLowerCase())) return next
  }
}

/** The same rule for a slot that holds at most one ref. */
function releaseReplacedMediaRef(previous: MediaRef | null, next: MediaRef | null): void {
  releaseDroppedMediaRefs(previous ? [previous] : [], next ? [next] : [])
}

/**
 * SD-Turbo, SDXL-Turbo, Lightning, Hyper-SD and LCM checkpoints are distilled
 * to a few steps at CFG 1. The family defaults (25 steps, CFG 7) cost several
 * times the time and overcook them. Seen in the 3.0.4 Gegenprobe on the
 * Windows box (02.10.2026): sd_turbo started at 25 steps. Only the SD and SDXL
 * checkpoint families; Z-Image Turbo and the other UNET families carry their
 * own tuned defaults.
 */
export function distilledImageCheckpoint(model: string, type: ModelType): boolean {
  if (type !== 'sd15' && type !== 'sdxl' && type !== 'unknown') return false
  return /(^|[^a-z])(turbo|lightning|hyper|lcm)([^a-z]|$)/i.test(model.replace(/^.*[\\/]/, ''))
}

/** The image model's own sampling values, for picking it and for everything
 *  that measures from them. Leaving the video lane has to put them back:
 *  Image, Edit and the other image intents only flipped the mode, so sd_turbo
 *  rendered with MiniMax H3's 20 steps, res_multistep and 1344x768 (3.0.4
 *  Gegenprobe 9). */
function imageModelParams(state: { imageModel: string; imageModelType: ModelType }) {
  const defaults = state.imageModelType === 'hidream'
    ? hidreamDefaults(state.imageModel)
    : MODEL_TYPE_DEFAULTS[state.imageModelType] || MODEL_TYPE_DEFAULTS.unknown
  const distilled = distilledImageCheckpoint(state.imageModel, state.imageModelType)
  // Qwen-Image 2.1 Turbo on ComfyUI runs its own eight step schedule at CFG 1
  // (lib/render/qwen21-turbo), so the sliders stand at what the run takes.
  if (state.imageModelType === 'qwenimage' && isQwenImage21Turbo(state.imageModel)) {
    return {
      steps: QWEN21_TURBO_SAMPLING.steps, cfgScale: QWEN21_TURBO_SAMPLING.cfg,
      sampler: QWEN21_TURBO_SAMPLING.sampler, scheduler: QWEN21_TURBO_SAMPLING.scheduler,
      width: defaults.width, height: defaults.height,
    }
  }
  return {
    steps: distilled ? 4 : defaults.steps, cfgScale: distilled ? 1.0 : defaults.cfgScale,
    sampler: defaults.sampler, scheduler: defaults.scheduler,
    width: defaults.width, height: defaults.height,
  }
}

type ImageLaneParams = ReturnType<typeof imageModelParams>

/**
 * A run in the shape of the image tab, for the start image of a character
 * (lib/characters.ts, characterStartImage). The picture takes the character's
 * own model with that model's values, its LoRA alone, the video's shape and
 * nothing the user set for another tab: no source, mask, hires pass, prompt
 * rewrite or transparent background. The store itself is not touched; the
 * run reads these fields over the live ones.
 */
export function characterImageRun(
  req: { prompt: string; model: string; modelType: ModelType; lora: { name: string; strength: number } },
  size: { width: number; height: number },
): Partial<CreateState> {
  return {
    mode: 'image', imageSubMode: 'text2img', cloudOp: null, utilityOp: null, removebg: false,
    imageModel: req.model, imageModelType: req.modelType,
    ...imageModelParams({ imageModel: req.model, imageModelType: req.modelType }),
    ...size,
    prompt: req.prompt, batchSize: 1, selectedLoras: [req.lora],
    hiresFixEnabled: false, improvePrompt: false, transparentBackground: false,
    source: null, mask: null, references: [], i2iImage: null, selectedVae: 'auto', clipSkip: 0,
  }
}

/**
 * The pick Edit takes on the Mac when the stored one cannot edit: the first
 * model that takes an image, with its own values, so the sliders stand at
 * what the run takes. Empty where the list is not narrowed (every ComfyUI
 * host) and where the pick already edits.
 */
function editLanePick(s: Pick<CreateState, 'imageModelList' | 'imageModel'>): Partial<CreateState> {
  const lane = imageLaneModels(s.imageModelList, 'edit')
  if (lane === s.imageModelList || lane.length === 0 || lane.some((m) => m.name === s.imageModel)) return {}
  const first = lane[0]
  return { imageModel: first.name, imageModelType: first.type, ...imageModelParams({ imageModel: first.name, imageModelType: first.type }) }
}

/** True while the tab in this state is the Mac's local Edit with a model
 *  that takes an image (Qwen-Image 2.1 on the second engine). */
function onMacEdit(s: Pick<CreateState, 'backend' | 'imageModelList' | 'imageModel'> & Parameters<typeof deriveIntent>[0]): boolean {
  return s.backend === 'local' && isMlxImageHost() && deriveIntent(s) === 'edit'
    && (s.imageModelList.find((m) => m.name === s.imageModel)?.editImages ?? 0) > 0
}

/**
 * The canvas the Mac's Edit starts on. Qwen-Image 2.1 does not edit on
 * 1024 x 1024 (lib/image-engines, real run 09.10.2026) and the engine moves
 * such a run to 1056, so Edit stands on 1056 where it would have stood on
 * 1024: the number in the settings is the one that runs. Only that one
 * square moves, every other size is the user's.
 *
 * On the way out the square goes back to the model's own 1024, also in what
 * is put aside for the image lane, so Image does not inherit a canvas it
 * never chose. Windows and every ComfyUI host never get here.
 */
function withMacEditCanvas(s: CreateState, patch: Partial<CreateState>): Partial<CreateState> {
  const next = { ...s, ...patch }
  const square = (v: { width: number; height: number }, side: number) => v.width === side && v.height === side
  if (onMacEdit(next)) {
    return square(next, MAC_EDIT_DEAD_SIDE) ? { ...patch, width: MAC_EDIT_SIDE_INSTEAD, height: MAC_EDIT_SIDE_INSTEAD } : patch
  }
  if (!onMacEdit(s) || !square(s, MAC_EDIT_SIDE_INSTEAD) || !square(imageModelParams(s), MAC_EDIT_DEAD_SIDE)) return patch
  const own = { width: MAC_EDIT_DEAD_SIDE, height: MAC_EDIT_DEAD_SIDE }
  if (patch.imageLaneKept && square(patch.imageLaneKept, MAC_EDIT_SIDE_INSTEAD)) return { ...patch, imageLaneKept: { ...patch.imageLaneKept, ...own } }
  return onImageLane(next) && square(next, MAC_EDIT_SIDE_INSTEAD) ? { ...patch, ...own } : patch
}

export type ImageQuality = 'Draft' | 'Standard' | 'High'

/**
 * What the Quality buttons of the image tabs stand for: "Standard" is the
 * picked model's own step count, Draft and High scale from it.
 *
 * They used to measure from the model FAMILY, 15 / 25 / 38 for every SD
 * checkpoint. sd_turbo starts at 4 steps and CFG 1, so a click on "Draft"
 * raised it to 15 steps, and at a CFG left over from elsewhere the image came
 * out overcooked (Windows box, 05.10.2026). For a distilled checkpoint the
 * buttons therefore also hold CFG at the model's value.
 *
 * LU Cloud renders with its own model, not the local file, so there the
 * family's number stays the measure.
 */
export function imageQualityLadder(
  s: Pick<CreateState, 'backend' | 'imageModel' | 'imageModelType'>,
): { steps: Record<ImageQuality, number>; cfgScale?: number } {
  const local = s.backend !== 'cloud'
  const own = local ? imageModelParams(s) : MODEL_TYPE_DEFAULTS[s.imageModelType] || MODEL_TYPE_DEFAULTS.unknown
  return {
    steps: {
      Draft: Math.max(1, Math.round(own.steps * 0.6)),
      Standard: own.steps,
      High: Math.round(own.steps * 1.5),
    },
    ...(local && (distilledImageCheckpoint(s.imageModel, s.imageModelType) || isQwenImage21Turbo(s.imageModel)) ? { cfgScale: own.cfgScale } : {}),
  }
}

/** True while the tab in this state runs the image model. Music keeps mode
 *  'image' (see setIntent) and still writes its own sampling values. */
function onImageLane(s: Pick<CreateState, 'mode' | 'cloudOp'>): boolean {
  return s.mode === 'image' && s.cloudOp !== 'music'
}

/** What the image lane gets back: the values it was left with, as long as
 *  they were tuned for the model that is still picked, else the model's own. */
function imageLaneParams(s: Pick<CreateState, 'imageModel' | 'imageModelType' | 'imageLaneKept'>): ImageLaneParams {
  if (s.imageLaneKept?.model !== s.imageModel) return imageModelParams(s)
  const { model: _model, ...params } = s.imageLaneKept
  return params
}

/** The model family whose size and sampling values a phone sends with a cloud
 *  clip while no local video model exists. 16:9, like the default cloud model. */
export const MOBILE_CLOUD_VIDEO_FAMILY: ModelType = 'minimaxh3'

/** The video model's own sampling values, for picking it and for every tab
 *  that runs it. Lightning/rapid merges are distilled to few steps at cfg 1,
 *  the architecture defaults (30 steps, cfg 5+) render them to mush. */
function videoModelParams(model: string, list: readonly ClassifiedModel[] | null = [], intent = 'video', speed: VideoSpeed = 'fast') {
  // A phone has no local video model, so `model` is empty there and the
  // family would be 'unknown': 1024 by 1024, a square image size, sent along
  // with a cloud clip. It takes the family of the cloud's own default video
  // model instead (DEFAULT_MODEL_IDS.video in lib/render/cloud-models.ts).
  const family = !model && isMobile() ? MOBILE_CLOUD_VIDEO_FAMILY : classifyModel(model)
  const defaults = MODEL_TYPE_DEFAULTS[family] || MODEL_TYPE_DEFAULTS.unknown
  const lightning = /rapid|lightning|lightx2v/i.test(model)
  // On the Mac the catalogue entry of the model the lane runs says how long
  // a clip is, at what rate it plays and at what size it is made. The
  // family table is ComfyUI's: it
  // gave LTX-2.3 Distilled 97 frames where its entry says 49, and on Animate,
  // where the lane runs another model than the stored pick, it left Wan's 16
  // fps under an LTX (persona walk, 09.10.2026, Fund 19). A ComfyUI entry
  // carries no `mlxVideo`, and nothing changes for it.
  const clip = mlxVideoLaneEntry(list, model, intent)?.mlxVideo
  // The Wan 14B models (B18): Fast is lightx2v's 4 steps at cfg 1, Quality
  // the official templates; both at the 81 frames, 832×480 and 16 fps Wan
  // learned. The Mac's MLX entry below still wins on the Mac.
  const wan = clip ? null : wanSamplingFor(model, speed)
  return {
    steps: lightning ? 6 : defaults.steps, cfgScale: lightning ? 1.0 : defaults.cfgScale,
    sampler: defaults.sampler, scheduler: defaults.scheduler,
    width: defaults.width, height: defaults.height,
    ...(defaults.frames ? { frames: defaults.frames } : {}),
    ...(defaults.fps ? { fps: defaults.fps } : {}),
    ...(wan ? { steps: wan.steps, cfgScale: wan.cfgScale, sampler: wan.sampler, scheduler: wan.scheduler, width: 832, height: 480, frames: 81, fps: 16 } : {}),
    ...(clip ? { frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height } : {}),
    // A Wan on the Mac runs its config's steps (50 or 40) unless asked, and
    // the slider starts there, not at the family's ComfyUI count.
    ...(clip?.steps ? { steps: clip.steps } : {}),
  }
}

/** The tab a video run is on, as the lanes name it. */
function videoIntentOf(s: Pick<CreateState, 'videoSubMode' | 'cloudOp'>): string {
  return s.cloudOp === 'extend' ? 'extend' : s.videoSubMode === 'i2v' ? 'animate' : 'video'
}

/**
 * The sampling values a restart may find. cloudOp is runtime-only, so the app
 * reopens on the base tab of the stored mode, and that tab must not start with
 * what Music, Lip sync or Motion wrote: closed on Music, Image came back at
 * ACE's 50 steps.
 */
function restartSampling(s: CreateState): Partial<CreateState> {
  if (s.cloudOp === 'music') return imageLaneParams(s)
  if (s.cloudOp === 'lipsync' || s.cloudOp === 'motion') return videoModelParams(s.videoModel, s.videoModelList, videoIntentOf(s), s.videoSpeed)
  return {}
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
      videoSpeed: 'fast',
      longVideoSeconds: 0,
      longVideoMode: 'sections',
      extendClip: null,
      cloudFrames: 24,
      cloudFps: 8,
      imageLaneKept: null,
      denoise: 0.7,
      editStrength: 1,
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
      triggerWordNote: null,
      // Dieselbe Zahl, die der Trainer ohne Angabe nimmt
      // (`steps.unwrap_or(1200)`, trainer.rs), und die Stufe `Standard`.
      trainSteps: TRAIN_STEPS_DEFAULT,
      trainCaptions: {} as Record<string, string>,
      trainVramPreset: TRAIN_VRAM_PRESET_DEFAULT as TrainVramPreset,
      trainKind: TRAIN_KIND_DEFAULT as TrainKind,
      trainStyleTrigger: true,
      selectedCharacter: null as CharacterRef | null,
      audioInput: null as MediaRef | null,
      voiceFromJob: null as { jobId: string; label: string } | null,
      videoInput: null as MediaRef | null,
      extendSource: null as { jobId: string; url: string; label: string } | null,
      musicDuration: 60,
      musicLyrics: '',
      talkingWords: '',
      musicHowtoSeen: false,
      targetResolution: '4k' as '2k' | '4k' | '8k',
      macUpscaleScale: 2 as MacUpscaleFactor,
      showNegative: false,
      expertOpen: false,
      selectedLoras: [] as { name: string; strength: number }[],
      loraStrengths: {} as Record<string, number>,
      loraLanes: {} as Record<string, LoraPick[]>,
      selectedVae: 'auto',
      clipSkip: 0,
      growMaskBy: 6,
      source: null as ImageRef | null,
      references: [] as ImageRef[],
      endImage: null as ImageRef | null,
      imageReferences: [] as ImageRef[],
      batchSources: [] as MediaRef[],
      batchRun: null as BatchRunState | null,
      batchOriginal: null as ImageRef | null,
      sourceSetAt: 0,
      mask: null as ImageRef | null,
      // A phone has no local render engine: LU Cloud is the only track there,
      // from the first frame on, with no switch to flip (see setBackend).
      backend: (isMobile() ? 'cloud' : 'local') as CreateBackend,
      cloudImageModel: '',
      cloudVideoModel: '',
      cloudOpModel: '',
      cloudOpPicks: {} as Record<string, string>,
      cloudStudioOptions: {} as Record<string, unknown>,
      cloudStudioCredits: null as number | null,
      cloudImageCount: 1,
      improvePrompt: false,
      improveWith: 'auto' as ImproveWith,
      qwenTextEncoder: 'auto' as QwenEncoderChoice,
      textEncoderList: [] as string[],
      mlxEnhancerList: [] as string[],
      transparentBackground: false,
      videoShots: [],
      localOpModel: '',
      charactersVersion: 0,
      loraListKey: '',
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
      galleryFolders: [],
      galleryFolderOpen: null,
      promptHistory: [],
      imageModelList: [],
      videoModelList: [],
      audioModelList: [],
      lipsyncModelList: [],
      motionModelList: [],
      upscaleModelList: [] as string[],
      upscaleFactor: DEFAULT_UPSCALE_FACTOR as UpscaleFactor,
      comfyRunning: false,
      mlxUpscale: false,
      vhsInstallPrompt: null,
      fixupPrompt: null,

      setVideoBackend: (videoBackend) => set({ videoBackend, videoBackendInitialized: true }),
      setMode: (mode) => set((state) => {
        // Reset parameters to the correct defaults when switching modes
        // This prevents image resolution (1024x1024) leaking into video mode (causes HTTP 500)
        // On a phone both lists are empty for good, and the reset must still
        // happen: the video tab takes the cloud clip size, the way back takes
        // the image size again.
        if (mode === 'video' && (state.videoModel || isMobile())) return { mode, ...videoModelParams(state.videoModel, state.videoModelList, videoIntentOf(state), state.videoSpeed) }
        if (mode === 'image' && (state.imageModel || isMobile())) return { mode, ...imageModelParams(state) }
        return { mode }
      }),
      setImageSubMode: (subMode) => set({ imageSubMode: subMode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setImageModel: (model, type) => set((s) => withMacEditCanvas(s, {
        imageModel: model, imageModelType: type,
        ...imageModelParams({ imageModel: model, imageModelType: type }),
      })),
      setVideoModel: (model) => set((s) => ({ videoModel: model, ...videoModelParams(model, s.videoModelList, videoIntentOf(s), s.videoSpeed) })),
      setSampler: (sampler) => set({ sampler }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSteps: (steps) => set({ steps: Math.max(1, Math.min(200, Math.floor(steps))) }),
      setImageQuality: (quality) => set((s) => {
        const ladder = imageQualityLadder(s)
        return {
          steps: ladder.steps[quality],
          ...(ladder.cfgScale === undefined ? {} : { cfgScale: ladder.cfgScale }),
        }
      }),
      setCfgScale: (cfgScale) => set({ cfgScale: Math.max(0, Math.min(30, cfgScale)) }),
      setSize: (width, height) => set({
        width: Math.max(64, Math.min(4096, Math.floor(width))),
        height: Math.max(64, Math.min(4096, Math.floor(height))),
      }),
      setSeed: (seed) => set({ seed: Math.floor(seed) }),
      setBatchSize: (batchSize) => set({ batchSize: Math.max(1, Math.min(8, Math.floor(batchSize))) }),
      // D4: the longest clip of any local family (lib/video-length), the
      // slider of the picked family keeps a shorter one inside its range.
      setFrames: (frames) => set({ frames: Math.max(1, Math.min(MAX_LOCAL_FRAMES, Math.floor(frames))) }),
      setFps: (fps) => set({ fps: Math.max(1, Math.min(60, Math.floor(fps))) }),
      // Switching speed re-reads the sampling values of the picked model; a
      // model without a fast mode keeps what it has.
      setVideoSpeed: (videoSpeed) => set((s) => {
        const wan = wanSamplingFor(s.videoModel, videoSpeed)
        return wan && s.mode === 'video'
          ? { videoSpeed, steps: wan.steps, cfgScale: wan.cfgScale, sampler: wan.sampler, scheduler: wan.scheduler }
          : { videoSpeed }
      }),
      setLongVideoSeconds: (seconds) => set({
        longVideoSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_LONG_SECONDS, Math.round(seconds)) : 0,
      }),
      setLongVideoMode: (longVideoMode) => set({ longVideoMode }),
      setExtendClip: (extendClip) => set({ extendClip }),
      // Review A kleiner Punkt 1 (studio-r2, 20.09.2026, found by the new
      // e2e test itself): the local slider's clamp follows the family
      // (lib/video-length); the cloud track only ever encodes
      // `seconds * 16` here (never rendered as an actual frame count), and
      // video-durations.json's longest priced clip is already 15s (240
      // frames at 16fps). 3600 (225s) leaves headroom for a longer length a
      // provider adds later without silently clamping a real priced option
      // back down to the shortest one, the same Risiko 1 A2 fixed.
      setCloudFrames: (frames) => set({ cloudFrames: Math.max(1, Math.min(3600, Math.floor(frames))) }),
      setCloudFps: (fps) => set({ cloudFps: Math.max(1, Math.min(60, Math.floor(fps))) }),
      setDenoise: (denoise) => set({ denoise: Math.max(0, Math.min(1, denoise)) }),
      setEditStrength: (strength) => set({ editStrength: Number.isFinite(strength) ? Math.max(0.05, Math.min(1, strength)) : 1 }),
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
      // Eine andere Unterkategorie faehrt ein anderes Modell und wirft damit die
      // Studio-Optionen weg (withOwnStudioOptions): ein Feld wie `resolution` hat
      // je Endpunkt eine andere Auswahl.
      setIntent: (intent) => {
        const changed = get().intent() !== intent
        set((s) => withOwnStudioOptions(s, withMacEditCanvas(s, ((): Partial<CreateState> => {
        const patch = ((): Partial<CreateState> => {
        // Clear intent-incompatible inputs: intents without a source drop both;
        // removebg/animate keep the source but drop a stale mask. Video/animate
        // mirror setMode's reset so image resolution never leaks into video.
        // A stale error from the previous intent never carries over.
        const dropAll = { source: null, mask: null, sourceSetAt: 0, references: [], endImage: null }
        // Back from a tab that runs another model (the video tabs, Music), the
        // image lane gets its own values again; inside the image lane a switch
        // keeps what the user tuned. Music has mode 'image', so asking the mode
        // alone left ACE's 50 steps on Image (seen on the Windows box as
        // Quality "High" after a visit to Music).
        const back = onImageLane(s) ? {} : imageLaneParams(s)
        // The number of images belongs to the tab it was chosen on: four picked
        // for Image must not start four runs of the first Edit.
        const base = {
          removebg: false, utilityOp: null, cloudOp: null, error: null, ...back,
          ...(changed ? { cloudImageCount: 1 } : {}),
        }
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
            return { ...base, cloudOp: 'extend' as const, mode: 'video' as const, videoSubMode: 't2v' as const, ...dropAll,
              ...videoModelParams(s.videoModel, s.videoModelList, 'extend', s.videoSpeed) }
          }
          case 'motion': {
            // Keeps the source slot (the character image the video drives).
            // On the Mac the lane runs an LTX-2.3 pack, and its catalogue
            // entry says length, rate and size (videoModelParams).
            if (isMlxImageHost() && s.backend === 'local') {
              const pick = resolveLocalOpPick(s.localOpModel, s.motionModelList)
              return { ...base, cloudOp: 'motion' as const, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
                ...videoModelParams(pick, s.motionModelList, 'motion') }
            }
            const d = MODEL_TYPE_DEFAULTS.wananimate
            return { ...base, cloudOp: 'motion' as const, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
              steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler,
              width: d.width, height: d.height, ...(d.frames ? { frames: d.frames } : {}), ...(d.fps ? { fps: d.fps } : {}) }
          }
          case 'image':    return { ...base, mode: 'image' as const, imageSubMode: 'text2img' as const, ...dropAll }
          // On the Mac, Edit lists the models that take an image, and a pick
          // that cannot is replaced (editLanePick).
          case 'edit':     return { ...base, mode: 'image' as const, imageSubMode: 'img2img' as const, ...(s.backend === 'local' ? editLanePick(s) : {}) }
          case 'removebg': return { ...base, removebg: true, mode: 'image' as const, imageSubMode: 'img2img' as const, mask: null }
          // Utility tools: upscale keeps the source (no mask, no prompt) and
          // runs in the cloud or on local ComfyUI; eraser keeps source + mask
          // (paint what to remove) and is hosted only.
          case 'upscale':  return { ...base, utilityOp: 'upscale' as const, mode: 'image' as const, imageSubMode: 'img2img' as const, mask: null }
          case 'eraser':   return { ...base, utilityOp: 'eraser' as const, mode: 'image' as const, imageSubMode: 'img2img' as const }
          case 'video':
            return { ...base, mode: 'video' as const, videoSubMode: 't2v' as const, ...dropAll,
              ...videoModelParams(s.videoModel, s.videoModelList, 'video', s.videoSpeed) }
          case 'animate':
            return { ...base, mode: 'video' as const, videoSubMode: 'i2v' as const, mask: null,
              ...videoModelParams(s.videoModel, s.videoModelList, 'animate', s.videoSpeed) }
        }
        })()
        // Leaving the image lane, its values are put aside under the model
        // they were tuned for, so the way back finds the user's own choice.
        const next = { ...s, ...patch }
        if (onImageLane(s) && !onImageLane(next)) {
          return {
            ...patch,
            imageLaneKept: {
              model: s.imageModel, steps: s.steps, cfgScale: s.cfgScale, sampler: s.sampler,
              scheduler: s.scheduler, width: s.width, height: s.height,
            },
          }
        }
        return onImageLane(next) ? { ...patch, imageLaneKept: null } : patch
        })())))
        // The list of further source images stays only where it can run.
        if (get().batchSources.length && (!get().source || !BATCH_INTENTS.has(intent))) get().setBatchSources([])
        if (!BATCH_INTENTS.has(intent) && get().batchOriginal) set({ batchOriginal: null })
      },
      toggleNegative: () => set((s) => ({ showNegative: !s.showNegative })),
      setExpertOpen: (expertOpen) => set({ expertOpen }),
      toggleLora: (name) => set((s) => ({ selectedLoras: s.selectedLoras.some((l) => l.name === name) ? s.selectedLoras.filter((l) => l.name !== name) : [...s.selectedLoras, { name, strength: s.loraStrengths[name] ?? defaultLoraStrength(name) }] })),
      setLoraStrengthFor: (name, strength) => set((s) => {
        if (!Number.isFinite(strength)) return {}
        const value = clampLoraStrength(strength)
        return {
          selectedLoras: s.selectedLoras.map((l) => l.name === name ? { ...l, strength: value } : l),
          loraStrengths: { ...s.loraStrengths, [name]: value },
        }
      }),
      clearLoras: () => set((s) => ({
        selectedLoras: [],
        selectedCharacter: isLocalCharacter(s.selectedCharacter) ? null : s.selectedCharacter,
      })),
      keepListedLoras: (listed) => set((s) => {
        const kept = s.selectedLoras.filter((l) => listed.includes(l.name))
        const char = s.selectedCharacter
        const charFile = characterLoraFile(char)
        const charGone = charFile !== null && !listed.includes(charFile)
        // A deleted file takes its remembered strength with it.
        const remembered = Object.keys(s.loraStrengths)
        const strengths = remembered.every((n) => listed.includes(n))
          ? {}
          : { loraStrengths: Object.fromEntries(remembered.filter((n) => listed.includes(n)).map((n) => [n, s.loraStrengths[n]])) }
        if (kept.length === s.selectedLoras.length && !charGone) return strengths
        return { selectedLoras: kept, ...strengths, ...(charGone ? { selectedCharacter: null } : {}) }
      }),
      setSelectedVae: (name) => set({ selectedVae: name || 'auto' }),
      setClipSkip: (n) => set({ clipSkip: Math.max(0, Math.min(12, Math.floor(n))) }),
      setGrowMaskBy: (n) => set({ growMaskBy: Math.max(0, Math.min(64, Math.floor(n))) }),
      setTargetResolution: (targetResolution) => set({ targetResolution }),
      setMacUpscaleScale: (macUpscaleScale) => set({ macUpscaleScale }),
      setCharacterTab: (characterTab) => set((s) => withOwnStudioOptions(s, { characterTab })),
      // Cap at the backend's photo limit (lib/train-image-cap) and skip a
      // re-drop of a file already in the set, so the same folder twice does
      // not double it. Every photo keeps a name of its own: a DIFFERENT photo
      // under a name the set already holds (IMG_0001.png from a second
      // folder, two face.png in one drop) is numbered on, face_2.png, the way
      // the Rust side's free_stem numbers a stem. The name is the photo's id
      // for Remove, its caption and the grid key. Skipping and capping both
      // THROW REFS AWAY: the caller minted a blob: URL for every file it
      // handed over, and none of the dropped ones is reachable from the store
      // afterwards. So "before" is everything in play, not just what was
      // already staged.
      addTrainImages: (imgs) => {
        const before = get().trainImages
        const taken = new Set(before.map((i) => i.name.toLowerCase()))
        const added: MediaRef[] = []
        for (const img of imgs) {
          if (before.some((had) => isSameTrainFile(had, img))) continue
          const name = freeTrainImageName(img.name, taken)
          taken.add(name.toLowerCase())
          added.push(name === img.name ? img : { ...img, name })
        }
        const trainImages = [...before, ...added].slice(0, maxTrainImages(get().backend))
        releaseDroppedMediaRefs([...before, ...imgs], trainImages)
        set({ trainImages })
      },
      removeTrainImage: (name) => {
        const before = get().trainImages
        const trainImages = before.filter((i) => i.name !== name)
        releaseDroppedMediaRefs(before, trainImages)
        // The caption goes with its photo: a new photo of the same name must
        // not inherit the old one's description.
        const trainCaptions = { ...get().trainCaptions }
        delete trainCaptions[name]
        set({ trainImages, trainCaptions })
      },
      // Called after every submitted training run (useCloudCreate.ts), which
      // is where the whole 30-photo set used to stay pinned for the session.
      clearTrainImages: () => {
        releaseDroppedMediaRefs(get().trainImages, [])
        set({ trainImages: [], trainCaptions: {} })
      },
      // C7: the field holds the word in the one form the trainer, the LoRA
      // file name and the Use shelf agree on (lib/train-trigger.ts). The note
      // stays until the field is emptied, so it is still there after the next
      // keystroke.
      setTriggerWord: (w) => set((s) => {
        const triggerWord = typedTriggerWord(w)
        const note = triggerWordNote(w)
        return { triggerWord, triggerWordNote: triggerWord || note ? note ?? s.triggerWordNote : null }
      }),
      // Same clamp as the Rust command so the UI can never book a rejected run.
      setTrainSteps: (n) => set({ trainSteps: Math.max(100, Math.min(4000, Math.floor(n))) }),
      setTrainCaption: (name, text) => set((s) => {
        // Kept as typed (spaces included) while the field has focus; the
        // caption builder cleans it on the way to the trainer.
        const value = text.replace(/[\r\n]+/g, ' ').slice(0, TRAIN_CAPTION_MAX)
        if (!s.trainImages.some((i) => i.name === name)) return {}
        const trainCaptions = { ...s.trainCaptions }
        if (value.trim()) trainCaptions[name] = value
        else delete trainCaptions[name]
        return { trainCaptions }
      }),
      setTrainVramPreset: (p) => set({ trainVramPreset: isTrainVramPreset(p) ? p : TRAIN_VRAM_PRESET_DEFAULT }),
      // The steps follow the mode: each has its own three presets, and a
      // number of the other mode would match none of the switch's options.
      setTrainKind: (k) => set((s) => {
        const trainKind = isTrainKind(k) ? k : TRAIN_KIND_DEFAULT
        if (trainKind === s.trainKind) return {}
        const fits = trainPresetsFor(trainKind).some((p) => p.steps === s.trainSteps)
        return { trainKind, ...(fits ? {} : { trainSteps: trainStepsDefaultFor(trainKind) }) }
      }),
      setTrainStyleTrigger: (on) => set({ trainStyleTrigger: !!on }),
      setSelectedCharacter: (selectedCharacter) => set((s) => withOwnStudioOptions(s, { selectedCharacter })),
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
      setLoraListKey: (names) => set((s) => {
        const key = names.join('\n')
        return key === s.loraListKey ? s : { loraListKey: key }
      }),
      setCloudOpModel: (cloudOpModel) => set((s) => withOwnStudioOptions(s, { cloudOpModel })),
      setCloudStudioOptions: (cloudStudioOptions) => set({ cloudStudioOptions }),
      setCloudStudioCredits: (cloudStudioCredits) => set({ cloudStudioCredits }),
      setCloudImageCount: (count) => set({ cloudImageCount: clampImageCount(count) }),
      setImprovePrompt: (on) => set({ improvePrompt: on === true }),
      setImproveWith: (who) => set({ improveWith: IMPROVE_WITH.includes(who) ? who : 'auto' }),
      setQwenTextEncoder: (which) => set({ qwenTextEncoder: QWEN_ENCODER_CHOICES.includes(which) ? which : 'auto' }),
      setTextEncoderList: (list) => set({ textEncoderList: list }),
      setMlxEnhancerList: (list) => set({ mlxEnhancerList: list }),
      setVideoShotCount: (count) => set((st) => {
        const further = Math.max(1, Math.min(MAX_SHOTS, Math.floor(count) || 1)) - 1
        return { videoShots: Array.from({ length: further }, (_, i) => st.videoShots[i] ?? '') }
      }),
      setVideoShot: (index, text) => set((st) => {
        if (index < 0 || index >= st.videoShots.length) return {}
        const next = [...st.videoShots]
        next[index] = text.slice(0, MAX_SHOT_CHARS)
        return { videoShots: next }
      }),
      setTransparentBackground: (on) => set({ transparentBackground: on === true }),
      // Picking a lane model adopts its architecture defaults (like
      // setVideoModel does) — an inherited 1024×1024 from the Image tab would
      // OOM a 14B S2V run on consumer VRAM.
      setLocalOpModel: (localOpModel) => {
        // A Motion Control model of the Mac brings its catalogue's values.
        const mac = get().motionModelList.find((m) => m.name === localOpModel && m.mlxVideo)
        if (mac) {
          set({ localOpModel, ...videoModelParams(localOpModel, get().motionModelList, 'motion') })
          return
        }
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
      setUpscaleModelList: (upscaleModelList) => set({ upscaleModelList }),
      setUpscaleFactor: (f) => set({ upscaleFactor: normalizeUpscaleFactor(f) }),
      setExtendSource: (extendSource) => set({ extendSource }),
      setMusicDuration: (s2) => set({ musicDuration: Math.max(5, Math.min(240, Math.floor(s2))) }),
      setMusicLyrics: (musicLyrics) => set({ musicLyrics: musicLyrics.slice(0, 2000) }),
      setTalkingWords: (talkingWords) => set({ talkingWords: talkingWords.slice(0, 600) }),
      setMusicHowtoSeen: (musicHowtoSeen) => set({ musicHowtoSeen }),
      setSource: (source) => {
        // The list of further source images goes with the image it belongs to.
        if (!source) get().setBatchSources([])
        set({ source, sourceSetAt: source ? Date.now() : 0, ...(source ? {} : { mask: null, references: [], endImage: null }) })
      },
      // Capped at the most any model takes, local or cloud (lib/edit-references);
      // the UI offers fewer for a model with fewer slots and the builder slices.
      addReference: (img) => set((s) => ({ references: [...s.references, img].slice(0, MAX_STORED_REFERENCES) })),
      removeReference: (index) => set((s) => ({ references: s.references.filter((_, i) => i !== index) })),
      setReferences: (references) => set({ references }),
      setEndImage: (endImage) => set({ endImage }),
      addImageReference: (img) => set((s) => ({ imageReferences: [...s.imageReferences, img].slice(0, MAX_STORED_REFERENCES + 1) })),
      removeImageReference: (index) => set((s) => ({ imageReferences: s.imageReferences.filter((_, i) => i !== index) })),
      setBatchSources: (batchSources) => {
        releaseDroppedMediaRefs(get().batchSources, batchSources)
        set({ batchSources })
      },
      setBatchRun: (batchRun) => set({ batchRun }),
      setBatchOriginal: (batchOriginal) => set({ batchOriginal }),
      setMask: (mask) => set({ mask }),
      // Flipping to local clears the intents that have no local lane
      // (eraser, and upscale on a Mac, which has no ComfyUI) so the
      // surface never strands on a dead op the IntentBar no longer shows. Edit
      // keeps its state since 2.5.7 (checkpoint mask inpaint), removebg keeps
      // its RMBG lane, and animate keeps its i2v state since 2026-07-17 — the
      // local I2V lane is back (buildDynamicWorkflow wires the family's
      // image-to-video node).
      setBackend: (backend) => {
        // The lanes of LOCAL_LANE_OPS are ComfyUI graphs, and a Mac runs MLX.
        // There the bar shows them as locked cloud teasers, so a flip from
        // Cloud while Music (or Lipsync, Extend, Motion, Character) was open
        // left the local composer of a lane this Mac cannot run, with no tab
        // selected in the bar and an empty model picker (persona walk,
        // 09.10.2026). The flip below keeps the lane as it does everywhere,
        // and then the Mac leaves it the way a click on Image or Video does
        // (setIntent), so the lane's own steps and inputs do not travel along:
        // dropping the op alone sent the 50 steps of Music to SD Turbo.
        // Extend Video stays where a video model of this Mac takes a start
        // image (intents.ts runsOnMlx), and Music while the Mac's music
        // engine is installed (commands/music.rs): then the lane stays as it
        // does on Windows.
        const keepsExtend = get().cloudOp === 'extend' && mlxTakesStartImage(get().videoModelList)
        // Motion Control likewise, while an installed model follows a motion
        // video (an LTX-2.3 pack of the second engine).
        const macRunsOp = (get().cloudOp === 'music' && mlxMakesMusic(get().audioModelList))
          || (get().cloudOp === 'motion' && mlxFollowsMotion(get().videoModelList))
          // Talking Character while an installed model talks (the same rule
          // the bar uses, mlxTalking), and Character Studio always: the Mac
          // uses a character through mflux and trains one with mflux-train.
          || (get().cloudOp === 'lipsync' && mlxTalking(get().videoModelList).tab)
          || get().cloudOp === 'character'
        const strandsOnMac = backend === 'local' && isMlxImageHost() && !!get().cloudOp && !keepsExtend && !macRunsOp
        const heldMode = get().mode
        set((s) => withOwnStudioOptions(s, ((): Partial<CreateState> => {
          // An error belongs to the mode it came from: "Use locally failed"
          // from the Cloud shelf stood on in red after the flip to Local
          // (how-to recording, 15.10.2026).
          const cleared: Partial<CreateState> = s.backend !== backend ? { error: null } : {}
          // On a phone the axis has one end. A caller that asks for the local
          // track (a shared component, a restored habit) gets the cloud.
          if (isMobile()) return { backend: 'cloud', ...cleared }
          if (backend !== 'local') return { backend, ...cleared }
          const patch: Partial<CreateState> = { backend, ...cleared }
          // Enhance keeps its tab on Windows and Linux (local ComfyUI upscale,
          // 3.0.7), and on a Mac with an upscaler: SeedVR2 runs it there
          // (commands/mlx.rs mlx_upscale). Erase always closes, as does
          // Enhance on a Mac without an upscaler.
          const mac = isMlxImageHost()
          const toolStays = mac
            ? s.utilityOp === 'upscale' && s.mlxUpscale
            : !!s.utilityOp && LOCAL_UTILITY_OPS.has(s.utilityOp)
          if (s.utilityOp && !toolStays) Object.assign(patch, { utilityOp: null, mask: null, error: null })
          // music/lipsync/extend/motion (2.5.8) and character (2.6.0, local
          // musubi trainer) run locally, so a backend flip keeps them
          // selected; only the genuinely hosted-only ops (upscale/eraser)
          // drop. LOCAL_LANE_OPS is the single source of truth.
          if (s.cloudOp && !LOCAL_LANE_OPS.has(s.cloudOp)) {
            Object.assign(patch, { cloudOp: null, error: null })
          }
          // Und auf einem Mac laeuft lokal MLX, nicht ComfyUI. Edit gibt es
          // dort nur, solange ein installiertes Bildmodell ein Bild nimmt, und
          // Animate nur, solange ein installiertes Videomodell ein Startbild
          // nimmt; `visibleIntents` blendet sie sonst aus. Bleibt eine davon gewaehlt, findet die
          // Werkzeugleiste ihren eigenen Eintrag nicht mehr und steht ohne
          // Auswahl da. Gemessen am 04.09.2026: erreichbar ohne einen einzigen
          // Klick in der Leiste, allein ueber den Backend-Schalter.
          //
          // Nur wenn wirklich das Grundwerkzeug zu sehen ist: haelt der Nutzer
          // eine der lokalen Bahnen (Music, Lipsync, Extend, Motion,
          // Character), bleibt seine Wahl fuer img2img und i2v unangetastet,
          // damit sie beim Zurueckschalten noch da ist.
          const opBleibt = ('cloudOp' in patch ? patch.cloudOp : s.cloudOp)
            || ('utilityOp' in patch ? patch.utilityOp : s.utilityOp)
          if (isMlxImageHost() && !opBleibt) {
            // Remove Background stays: every Mac cuts out through Vision
            // (commands/mlx_cutout.rs), with no model and no ComfyUI node.
            // Edit bleibt, solange ein installiertes Bildmodell ein Bild
            // nimmt (Qwen-Image 2.1 ueber die zweite Engine). Eine Maske
            // gibt es dort nicht: was in der Cloud gemalt wurde, geht mit.
            if (s.imageSubMode === 'img2img' && !s.removebg) {
              if (!mlxTakesEditImage(s.imageModelList)) Object.assign(patch, { imageSubMode: 'text2img' })
              else Object.assign(patch, editLanePick(s))
            }
            if (s.mask) Object.assign(patch, { mask: null })
            if (s.videoSubMode === 'i2v' && !mlxTakesStartImage(s.videoModelList)) Object.assign(patch, { videoSubMode: 't2v' })
          }
          // A tab this flip closes takes its number of images with it, like
          // any other tab change (setIntent).
          if (deriveIntent({ ...s, ...patch }) !== deriveIntent(s)) Object.assign(patch, { cloudImageCount: 1 })
          return patch
        })()))
        if (strandsOnMac && get().cloudOp) get().setIntent(heldMode === 'video' ? 'video' : 'image')
      },
      setCloudImageModel: (cloudImageModel) => set((s) => withOwnStudioOptions(s, { cloudImageModel })),
      setCloudVideoModel: (cloudVideoModel) => set((s) => withOwnStudioOptions(s, { cloudVideoModel })),
      setCaps: (caps) => set({ caps }),
      resetParamsToModelDefaults: () => {
        const s = get()
        const d = s.mode === 'video'
          ? (MODEL_TYPE_DEFAULTS[classifyModel(s.videoModel)] || MODEL_TYPE_DEFAULTS.unknown)
          : MODEL_TYPE_DEFAULTS[s.imageModelType]
        // The picked model's own values where it has some: a distilled
        // checkpoint reset to its family's 25 or 30 steps renders to mush.
        // LU Cloud renders with its own model, there the family stays.
        const own = s.backend === 'cloud' ? {} : s.mode === 'video' ? videoModelParams(s.videoModel, s.videoModelList, videoIntentOf(s), s.videoSpeed) : imageModelParams(s)
        set({
          sampler: d.sampler,
          scheduler: d.scheduler,
          steps: d.steps,
          cfgScale: d.cfgScale,
          width: d.width,
          height: d.height,
          ...own,
          hiresFixEnabled: false,
          hiresScale: 1.5,
          hiresDenoise: 0.5,
          hiresSteps: 12,
          hiresUpscaleMethod: 'nearest-exact',
          ...(d.frames ? { frames: d.frames } : {}),
          ...(d.fps ? { fps: d.fps } : {}),
          // A model's defaults carry no LoRA, so the stack goes off like with
          // Clear (and the local character that rode on it). The strength each
          // LoRA was left at stays in loraStrengths for the next time.
          selectedLoras: [],
          selectedCharacter: isLocalCharacter(s.selectedCharacter) ? null : s.selectedCharacter,
        })
        // The Mac's Edit goes back to the canvas it starts on, not to 1024.
        set((now) => withMacEditCanvas(now, {}))
      },

      setIsGenerating: (generating) => set({ isGenerating: generating, ...(generating ? {} : { progressPhase: 'idle' as ProgressPhase }) }),
      setComfyCorsBlocked: (blocked) => set({ comfyCorsBlocked: blocked }),
      setProgress: (progress, text) => set({ progress, progressText: text ?? '' }),
      setProgressPhase: (phase) => set({ progressPhase: phase }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      setVhsInstallPrompt: (resolver) => set({ vhsInstallPrompt: resolver }),
      setFixupPrompt: (prompt) => set({ fixupPrompt: prompt }),
      setError: (error) => set({ error }),
      setLastGenTime: (time) => set({ lastGenTime: time }),
      // Ein frisches Cloud-Ergebnis stellt den Wolken-Modellwaehler auf das
      // Modell, mit dem es entstanden ist, damit man direkt daran
      // weiterarbeiten kann. Ein Studio-Eintrag stellt auf seinen
      // Katalogzwilling (STUDIO_MODELS[...].sourceModel), denn der steht im
      // Waehler; ohne Zwilling bleibt der Waehler, wie er ist.
      //
      // NUR auf der Wolken-Spur: im Desktop landen hier auch lokale ComfyUI-
      // und MLX-Ergebnisse (anders als im Web, das keine lokale Spur kennt),
      // und ein lokaler Lauf darf den Cloud-Waehler nie umstellen (Portplan
      // Abschnitt 3e).
      addToGallery: (item) => set((s) => {
        // A new result lands in the folder the gallery has open.
        const filed = !item.folderId && s.galleryFolderOpen && s.galleryFolders.some((f) => f.id === s.galleryFolderOpen)
          ? { ...item, folderId: s.galleryFolderOpen }
          : item
        const next = [filed, ...s.gallery]
        // The cap used to drop the oldest renders silently, taking the only
        // reference to their blob: URLs with them — the bytes stayed pinned
        // for the rest of the session with nothing left to revoke them by.
        for (const dropped of next.slice(GALLERY_CAP)) releaseItemMedia(dropped)
        const gallery = next.slice(0, GALLERY_CAP)
        if (s.backend !== 'cloud') return { gallery }
        const id = STUDIO_MODELS[item.model]?.sourceModel ?? item.model
        if (cloudModelsFor('image').some((m) => m.id === id)) return withOwnStudioOptions(s, { gallery, cloudImageModel: id })
        if (cloudModelsFor('video').some((m) => m.id === id)) return withOwnStudioOptions(s, { gallery, cloudVideoModel: id })
        return { gallery }
      }),
      updateGalleryItem: (id, patch) =>
        // NOT revoking a replaced dataUrl here on purpose: a patch lands while
        // the tile is on screen (a lazy re-sign, a restore-from-disk), and
        // revoking a URL an <img>/<video> may still be loading would break the
        // very media this patch exists to fix.
        set((s) => ({ gallery: s.gallery.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
      // Cloud hydration: the server's job list is the source of truth for
      // hosted renders. Existing items (matched by jobId/id) just get a fresh
      // signed URL plus a backfilled prompt/label when they never had one
      // (an older gallery, from before the list route sent them), nothing
      // here ever overwrites what is already on screen, so a value the
      // customer already saw cannot jump. Unknown jobs (other device,
      // cleared storage) are added with the server's metadata.
      mergeGallery: (items) => set((s) => {
        const byKey = new Map<string, GalleryItem>()
        for (const g of s.gallery) byKey.set(g.jobId ?? g.id, g)
        for (const it of items) {
          const key = it.jobId ?? it.id
          const prev = byKey.get(key)
          byKey.set(
            key,
            prev
              ? {
                  ...prev,
                  remoteUrl: it.remoteUrl,
                  attestation: it.attestation,
                  prompt: prev.prompt || it.prompt,
                  label: prev.label ?? it.label,
                }
              : it,
          )
        }
        const merged = [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt)
        // Review A3: dieselbe Zusage wie in addToGallery/removeFromGallery,
        // jeder Pfad, der einen Eintrag aus der Galerie wirft, gibt seine
        // blob-URL frei. Ein lokaler MLX-Clip, den eine Wolken-Hydrierung vom
        // Deckel schiebt, hielt seine Bytes sonst fuer den Rest der
        // Fenster-Lebensdauer fest (lu-desktop-oom-persist).
        for (const dropped of merged.slice(GALLERY_CAP)) releaseItemMedia(dropped)
        return { gallery: merged.slice(0, GALLERY_CAP) }
      }),
      removeFromGallery: (id) => set((s) => {
        const gone = s.gallery.find((g) => g.id === id)
        const remaining = s.gallery.filter((g) => g.id !== id)
        if (gone) {
          releaseItemMedia(gone)
          // The file goes too, into the Recycle Bin or the Trash (lib/gallery-trash.ts).
          void import('../lib/gallery-trash')
            .then((m) => m.trashGalleryFile(gone, remaining))
            .then((problem) => { if (problem) useCreateStore.getState().setError(problem) })
            .catch(() => { /* the entry is gone either way */ })
        }
        return { gallery: remaining }
      }),
      clearGallery: () => set((s) => {
        for (const g of s.gallery) releaseItemMedia(g)
        return { gallery: [] }
      }),
      // Gallery folders (D3). Labels only: nothing here reaches a file.
      addGalleryFolder: (name) => {
        const clean = cleanFolderName(name)
        const s = get()
        if (!clean || s.galleryFolders.length >= FOLDER_CAP) return null
        const id = newFolderId(s.galleryFolders)
        set({ galleryFolders: [...s.galleryFolders, { id, name: clean }] })
        return id
      },
      renameGalleryFolder: (id, name) => set((s) => {
        const clean = cleanFolderName(name)
        if (!clean) return {}
        return { galleryFolders: s.galleryFolders.map((f) => (f.id === id ? { ...f, name: clean } : f)) }
      }),
      removeGalleryFolder: (id) => set((s) => ({
        galleryFolders: s.galleryFolders.filter((f) => f.id !== id),
        gallery: s.gallery.map((g) => (g.folderId === id ? { ...g, folderId: undefined } : g)),
        galleryFolderOpen: s.galleryFolderOpen === id ? null : s.galleryFolderOpen,
      })),
      moveToGalleryFolder: (ids, folderId) => set((s) => {
        if (folderId !== null && !s.galleryFolders.some((f) => f.id === folderId)) return {}
        const pick = new Set(ids)
        return {
          gallery: s.gallery.map((g) => (pick.has(g.id) ? { ...g, folderId: folderId ?? undefined } : g)),
        }
      }),
      setGalleryFolderOpen: (id) => set((s) => ({
        galleryFolderOpen: id !== null && s.galleryFolders.some((f) => f.id === id) ? id : null,
      })),
      addToPromptHistory: (prompt) => set((s) => {
        const filtered = s.promptHistory.filter(p => p !== prompt)
        return { promptHistory: [prompt, ...filtered].slice(0, 50) }
      }),
      removeFromPromptHistory: (prompt) =>
        set((s) => ({ promptHistory: s.promptHistory.filter((p) => p !== prompt) })),
      clearPromptHistory: () => set({ promptHistory: [] }),
      // On the Mac the Edit tab exists only while an installed model takes an
      // image. When the last one goes, a selected Edit would stand in a bar
      // that no longer shows it, so it falls back to Image, the way Animate
      // falls back to Video below. A ComfyUI list is never touched.
      setImageModelList: (list) => set((s) => {
        const strands = isMlxImageHost() && s.backend === 'local' && !s.cloudOp && !s.utilityOp
          && s.mode === 'image' && s.imageSubMode === 'img2img' && !s.removebg && !mlxTakesEditImage(list)
        return strands ? { imageModelList: list, imageSubMode: 'text2img' } : { imageModelList: list }
      }),
      // On the Mac the Animate tab exists only while an installed model starts
      // from an image. When the last one goes (removed in the Model Manager),
      // a selected Animate would stand in a bar that no longer shows it, so it
      // falls back to Video. Lists without the catalogue's word (ComfyUI) are
      // never touched.
      setVideoModelList: (list) => set((s) => {
        const strands = isMlxImageHost() && s.backend === 'local' && !s.cloudOp && !s.utilityOp
          && s.mode === 'video' && s.videoSubMode === 'i2v' && !mlxTakesStartImage(list)
        // Extend Video runs on the same models on a Mac, and falls back the
        // same way when the last of them goes.
        const extendStrands = isMlxImageHost() && s.backend === 'local' && s.cloudOp === 'extend' && !mlxTakesStartImage(list)
        if (extendStrands) return { videoModelList: list, cloudOp: null, extendSource: null, source: null, videoSubMode: 't2v' }
        // Motion Control, when the last model that follows a motion video goes.
        const motionStrands = isMlxImageHost() && s.backend === 'local' && s.cloudOp === 'motion' && !mlxFollowsMotion(list)
        if (motionStrands) return { videoModelList: list, cloudOp: null, source: null, videoSubMode: 't2v' }
        return strands ? { videoModelList: list, videoSubMode: 't2v' } : { videoModelList: list }
      }),
      // On the Mac Enhance Image is a local tab while an upscaler is
      // installed. When the last one goes (removed in the Model Manager), a
      // selected Enhance would stand in the bar as a locked tab with nothing
      // selected, so it falls back to Image, the way Edit does.
      setMlxUpscale: (mlxUpscale) => {
        const s = get()
        if (s.mlxUpscale === mlxUpscale) return
        const strands = !mlxUpscale && isMlxImageHost() && s.backend === 'local' && s.utilityOp === 'upscale'
        set({ mlxUpscale })
        if (strands) get().setIntent('image')
      },
      setComfyRunning: (running) => set((s) => {
        if (!running || s.comfyRunning) return { comfyRunning: running }
        // ComfyUI is back: every local tile that failed while it was away
        // gets another go instead of staying dark until the next restart.
        const retry = (g: GalleryItem) => g.unavailable && g.unavailableReason !== 'gone' && !g.jobId && !g.localPath
        if (!s.gallery.some(retry)) return { comfyRunning: running }
        return {
          comfyRunning: running,
          gallery: s.gallery.map((g) => retry(g)
            ? { ...g, unavailable: undefined, unavailableReason: undefined, reloadKey: (g.reloadKey ?? 0) + 1 }
            : g),
        }
      }),
    }),
    {
      name: 'create-store',
      // skipUnchanged: setProgress and the other runtime setters change nothing
      // partialize keeps, and without the flag each of them still rewrote the
      // whole slice (measured in stores/__tests__/createStore-write-load.test.ts).
      storage: safeJSONStorage({ skipUnchanged: true }),
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
        videoSpeed: state.videoSpeed,
        longVideoSeconds: state.longVideoSeconds,
        longVideoMode: state.longVideoMode,
        ...restartSampling(state),
        denoise: state.denoise,
        editStrength: state.editStrength,
        hiresFixEnabled: state.hiresFixEnabled,
        hiresScale: state.hiresScale,
        hiresDenoise: state.hiresDenoise,
        hiresSteps: state.hiresSteps,
        hiresUpscaleMethod: state.hiresUpscaleMethod,
        // Media bytes never go to localStorage — a handful of multi-MB base64
        // dataUrls would blow the origin quota (~5-10 MB in WebView2/WKWebView)
        // and every subsequent set() would throw, killing ALL create-store
        // persistence. Cloud items carry remoteUrl + jobId and re-sign lazily.
        gallery: state.gallery.map(({ dataUrl, unavailable, unavailableReason, reloadKey, ...g }: GalleryItem) => g),
        // Folders are an id and a short name each, capped (lib/gallery-folders.ts).
        // Additive: an older blob has none and merge() gives it the empty list.
        galleryFolders: state.galleryFolders,
        promptHistory: state.promptHistory,
        // ── redesign additions (advanced params only; runtime inputs
        //    source/mask/backend/caps stay unpersisted). No version bump: these
        //    are additive and merge() backfills missing keys from defaults. ──
        showNegative: state.showNegative,
        selectedLoras: state.selectedLoras,
        loraStrengths: state.loraStrengths,
        loraLanes: state.loraLanes,
        selectedVae: state.selectedVae,
        clipSkip: state.clipSkip,
        growMaskBy: state.growMaskBy,
        // 2.5.8 cloud categories: only the cheap scalar prefs persist — the
        // staged media (blobs / object URLs) and cloudOp are runtime-only.
        musicDuration: state.musicDuration,
        musicHowtoSeen: state.musicHowtoSeen,
        improvePrompt: state.improvePrompt,
        improveWith: state.improveWith,
        qwenTextEncoder: state.qwenTextEncoder,
        transparentBackground: state.transparentBackground,
        triggerWord: state.triggerWord,
        trainSteps: state.trainSteps,
        trainVramPreset: state.trainVramPreset,
        trainKind: state.trainKind,
        trainStyleTrigger: state.trainStyleTrigger,
        // Studio: the picked step's option values are a preference like the
        // ones above. cloudStudioCredits is NOT here on purpose: a saved
        // price from yesterday is a lie, see the field's own doc comment.
        cloudStudioOptions: state.cloudStudioOptions,
        upscaleFactor: state.upscaleFactor,
      }),
      // Future schema bumps hook into migrate. NOTE: zustand only invokes it
      // when the stored blob carries a NUMERIC version that differs — legacy
      // pre-version blobs skip it entirely, so their fixups must live in merge.
      //
      // Bumped 1 -> 2 for the Studio fields (Portplan Abschnitt 3f). This
      // stays inside the R1 DOWNGRADE-KONTRAKT (see lib/persist-version.ts):
      // an older build that still declares version 1 already ships its own
      // migrate (the identity function below, unchanged by this bump), so a
      // downgrade reading a version-2 blob calls THAT migrate, gets the state
      // back unchanged, and loses nothing: the pairing the contract asks
      // for was already in place before this change.
      version: 2,
      // Explicit annotations for the same reason the state creator carries
      // them (see above): under `strict: true` zustand v5 loses contextual
      // typing here and infers the store as Partial<CreateState>.
      //
      // A version-1 blob is missing cloudStudioOptions/cloudStudioCredits
      // entirely (they did not exist yet); merge() below already backfills
      // any key absent from the persisted blob from `current`'s defaults, so
      // this migrate only needs to guard the one case merge() cannot: a
      // blob that DOES carry the key but as `undefined` (a JSON round-trip
      // through some storages drops `undefined` values, but not every one
      // does, and `Object.entries()` in the Composer must never see it).
      migrate: (persisted: unknown): CreateState => {
        const p = persisted as Partial<CreateState> | null | undefined
        if (!p || typeof p !== 'object') return persisted as CreateState
        return {
          ...p,
          cloudStudioOptions: (p.cloudStudioOptions ?? {}) as Record<string, unknown>,
          cloudStudioCredits: p.cloudStudioCredits ?? null,
        } as CreateState
      },
      merge: (persisted: unknown, current: CreateState): CreateState => {
        // Never let runtime-only fields rehydrate (a foreign/corrupt blob must
        // not flip the backend axis or inject a stale source/mask), backfill
        // missing keys from defaults, and fix up legacy pre-version blobs
        // ('i2i' mode from the v2.3.0 refactor).
        const raw = isRecord(persisted) ? persisted : {}
        const safe: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(raw)) if (!RUNTIME_ONLY_KEYS.includes(k)) safe[k] = v
        // 'i2i' was a MODE of its own before v2.3.0; it is now mode 'image'
        // plus imageSubMode 'img2img'. Fixed on the raw blob, because the
        // value is not a member of the current union any more.
        if ('upscaleFactor' in safe) safe.upscaleFactor = normalizeUpscaleFactor(safe.upscaleFactor)
        if (safe.mode === 'i2i') {
          safe.mode = 'image'
          safe.imageSubMode = 'img2img'
        }
        // Gallery folders came in 3.0.7. An older blob has no list (the
        // default stays), a damaged one is cleaned instead of trusted.
        if ('galleryFolders' in safe) safe.galleryFolders = sanitizeFolders(safe.galleryFolders)
        // 3.0.9 B24: an older blob has no lanes, a damaged one is cleaned.
        if ('loraLanes' in safe) safe.loraLanes = sanitizeLoraLanes(safe.loraLanes)
        // 3.0.8 D20: an unknown recipe name would reach the trainer as text.
        if ('trainVramPreset' in safe && !isTrainVramPreset(safe.trainVramPreset)) safe.trainVramPreset = TRAIN_VRAM_PRESET_DEFAULT
        // 3.0.9 P8: same for the mode, it picks the LoRA's file name.
        if ('trainKind' in safe && !isTrainKind(safe.trainKind)) safe.trainKind = TRAIN_KIND_DEFAULT
        if ('trainStyleTrigger' in safe && typeof safe.trainStyleTrigger !== 'boolean') safe.trainStyleTrigger = true
        // The persisted slice is ~30 independent scalar preferences (see
        // partialize). They are adopted as written, which is what the store
        // has always done; the fields that could actually do damage — the
        // backend axis and the staged media — are the ones dropped above.
        return { ...current, ...safe } as CreateState
      },
    }
  )
)

/** Which pick slot the current sub-category owns. Character Studio USE picks a
 *  generation endpoint, TRAIN a trainer, so they are two slots. */
export function opSlot(s: Pick<CreateState, 'characterTab' | 'removebg' | 'utilityOp' | 'cloudOp' | 'mode' | 'imageSubMode' | 'videoSubMode'>): string {
  const intent = deriveIntent(s)
  return intent === 'character' && s.characterTab === 'use' ? 'character:use' : intent
}

// One shared cloudOpModel used to serve lip sync, music, extend, motion and
// video upscale, so a pick in one sub-category replaced the pick of another
// (Opus review 02.10.2026). The slot map keeps one pick each, and the single
// field every reader uses stays, as the mirror of the current slot:
//   - the slot changed: the field takes that slot's own pick ('' if none yet);
//   - the field changed inside a slot: that is a pick for the slot, remember it.
// Runtime-only, nothing is persisted, so there is no stored pick to migrate.
useCreateStore.subscribe((s, prev) => {
  const slot = opSlot(s)
  if (slot !== opSlot(prev)) {
    const want = s.cloudOpPicks[slot] ?? ''
    if (s.cloudOpModel !== want) useCreateStore.setState(withOwnStudioOptions(s, { cloudOpModel: want }))
  } else if (s.cloudOpModel !== prev.cloudOpModel && s.cloudOpPicks[slot] !== s.cloudOpModel) {
    useCreateStore.setState({ cloudOpPicks: { ...s.cloudOpPicks, [slot]: s.cloudOpModel } })
  }
})

// B24: the LoRA picks belong to the task and the local model on screen. A
// change of either puts the picks aside under the lane that was left and
// brings back the ones of the lane entered (none for a new one), so a video
// LoRA never stays on after the change to Image. A change that set the picks
// itself (a trained style switched on with its tab) keeps them, and so does
// the LoRA of the picked character.
function loraLaneOf(s: CreateState): string | null {
  return loraLaneKey(deriveIntent(s), s.mode === 'video' ? s.videoModel : s.imageModel)
}
useCreateStore.subscribe((s, prev) => {
  const swap = switchLoraLane(
    { key: loraLaneOf(prev), picks: prev.selectedLoras },
    { key: loraLaneOf(s), picks: s.selectedLoras },
    s.loraLanes,
    s.selectedLoras !== prev.selectedLoras,
  )
  if (swap) useCreateStore.setState(swap)
})
