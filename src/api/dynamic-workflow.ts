import { transparentPrompt } from '../lib/transparent-image'
import {
  classifyModel, ref2vFamily, ref2vRefusal, findMatchingVAE, findMatchingCLIP, findFluxCLIPPair, findMiniMaxAudioVAE, findLtx25AudioVAE, isFastH3, wan22LowNoisePartner,
  findMatchingAudioEncoder, findMatchingClipVision, findFramePackCLIPPair, getSystemVRAM,
} from './comfyui'
import { isMacOS } from './backend'
import { QWEN21_TURBO_NODES, QWEN21_TURBO_SAMPLING, QWEN21_TURBO_SIGMAS, isQwenImage21Turbo } from '../lib/render/qwen21-turbo'
import { comfyEditFullImages, qwenEditPlusOverCard } from '../lib/comfy-edit-memory'
import type { ModelType, GenerateParams, VideoParams } from './comfyui'
import { log } from '../lib/logger'
import { resolveRunSeed } from '../lib/run-seed'
import { nodeComboOptions, readComboOptions } from './comfyui-enum'
import { COMPONENT_REGISTRY, type ComponentSpec } from './component-registry'
import { MissingComponentsError, resolveFamilyParts, type SniffedFamily } from './family-components'
import {
  getAllNodeInfo,
  categorizeNodes,
  detectAvailableModels,
  type CategorizedNodes,
  type AvailableModels,
  type NodeMetadata,
} from './comfyui-nodes'
import type { ComfyApiGraph, ComfyInputValue, ComfyNodeInputs } from '../types/comfy-graph'

/**
 * The `/object_info` node table as the LANE builders use it: they only ever ask
 * whether a node class is installed, never what its schema says, so a presence
 * map is the honest parameter type. `buildDynamicWorkflow` itself keeps the
 * full `Record<string, NodeMetadata>` from getAllNodeInfo(), because it does
 * read schemas (RMBG, the I2V conditioning node, LoraLoader's combo).
 */
type NodePresence = Record<string, unknown>

/**
 * Split one `/object_info` input spec into the two halves every caller wants.
 *
 * ComfyUI writes a spec as `[typeName, config]` (current) or `[[options]]`
 * (legacy combo). Neither half is guaranteed, and a custom node can put
 * anything there, so both come back optional. Combo OPTIONS are not read here
 * — `readComboOptions` is the single reader that knows all three shapes.
 */
function specParts(spec: ComfyInputValue | undefined): {
  typeName?: string
  config?: { [k: string]: ComfyInputValue }
} {
  if (!Array.isArray(spec)) return {}
  const head = spec[0]
  const cfg = spec[1]
  return {
    typeName: typeof head === 'string' ? head : undefined,
    config: typeof cfg === 'object' && cfg !== null && !Array.isArray(cfg) ? cfg : undefined,
  }
}

/** The `default` a widget spec declares, or undefined when it declares none. */
function specDefault(spec: ComfyInputValue | undefined): ComfyInputValue | undefined {
  return specParts(spec).config?.default
}

// promptFilenamePrefix und videoDecodeNode wohnen in comfyui-graph.ts (siehe
// dort). Re-Export, damit bestehende Importpfade unverändert bleiben.
export { promptFilenamePrefix, videoDecodeNode } from './comfyui-graph'
import { promptFilenamePrefix, videoDecodeNode, addVideoSave } from './comfyui-graph'
import { extraReferenceSlots, isQwenImageEditModel, referenceSide } from '../lib/edit-references'
import { canonicalImageRefs } from '../lib/image-ref-names'
import { nativeUpscaleScale, upscaleTarget, type UpscaleFactor } from '../lib/local-upscale'
import { WAN_FAST, findWanSpeedLora, isFastSampling, wanSamplingFor, wanSpeedKind, wanSpeedLoraNames } from '../lib/wan-speed'
import { addAudioStitch, addContextWindows, addContinueSource, addStitch, CONTINUE_NEEDS_UPDATE, type ContinueSource } from './video-continue'

// ─── Strategy Detection ───

export type WorkflowStrategy =
  | 'unet_flux'       // FLUX 1: UNETLoader + CLIPLoader + VAELoader + EmptySD3LatentImage
  | 'unet_flux2'      // FLUX 2: UNETLoader + CLIPLoader + VAELoader + EmptyFlux2LatentImage
  | 'unet_krea2'      // Krea 2: UNETLoader + CLIPLoader(type="krea2") + VAELoader + EmptyLatentImage (GH #136)
  | 'unet_zimage'     // Z-Image: UNETLoader + CLIPLoader(qwen_image) + VAELoader + EmptySD3LatentImage
  | 'unet_ernie_image' // ERNIE-Image: UNETLoader + CLIPLoader(flux2) + VAELoader + EmptyFlux2LatentImage + ConditioningZeroOut
  | 'unet_qwenimage'  // Qwen-Image 2.1: UNETLoader + CLIPLoader(qwen_image) + VAELoader + TextEncodeQwenImage21 (generate and edit)
  // The families below came in with the header sniff (Discord 2026-09-28).
  // Graphs follow the official Comfy-Org templates, see family-components.ts.
  | 'unet_qwenimage1' // Qwen-Image 1 / Edit: CLIPLoader(qwen_image, Qwen2.5-VL) + qwen_image_vae + AuraFlow shift 3.1 (edit: TextEncodeQwenImageEditPlus)
  | 'unet_chroma'     // Chroma: CLIPLoader(chroma, T5) + ae + AuraFlow shift 1
  | 'unet_hidream'    // HiDream I1: QuadrupleCLIPLoader + ae + ModelSamplingSD3
  | 'unet_sd3'        // SD 3.5: TripleCLIPLoader (or the checkpoint's own) + SD3 latent
  | 'unet_lumina2'    // Lumina 2: CLIPLoader(lumina2, Gemma 2 2B) + ae + AuraFlow shift 6 + system prompt
  | 'unet_sdxl'       // SDXL transformer in diffusion_models: DualCLIPLoader(sdxl) + sdxl_vae
  | 'unet_sd15'       // SD 1.5 unet in diffusion_models: CLIPLoader(stable_diffusion) + ft-mse VAE
  | 'unet_video'      // Wan/Hunyuan: UNETLoader + CLIPLoader + VAELoader + EmptyHunyuanLatentVideo
  | 'wan22'           // Wan 2.2 TI2V-5B: UNET + CLIP + Wan 2.2 VAE + Wan22ImageToVideoLatent (unified T2V/I2V)
  | 'unet_ltx'        // LTX Video: UNETLoader + CLIPLoader + EmptyLTXVLatentVideo
  | 'ltx25'           // LTX 2.5: two pass picture-and-sound graph (distilled), needs ComfyUI 0.32.0
  | 'unet_mochi'      // Mochi: UNETLoader + CLIPLoader + VAELoader + EmptyMochiLatentVideo
  | 'unet_cosmos'     // Cosmos: UNETLoader + CLIPLoader(oldt5) + VAELoader + EmptyCosmosLatentVideo
  | 'svd'             // SVD: ImageOnlyCheckpointLoader + SVD_img2vid_Conditioning
  | 'framepack'       // FramePack: Kijai wrapper + image input
  | 'minimaxh3'       // MiniMax H3: UNET + CLIPLoader(minimax) + video VAE + audio VAE, picture and sound in one pass
  // cogvideo / pyramidflow / allegro are gone on purpose (2026-07-24). Their
  // builders emitted node names no wrapper registers, so those model types now
  // resolve to 'unavailable' with an honest reason instead of a ComfyUI 400.
  | 'checkpoint'      // SDXL/SD1.5: CheckpointLoaderSimple + EmptyLatentImage
  | 'animatediff'     // AnimateDiff: CheckpointLoaderSimple + ADE_* nodes
  | 'unavailable'

interface StrategyResult {
  strategy: WorkflowStrategy
  reason: string
  /**
   * When `strategy === 'unavailable'` and the missing piece is an
   * installable custom-node pack, this hint tells the UI which one to
   * suggest. Surfaces in Create view as a clickable "open install guide"
   * link so users like a user (CogVideoX 1.5 5B → UNETLoader
   * mismatch on v2.4.3) get a clear next step instead of just a
   * blocking error. (Bug #6)
   */
  installHint?: { pack: string; url: string }
}

/** The sentence an older ComfyUI gets, per model (not global): the version is
 *  the release that brought the node the lane cannot run without. Read from the
 *  ComfyUI tags on 2026-10-02: LTX 2.5 in 0.32.0, FastH3's sparse attention in
 *  0.35.0, YuE2 in 0.36.0. "Update ComfyUI" in the text is what Create keys the
 *  one click update on (needsComfyUpdate). */
export const LTX25_NEEDS_UPDATE = 'LTX 2.5 needs ComfyUI 0.32.0 or newer. Update ComfyUI in Settings.'
/** A step distillation LoRA names its step count (minimax_h3_fl2v_turbo_8step_...). */
const H3_STEP_LORA = /turbo\D*?(\d+)\s*_?steps?/i
export const FASTH3_NEEDS_UPDATE = 'FastH3 needs ComfyUI 0.35.0 or newer. Update ComfyUI in Settings.'
export const YUE2_NEEDS_UPDATE = 'YuE2 needs ComfyUI 0.36.0 or newer. Update ComfyUI in Settings.'

export function determineStrategy(
  modelType: ModelType,
  isVideo: boolean,
  nodes: CategorizedNodes,
  models: AvailableModels,
): StrategyResult {
  const hasUNET = nodes.loaders.includes('UNETLoader')
  const hasCheckpoint = nodes.loaders.includes('CheckpointLoaderSimple')
  const hasCLIPLoader = nodes.loaders.includes('CLIPLoader')
  const hasVAELoader = nodes.loaders.includes('VAELoader')
  const hasAnimateDiff = nodes.motion.includes('ADE_LoadAnimateDiffModel')

  // ERNIE-Image → UNET + CLIPLoader(flux2) + VAE + Flux2LatentImage + ConditioningZeroOut
  if (modelType === 'ernie_image') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_ernie_image', reason: 'ERNIE-Image model → UNETLoader + CLIPLoader(flux2) + ConditioningZeroOut' }
    }
    return { strategy: 'unavailable', reason: 'ERNIE-Image requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Qwen-Image 2.1 → UNET + CLIPLoader(qwen_image) + VAE + TextEncodeQwenImage21.
  // One model, two graphs: without a reference image it generates, with one it
  // edits. Both official Comfy-Org templates route the prompt through
  // TextEncodeQwenImage21, so the lane needs that node either way. It arrived
  // in ComfyUI 0.37.0 (comfy_extras/nodes_qwen.py); an older install gets the
  // update sentence rather than a ComfyUI 400 on an unknown node class.
  if (modelType === 'qwenimage') {
    const hasQwen21Encode = nodes.textEncoders.includes('TextEncodeQwenImage21')
    if (hasUNET && hasCLIPLoader && hasVAELoader && hasQwen21Encode) {
      return { strategy: 'unet_qwenimage', reason: 'Qwen-Image 2.1 model → UNETLoader + CLIPLoader(qwen_image) + TextEncodeQwenImage21' }
    }
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return {
        strategy: 'unavailable',
        reason: 'Qwen-Image 2.1 needs ComfyUI 0.37.0 or newer. Update ComfyUI in Settings.',
      }
    }
    return { strategy: 'unavailable', reason: 'Qwen-Image 2.1 requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Z-Image → UNET + CLIPLoader(qwen_image) + VAE + SD3LatentImage
  if (modelType === 'zimage') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_zimage', reason: 'Z-Image model → UNETLoader + CLIPLoader(qwen_image)' }
    }
    return { strategy: 'unavailable', reason: 'Z-Image requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Header-sniffed families (Discord 2026-09-28). Their graphs are built in
  // one place further down; the loaders are checked there, per graph.
  const sniffed: Partial<Record<ModelType, WorkflowStrategy>> = {
    chroma: 'unet_chroma', hidream: 'unet_hidream', sd3: 'unet_sd3', lumina2: 'unet_lumina2', qwenimage1: 'unet_qwenimage1',
  }
  const sniffedStrategy = sniffed[modelType]
  if (sniffedStrategy) {
    if ((hasUNET || hasCheckpoint) && hasVAELoader) {
      return { strategy: sniffedStrategy, reason: `${modelType} → its own loader set (official Comfy-Org template)` }
    }
    return { strategy: 'unavailable', reason: `${modelType} needs UNETLoader and VAELoader. Update ComfyUI in Settings.` }
  }

  // FLUX 2 → UNET + Flux2LatentImage
  if (modelType === 'flux2') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_flux2', reason: 'FLUX 2 model → UNETLoader + EmptyFlux2LatentImage' }
    }
    return { strategy: 'unavailable', reason: 'FLUX 2 requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // FLUX 1 → UNET + SD3LatentImage
  if (modelType === 'flux') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_flux', reason: 'FLUX model → UNETLoader pipeline' }
    }
    return { strategy: 'unavailable', reason: 'FLUX requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Krea 2 (K9, GH #136) → UNET + CLIPLoader(type="krea2") + VAE + EmptyLatentImage
  if (modelType === 'krea2') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_krea2', reason: 'Krea 2 model → UNETLoader + CLIPLoader(krea2)' }
    }
    return { strategy: 'unavailable', reason: 'Krea 2 requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // LTX 2.5 → UNET + CLIPLoader(ltxv, Gemma 4) + both VAEs + the two pass graph
  // of the official templates. The model patch arrived in ComfyUI 0.32.0
  // together with LTXVDualCFGGuider (comfy_extras/nodes_lt.py, PR 15499), and
  // that node is the one this lane cannot run without, so its absence is the
  // version check: an older install gets the update sentence instead of a 400.
  if (modelType === 'ltx25') {
    const hasDual = nodes.samplers.includes('LTXVDualCFGGuider')
    if (hasUNET && hasCLIPLoader && hasVAELoader && hasDual) {
      return { strategy: 'ltx25', reason: 'LTX 2.5 → UNETLoader + CLIPLoader(ltxv) + LTXVDualCFGGuider (two pass, sound)' }
    }
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unavailable', reason: LTX25_NEEDS_UPDATE }
    }
    return { strategy: 'unavailable', reason: 'LTX 2.5 requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // LTX Video → UNET + LTXVLatentVideo (no separate VAE needed)
  if (modelType === 'ltx') {
    if (hasUNET && hasCLIPLoader) {
      return { strategy: 'unet_ltx', reason: 'LTX Video → UNETLoader + EmptyLTXVLatentVideo' }
    }
    return { strategy: 'unavailable', reason: 'LTX Video requires UNETLoader + CLIPLoader nodes' }
  }

  // MiniMax H3 → its own encode node, which also builds the joint
  // picture-and-sound latent. The nodes arrived with ComfyUI PR #15224, so an
  // older install gets the update sentence (fixable in place) instead of a 400.
  if (modelType === 'minimaxh3') {
    const hasH3 = nodes.latentInit.includes('MiniMaxH3ImageToVideo')
    if (hasUNET && hasCLIPLoader && hasVAELoader && hasH3) {
      return { strategy: 'minimaxh3', reason: 'MiniMax H3 → UNETLoader + CLIPLoader(minimax) + MiniMaxH3ImageToVideo' }
    }
    return { strategy: 'unavailable', reason: 'MiniMax H3 needs a newer ComfyUI. Update ComfyUI in Settings.' }
  }

  // Wan 2.2 TI2V-5B → UNET + CLIP + Wan 2.2 VAE + Wan22ImageToVideoLatent (T2V & I2V)
  if (modelType === 'wan22') {
    const hasWan22Latent = nodes.latentInit.includes('Wan22ImageToVideoLatent')
    if (hasUNET && hasCLIPLoader && hasVAELoader && hasWan22Latent) {
      return { strategy: 'wan22', reason: 'Wan 2.2 TI2V-5B → UNETLoader + Wan22ImageToVideoLatent (unified T2V/I2V)' }
    }
    return {
      strategy: 'unavailable',
      reason: 'Wan 2.2 TI2V-5B needs the Wan22ImageToVideoLatent node (ComfyUI ≥ v0.3.46). Update ComfyUI, then try again.',
    }
  }

  // Wan / Hunyuan → UNET-based with video latent
  if (modelType === 'wan' || modelType === 'hunyuan') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_video', reason: `${modelType} model → UNETLoader + video latent` }
    }
    return { strategy: 'unavailable', reason: 'Wan/Hunyuan requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Mochi → UNET + EmptyMochiLatentVideo (native)
  if (modelType === 'mochi') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_mochi', reason: 'Mochi → UNETLoader + EmptyMochiLatentVideo' }
    }
    return { strategy: 'unavailable', reason: 'Mochi requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Cosmos → UNET + EmptyCosmosLatentVideo (native, oldt5 encoder)
  if (modelType === 'cosmos') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_cosmos', reason: 'Cosmos → UNETLoader + EmptyCosmosLatentVideo (oldt5)' }
    }
    return { strategy: 'unavailable', reason: 'Cosmos requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // SVD → ImageOnlyCheckpointLoader (native, I2V)
  if (modelType === 'svd') {
    const hasIOCL = nodes.loaders.includes('ImageOnlyCheckpointLoader')
    if (hasIOCL) {
      return { strategy: 'svd', reason: 'SVD → ImageOnlyCheckpointLoader + SVD_img2vid_Conditioning' }
    }
    return { strategy: 'unavailable', reason: 'SVD requires ImageOnlyCheckpointLoader node' }
  }

  // CogVideoX → Kijai wrapper nodes.
  //
  // 2026-07-24 (D#88 "it says I'm missing custom nodes, but they
  // are there"): he was right. The gate looked for `CogVideoXSampler`, which has
  // never existed in kijai/ComfyUI-CogVideoXWrapper — the real class is
  // `CogVideoSampler` (verified against a real checkout; `git log -S` upstream
  // finds the X-name in no commit ever). So a perfect install always failed the
  // check and the user was told to go install what they already had.
  //
  // The gate deliberately STAYS closed rather than being pointed at the real
  // name, because buildCogVideoWorkflow below emits the same invented names
  // throughout (CogVideoXTextEncode / CogVideoXEmptyLatents / CogVideoXVAEDecode
  // — none real). Opening it would only trade this clear message for an opaque
  // ComfyUI 400. The lane needs a rebuild against the current wrapper plus a
  // real generate E2E; until then say so honestly instead of blaming the setup.
  if (modelType === 'cogvideo') {
    return {
      strategy: 'unavailable',
      reason: 'CogVideoX is not supported in this build yet. Its pipeline needs a rebuild against the current wrapper, so please pick another video model such as Wan, LTX or SVD for now.',
    }
  }

  // FramePack → Kijai wrapper nodes (I2V)
  if (modelType === 'framepack') {
    const hasFPNodes = nodes.samplers.includes('FramePackSampler')
    if (hasFPNodes) {
      return { strategy: 'framepack', reason: 'FramePack → Kijai wrapper pipeline (I2V)' }
    }
    return {
      strategy: 'unavailable',
      reason: 'FramePack needs the ComfyUI-FramePackWrapper custom nodes. Install via ComfyUI Manager (Manager → Install Custom Nodes → search "FramePackWrapper") or git clone the repo into ComfyUI/custom_nodes/.',
      installHint: { pack: 'ComfyUI-FramePackWrapper', url: 'https://github.com/kijai/ComfyUI-FramePackWrapper' },
    }
  }

  // Pyramid Flow → Kijai wrapper nodes.
  //
  // Closed for the same reason as CogVideoX above, found in the same 2026-07-24
  // audit. The gate itself was fine (PyramidFlowSampler is real), but
  // buildPyramidFlowWorkflow was written against a wrapper nobody checked:
  // the loader is registered as PyramidFlowTransformerLoader, decode is
  // PyramidFlowVAEDecode and wants a vae input we never wired, the text encoder
  // takes clip plus positive_prompt plus negative_prompt rather than a bare
  // `text`, and the sampler consumes prompt_embeds plus per stage step strings
  // instead of steps and frames. So a correct install got a 400 with no clue
  // why. Same deal as CogVideoX: reopen only with a rebuilt builder and a real
  // generate behind it.
  if (modelType === 'pyramidflow') {
    return {
      strategy: 'unavailable',
      reason: 'Pyramid Flow is not supported in this build yet. Its pipeline needs a rebuild against the current wrapper, so please pick another video model such as Wan, LTX or SVD for now.',
    }
  }

  // Allegro → Community wrapper nodes.
  //
  // Also closed in the 2026-07-24 audit. Every other wrapper lane in this file
  // that was never run turned out to emit invented node names, and Allegro is
  // the one we cannot check: the wrapper it points at is a single community
  // repo we have never had installed, its bundle was already pulled from the
  // catalogue for being diffusers-only, and the builder follows the exact
  // Loader/TextEncode/Sampler/Decoder shape that was wrong in both other cases.
  // Unverifiable plus unreachable through the catalogue means it stays shut
  // rather than shipping a third guess.
  if (modelType === 'allegro') {
    return {
      strategy: 'unavailable',
      reason: 'Allegro is not supported in this build. Please pick another video model such as Wan, LTX or SVD.',
    }
  }

  // SDXL / SD1.5 / Unknown
  if (isVideo && hasAnimateDiff && hasCheckpoint && models.motionModels.length > 0) {
    return { strategy: 'animatediff', reason: 'Video mode → AnimateDiff pipeline' }
  }

  if (hasCheckpoint) {
    return { strategy: 'checkpoint', reason: 'Checkpoint-based pipeline' }
  }

  // K9: this used to fall back to 'unet_flux' whenever CheckpointLoaderSimple
  // was missing (rare, it is a core node, present on virtually every real
  // install), on the unstated assumption that any UNET-only file must be a
  // FLUX model. For a genuinely unrecognized architecture that is a silent
  // guess: it picks FLUX's CLIP type and VAE match patterns for a model that
  // may not be FLUX at all, which either fails confusingly or "succeeds"
  // with a wrong text encoder. classifyModel returning 'unknown' means LU
  // could not name this model's architecture, so say so honestly instead of
  // routing it through a guessed pipeline. A real architecture (Krea 2,
  // FLUX 2, Z-Image, ...) has its own branch above and never reaches here.
  if (hasUNET && hasCLIPLoader && hasVAELoader) {
    return {
      strategy: 'unavailable',
      reason: `LU could not determine this model's architecture, so it will not guess a ComfyUI pipeline for it. If this is a known model family, please report it so LU can recognize it.`,
    }
  }

  return { strategy: 'unavailable', reason: 'No compatible loader nodes found in ComfyUI' }
}

// ─── Dynamic Workflow Builder ───

/**
 * Custom Error thrown by `buildDynamicWorkflow` when the active ComfyUI
 * lacks the loader nodes for the chosen model architecture (Bug #6:
 * CogVideoX 1.5 / LTX / FramePack require Kijai wrapper nodes that aren't
 * in ComfyUI core). UI can read `.installHint` to render a one-click
 * "open install guide" link instead of just blocking the user.
 */
export class WorkflowUnavailableError extends Error {
  readonly strategy: WorkflowStrategy
  readonly installHint?: { pack: string; url: string }
  /** Companion files LU can download itself; Create offers them in place. */
  readonly missing?: ComponentSpec[]
  /** The local ComfyUI is too old for this graph; Create offers the update. */
  readonly needsComfyUpdate?: boolean
  constructor(
    message: string,
    strategy: WorkflowStrategy,
    installHint?: { pack: string; url: string },
    extra?: { missing?: ComponentSpec[]; needsComfyUpdate?: boolean },
  ) {
    super(message)
    this.name = 'WorkflowUnavailableError'
    this.strategy = strategy
    this.installHint = installHint
    this.missing = extra?.missing
    this.needsComfyUpdate = extra?.needsComfyUpdate
  }
}

/** The families built from family-components.ts, by strategy. */
const SNIFFED_FAMILY: Partial<Record<WorkflowStrategy, SniffedFamily>> = {
  unet_chroma: 'chroma', unet_hidream: 'hidream', unet_sd3: 'sd3', unet_lumina2: 'lumina2',
  unet_qwenimage1: 'qwenimage1', unet_sdxl: 'sdxl_unet', unet_sd15: 'sd15_unet',
}

/** Latent spaces that start from EmptySD3LatentImage (16 channels). */
const SD3_LATENT_STRATEGIES = new Set<WorkflowStrategy>(['unet_chroma', 'unet_hidream', 'unet_sd3', 'unet_lumina2', 'unet_qwenimage1'])

/** Verbatim from comfy_extras/nodes_lumina2.py (SYSTEM_PROMPT["superior"]) and
 *  the negative of the NetaYume Lumina template. */
const LUMINA2_POSITIVE_SYSTEM = 'You are an assistant designed to generate superior images with the superior degree of image-text alignment based on textual prompts or user prompts.'
const LUMINA2_NEGATIVE_SYSTEM = 'You are an assistant designed to generate low-quality images based on textual prompts'

/** A resolver's "download X" message, turned into the registry spec that can
 *  fetch X, so Create can offer it instead of pointing at the Model Manager. */
function registrySpecsNamedIn(type: ModelType, message: string): ComponentSpec[] {
  const req = COMPONENT_REGISTRY[type]
  if (!req) return []
  return [req.vae, req.clip, req.clipSecondary, req.audioVae, req.upscaler].filter(
    (s): s is ComponentSpec => !!s?.downloadUrl && message.includes(s.downloadFilename),
  )
}

/**
 * Probe ComfyUI for the video output node we need. When neither VHS nor
 * SaveAnimatedWEBP is present, the workflow will fall back to SaveImage
 * (single frames on disk) — a user's "videos generate as
 * .webp" was caused by VHS missing while SaveAnimatedWEBP still produced
 * an animated still. UI calls this BEFORE Generate so users see a banner
 * rather than discovering after the fact.
 */
export async function checkVideoOutputCapability(): Promise<{ mp4Capable: boolean; webpOnly: boolean; missingNodes: string[] }> {
  const allNodes = await getAllNodeInfo()
  const cats = categorizeNodes(allNodes)
  // The core's CreateVideo + SaveVideo write mp4 on their own (A19), so VHS is
  // only missing when the core can't do it either.
  const hasCoreMp4 = cats.videoSavers.includes('CreateVideo') && cats.videoSavers.includes('SaveVideo')
  const hasVHS = cats.videoSavers.includes('VHS_VideoCombine')
  const hasWebp = cats.videoSavers.includes('SaveAnimatedWEBP')
  const mp4Capable = hasCoreMp4 || hasVHS
  const missing: string[] = []
  if (!mp4Capable) missing.push('VHS_VideoCombine (ComfyUI-VideoHelperSuite)')
  return {
    mp4Capable,
    webpOnly: !mp4Capable && hasWebp,
    missingNodes: missing,
  }
}

/** Multi-LoRA (a user 2026-06-09) — normalize the `lora` param into an
 *  ordered list. Accepts a single filename, an array, or a comma/semicolon-
 *  joined string (the most common LLM shape for "use lora A and lora B" —
 *  exactly the failing case where the joined string used to reach ComfyUI
 *  verbatim and die with an opaque "Value not in list"). */
export function normalizeLoraList(lora: string | string[] | undefined): string[] {
  if (!lora) return []
  const arr = Array.isArray(lora) ? lora : lora.split(/[,;]+/)
  return arr.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
}

/** One strength per LoRA: a single number applies to all, an array maps by
 *  index (missing/invalid entries fall back to 0.8). No range clamp — the
 *  LoraLoader node itself owns its real min/max (no magic numbers here);
 *  only non-finite garbage is replaced. */
export function normalizeLoraStrengths(
  strength: number | number[] | undefined,
  count: number,
): number[] {
  const fallback = 0.8
  const sane = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  if (typeof strength === 'number') return Array(count).fill(sane(strength))
  if (Array.isArray(strength)) return Array.from({ length: count }, (_, i) => sane(strength[i]))
  return Array(count).fill(fallback)
}

/** Resolve requested LoRA names against ComfyUI's installed LoraLoader enum.
 *  Per name: exact → normalized (case/extension/path-separator insensitive)
 *  → basename → unique substring. A miss throws an actionable error listing
 *  what IS installed (same pattern as the Fix-C encoder hint) instead of
 *  letting ComfyUI reject the whole workflow with "Value not in list". */
export function resolveLoraNames(requested: string[], installed: string[]): string[] {
  return requested.map((req) => {
    const hit = resolveLoaderName(req, installed)
    if (!hit) {
      const list = installed.length ? installed.slice(0, 12).join(', ') : '(none installed)'
      throw new Error(
        `LoRA "${req}" is not installed in ComfyUI. Installed LoRAs: ${list}. ` +
        `Put the .safetensors file into ComfyUI/models/loras and retry, or drop the lora setting.`,
      )
    }
    return hit
  })
}

/**
 * Normalize a remembered loader value (path separator, case, an optional
 * subfolder prefix) against ComfyUI's live enum for that loader, WITHOUT the
 * loose substring tier resolveLoaderName uses for LoRA names below. That
 * tier is right for a LoRA name an LLM paraphrased ("pixel art" for
 * "pixel-art-xl.safetensors") but wrong here: a short live entry like
 * "ae.safetensors" is a substring of almost anything ending in those two
 * letters, so "old-2.6.9-remembered-vae.safetensors" would falsely resolve
 * to it. K2 (review-create.md Punkt 3) only needs cosmetic drift covered
 * (separator, case, subfolder prefix), never a guess at a DIFFERENT file.
 */
function normalizeLoaderValue(req: string, installed: string[]): string | null {
  if (installed.includes(req)) return req
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/')
  const rq = norm(req)
  const exact = installed.filter((c) => norm(c) === rq)
  if (exact.length === 1) return exact[0]
  const rqBase = rq.split('/').pop() || rq
  const byBase = installed.filter((c) => (norm(c).split('/').pop() || '') === rqBase)
  if (byBase.length === 1) return byBase[0]
  return null
}

/**
 * Fuzzy-match a remembered LoRA name (file name, path separator and case
 * left unspecified, or paraphrased by an LLM) against ComfyUI's live enum.
 */
function resolveLoaderName(req: string, installed: string[]): string | null {
  if (installed.includes(req)) return req
  const norm = (s: string) =>
    s.toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '').replace(/\\/g, '/')
  // Separator-insensitive form: users/LLMs say "pixel art" for
  // "pixel-art-xl.safetensors" — spaces, dashes and underscores all collapse.
  const loose = (s: string) => norm(s).replace(/[-_\s]+/g, '')
  const rq = norm(req)
  let hits = installed.filter((c) => norm(c) === rq)
  if (hits.length === 1) return hits[0]
  // Enum entries can be "subfolder/name.safetensors": try basename equality.
  const rqBase = rq.split('/').pop() || rq
  hits = installed.filter((c) => (norm(c).split('/').pop() || '') === rqBase)
  if (hits.length === 1) return hits[0]
  // Unique substring either way round (separator-insensitive).
  const rqLoose = loose(req)
  hits = installed.filter((c) => loose(c).includes(rqLoose) || rqLoose.includes(loose(c)))
  if (hits.length === 1) return hits[0]
  return null
}

/**
 * The `resolution` widget of TextEncodeQwenImage21, for an edit.
 *
 * It is not a width. The node reads it as a total pixel budget per reference
 * image, resizes each one to about `resolution x resolution` pixels at
 * multiples of 32 and keeps its aspect ratio, and the result follows the first
 * reference. So the requested canvas is folded into a single side length and
 * the edit comes back in the shape of the source at the size the user picked.
 * At the default 1024x1024 this is exactly 1024, the node's own default.
 *
 * Not 0 (the official template's value, meaning "keep the original size"):
 * a phone photo is 12 megapixels, far past the model's 2K class, and it would
 * be handed straight to the sampler. Clamped to the node's declared range
 * (0 to 4096, step 32), with 32 as the floor so a tiny canvas cannot produce
 * a zero that would silently switch the node back to original size.
 */
export function qwenEditResolution(width: number, height: number): number {
  const px = (v: number) => (Number.isFinite(v) && v > 0 ? v : 1024)
  const side = Math.sqrt(px(width) * px(height))
  return Math.min(4096, Math.max(32, Math.round(side / 32) * 32))
}

export async function buildDynamicWorkflow(
  params: GenerateParams | VideoParams,
  modelType?: ModelType,
): Promise<ComfyApiGraph> {
  const type = modelType || classifyModel(params.model)
  const isVideo = 'frames' in params
  const videoParams = params as VideoParams

  // Fetch node info (cached)
  const allNodes = await getAllNodeInfo()
  const nodes = categorizeNodes(allNodes)
  const models = detectAvailableModels(allNodes)

  // ─── Background removal (RMBG cutout) ───
  // A cutout needs no diffusion model, so branch out before strategy detection.
  // ComfyUI-RMBG (node class "RMBG"): LoadImage → RMBG → SaveImage. We read the
  // node's REAL input schema live and default every widget from it, so we never
  // hard-code an enum spelling a future RMBG version could reject with a ComfyUI
  // 400 ("Value not in list"). Gated upstream by caps.rmbg.
  const gp = params as GenerateParams
  if (!isVideo && gp.removebg && gp.inputImage) {
    const rmbgMeta = allNodes['RMBG']
    if (!rmbgMeta) {
      throw new WorkflowUnavailableError(
        'The background-removal node (ComfyUI-RMBG) is not installed in ComfyUI. Install it from the Remove Background tab, then try again.',
        'unavailable',
        { pack: 'ComfyUI-RMBG', url: 'https://github.com/1038lab/ComfyUI-RMBG' },
      )
    }
    return buildRemoveBgWorkflow(gp, rmbgMeta)
  }

  // ─── Reference to video (Animate with a Ref2V model, D24) ───
  // Before the strategy table: VACE has no entry there (it is a Motion lane
  // family), and Phantom/MAGREF classify as plain Wan, whose i2v override
  // would feed the picture to WanImageToVideo as a first frame. Without a
  // picture Phantom and MAGREF stay the text to video runs they always were;
  // VACE has no such run in LU.
  const refFamily = isVideo ? ref2vFamily(params.model) : null
  if (refFamily && (videoParams.inputImage || refFamily === 'vace')) {
    const refusal = ref2vRefusal(params.model)
    if (refusal) throw new WorkflowUnavailableError(refusal, 'unavailable')
    if (!videoParams.inputImage) {
      throw new WorkflowUnavailableError('This reference model needs a picture to work from. Use it on the Animate tab and add the image there.', 'unavailable')
    }
    try {
      return await buildVaceReferenceWorkflow(videoParams, resolveRunSeed(params.seed), nodes, allNodes)
    } catch (err) {
      if (!(err instanceof Error) || err instanceof WorkflowUnavailableError) throw err
      throw new WorkflowUnavailableError(err.message, 'unet_video', undefined, { missing: registrySpecsNamedIn('wan', err.message) })
    }
  }

  const determined = determineStrategy(type, isVideo, nodes, models)
  const { reason, installHint } = determined
  let strategy = determined.strategy
  log.info(`[dynamic-workflow] Strategy: ${strategy} (${reason})`)

  if (strategy === 'unavailable') {
    // "Update ComfyUI" reasons are fixable in place (lib/render-fixups.ts).
    throw new WorkflowUnavailableError(reason, strategy, installHint, { needsComfyUpdate: /update comfyui/i.test(reason) })
  }

  // The loader follows the FOLDER the file sits in, not what its family
  // usually ships as (Discord 2026-09-28). CheckpointLoaderSimple only lists
  // models/checkpoints, UNETLoader only diffusion_models/unet, and a name in
  // the wrong one is ComfyUI's "Value not in list".
  const listedCheckpoints = nodeComboOptions(allNodes, 'CheckpointLoaderSimple', 'ckpt_name')
  const listedUnets = [
    ...nodeComboOptions(allNodes, 'UNETLoader', 'unet_name'),
    ...nodeComboOptions(allNodes, 'UnetLoaderGGUF', 'unet_name'),
  ]
  const inCheckpoints = listedCheckpoints.includes(params.model)
  const inUnets = listedUnets.includes(params.model)
  if (strategy === 'checkpoint' && !inCheckpoints && inUnets && (type === 'sdxl' || type === 'sd15')) {
    // A bare SDXL / SD 1.5 unet: its text encoders and VAE come separately.
    strategy = type === 'sdxl' ? 'unet_sdxl' : 'unet_sd15'
  }
  // An all-in-one file of a UNET family in models/checkpoints (the FLUX fp8
  // and SD 3.5 checkpoints, NetaYume Lumina, CivitAI merges): MODEL comes from
  // CheckpointLoaderSimple, and its own CLIP/VAE when it carries them.
  const fromCheckpoint = strategy !== 'checkpoint' && strategy !== 'animatediff'
    && listedCheckpoints.length > 0 && inCheckpoints && !inUnets

  // Local Edit (mask inpaint) runs on the SDXL/SD1.5 checkpoint pipeline only.
  // Reject other strategies explicitly instead of silently dropping the mask —
  // the pre-2.5.7 behavior was exactly that: a masked edit fell through to
  // plain img2img and repainted the WHOLE image.
  //
  // Qwen-Image 2.1 stays behind this gate on purpose, although the model
  // itself can do local edits. TextEncodeQwenImage21 takes no mask input at
  // all (see its schema: clip, prompt, negative_prompt, vae, resolution and
  // the image slots), so a painted mask would be dropped exactly the way this
  // check exists to prevent. The model's own route for a local change is a
  // marking drawn into the picture plus a prompt that names it, which is a
  // different surface from the mask editor and is not built in this cut.
  const sdCheckpointFamily = strategy === 'checkpoint' || strategy === 'unet_sdxl' || strategy === 'unet_sd15'
  if (!isVideo && gp.inputImage && gp.maskImage && !sdCheckpointFamily) {
    throw new WorkflowUnavailableError(
      'Local image editing needs an SD 1.5 / SDXL checkpoint. Pick a checkpoint model for Edit. FLUX and video models are not wired for local inpaint.',
      strategy,
    )
  }

  const seed = resolveRunSeed(params.seed)

  // ─── Wrapper Strategies (custom node pipelines — completely different node chains) ───

  // A wrapper builder looks up its own encoder and VAEs. A file it cannot
  // find has to reach Create as that sentence plus its download, never as a
  // reason to try the old checkpoint graph (Discord 2026-09-29 and 10-01:
  // "CheckpointLoaderSimple: Value not in list" for MiniMax H3).
  const wrapper = async (build: () => Promise<ComfyApiGraph> | ComfyApiGraph) => {
    try {
      return await build()
    } catch (err) {
      if (!(err instanceof Error) || err instanceof WorkflowUnavailableError) throw err
      throw new WorkflowUnavailableError(err.message, strategy, undefined, { missing: registrySpecsNamedIn(type, err.message) })
    }
  }
  if (strategy === 'svd') {
    return wrapper(() => buildSVDWorkflow(params as VideoParams, seed, nodes))
  }
  if (strategy === 'wan22') {
    return wrapper(() => buildWan22Workflow(params as VideoParams, seed, nodes, allNodes))
  }
  if (strategy === 'framepack') {
    return wrapper(() => buildFramePackWorkflow(params as VideoParams, seed, nodes))
  }
  if (strategy === 'minimaxh3') {
    return wrapper(() => buildMiniMaxH3Workflow(params as VideoParams, seed, allNodes))
  }
  if (strategy === 'ltx25') {
    return wrapper(() => buildLtx25Workflow(params as VideoParams, seed, allNodes))
  }

  // ─── Standard Strategies (UNET/Checkpoint → CLIP → Latent → KSampler → VAEDecode) ───

  const workflow: ComfyApiGraph = {}
  let n = 1 // node counter

  // ─── Phase 1: Model Loading ───

  let modelNodeId: string
  let clipSourceId: string
  let clipOutputSlot: number
  let vaeSourceId: string
  let vaeOutputSlot: number
  let samplerModelId: string

  if (strategy === 'checkpoint') {
    assertCheckpointListed(params.model, allNodes)
    // Single loader: outputs MODEL (0), CLIP (1), VAE (2)
    modelNodeId = String(n++)
    workflow[modelNodeId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    }
    clipSourceId = modelNodeId
    clipOutputSlot = 1
    vaeSourceId = modelNodeId
    vaeOutputSlot = 2
    samplerModelId = modelNodeId

  } else if (SNIFFED_FAMILY[strategy]) {
    // ─── Header-sniffed families (Discord 2026-09-28) ───
    const family = SNIFFED_FAMILY[strategy]!
    const modelId = String(n++)
    const clipId = String(n++)
    if (fromCheckpoint) {
      workflow[modelId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } }
    } else {
      addUnetLoader(workflow, modelId, params.model, allNodes)
    }
    // An all-in-one checkpoint brings its own encoder / VAE. Known from the
    // header; when the header was not readable, the separate files are tried
    // first and the checkpoint's own outputs are the fallback.
    const parts = gp.modelParts
    const ownClip = fromCheckpoint && !!parts?.textEncoder
    const ownVae = fromCheckpoint && !!parts?.vae
    let resolved: { encoders: string[]; vae?: string }
    try {
      resolved = resolveFamilyParts(family, models.clips, models.vaes, { encoders: !ownClip, vae: !ownVae })
    } catch (err) {
      if (!(err instanceof MissingComponentsError)) throw err
      if (fromCheckpoint && !parts) {
        resolved = { encoders: [], vae: undefined }
      } else {
        throw new WorkflowUnavailableError(err.message, strategy, undefined, { missing: err.missing })
      }
    }
    const useOwnClip = ownClip || (fromCheckpoint && resolved.encoders.length === 0)
    const useOwnVae = ownVae || (fromCheckpoint && !resolved.vae)

    if (!useOwnClip) {
      const [e1, e2, e3, e4] = resolved.encoders
      const clipNode: { class_type: string; inputs: ComfyNodeInputs } =
        family === 'hidream' ? { class_type: 'QuadrupleCLIPLoader', inputs: { clip_name1: e1, clip_name2: e2, clip_name3: e3, clip_name4: e4 } }
        : family === 'sd3' ? { class_type: 'TripleCLIPLoader', inputs: { clip_name1: e1, clip_name2: e2, clip_name3: e3 } }
        : family === 'sdxl_unet' ? { class_type: 'DualCLIPLoader', inputs: { clip_name1: e1, clip_name2: e2, type: 'sdxl' } }
        : {
            class_type: 'CLIPLoader',
            inputs: {
              clip_name: e1,
              type: family === 'chroma' ? 'chroma' : family === 'lumina2' ? 'lumina2' : family === 'qwenimage1' ? 'qwen_image' : 'stable_diffusion',
              device: 'default',
            },
          }
      if (!allNodes[clipNode.class_type]) {
        throw new WorkflowUnavailableError(
          `Your ComfyUI is too old for this model (it has no ${clipNode.class_type} node). Update ComfyUI, then try again.`,
          strategy, undefined, { needsComfyUpdate: true },
        )
      }
      if (clipNode.class_type === 'CLIPLoader') assertClipTypeKnown(String(clipNode.inputs.type), type, strategy, allNodes)
      workflow[clipId] = clipNode
      clipSourceId = clipId
      clipOutputSlot = 0
    } else {
      clipSourceId = modelId
      clipOutputSlot = 1
    }
    if (!useOwnVae) {
      const vaeId = String(n++)
      workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: resolved.vae! } }
      vaeSourceId = vaeId
      vaeOutputSlot = 0
    } else {
      vaeSourceId = modelId
      vaeOutputSlot = 2
    }
    modelNodeId = modelId
    samplerModelId = modelId

  } else if (strategy === 'unet_flux' || strategy === 'unet_flux2' || strategy === 'unet_krea2' || strategy === 'unet_zimage' || strategy === 'unet_ernie_image' || strategy === 'unet_qwenimage' || strategy === 'unet_video' || strategy === 'unet_ltx'
    || strategy === 'unet_mochi' || strategy === 'unet_cosmos') {
    // Separate loaders
    const unetId = String(n++)
    const clipId = String(n++)

    const clipType = type === 'zimage' ? 'qwen_image'
      // Verbatim from the official templates: CLIPLoader type stays
      // 'qwen_image' for Qwen-Image 2.1, the same widget value Z-Image uses.
      : type === 'qwenimage' ? 'qwen_image'
      : type === 'ernie_image' ? 'flux2'
      : type === 'flux2' ? 'flux2'
      : type === 'krea2' ? 'krea2'
      : type === 'flux' ? 'flux'
      : type === 'ltx' ? 'ltxv'
      : (type === 'wan' || type === 'hunyuan') ? 'wan'
      : type === 'mochi' ? 'mochi'
      : type === 'cosmos' ? 'cosmos'
      : 'flux'

    // Resolve the text encoder from the LIVE ComfyUI node enum. CRITICAL
    // (Bug C / a user "CLIPLoader: Value not in list"): do NOT silently fall
    // back to models.clips[0] / '' on a miss — an empty or wrong clip_name makes
    // ComfyUI reject the prompt with that exact cryptic error. The resolvers
    // throw actionable "download <encoder>" messages; propagate them as a
    // WorkflowUnavailableError so the user gets the download hint instead of a
    // raw rejection. Pass the active UNet filename so the resolver prefers the
    // matching quant tier (fp4 model → fp4 encoder; fp8/bf16 → full precision).
    //
    // C2 (a user follow-up, v2.5.3 fix #5): modern ComfyUI (v0.12.0 confirmed)
    // removed 'flux' from the single CLIPLoader's type enum — FLUX v1 text
    // encoding lives in DualCLIPLoader (clip_name1 = T5-XXL, clip_name2 =
    // CLIP-L, type 'flux'), which has shipped with every FLUX-era ComfyUI.
    // Emit it whenever the instance has the node; the single-CLIPLoader path
    // stays as the fallback for pre-FLUX-era instances (whose CLIPLoader enum
    // still contains 'flux'). Same pattern as the HunyuanVideo DualCLIPLoader
    // below.
    const useDualFluxClip = type === 'flux' && nodes.loaders.includes('DualCLIPLoader')

    // An all-in-one file in models/checkpoints (see fromCheckpoint): its own
    // encoder / VAE are used when the header says it carries them, and are the
    // fallback when the header could not be read.
    const parts = gp.modelParts
    const carriesClip = fromCheckpoint && (parts ? parts.textEncoder : true)
    const carriesVae = fromCheckpoint && (parts ? parts.vae : true)
    const skipClipLookup = fromCheckpoint && !!parts?.textEncoder

    let clip = ''
    let fluxPair: { t5: string; clipL: string } | null = null
    if (skipClipLookup) {
      // nothing to look up
    } else if (useDualFluxClip) {
      try {
        fluxPair = await findFluxCLIPPair()
      } catch (clipErr) {
        if (!carriesClip) {
          const message = clipErr instanceof Error ? clipErr.message : 'Required text encoder not found in ComfyUI.'
          throw new WorkflowUnavailableError(message, strategy, undefined, { missing: registrySpecsNamedIn(type, message) })
        }
        clip = ''
      }
    } else {
      try {
        clip = await findMatchingCLIP(type, params.model, params.qwenTextEncoder)
      } catch (clipErr) {
        if (!carriesClip) {
          const message = clipErr instanceof Error ? clipErr.message : 'Required text encoder not found in ComfyUI.'
          throw new WorkflowUnavailableError(message, strategy, undefined, { missing: registrySpecsNamedIn(type, message) })
        }
        clip = ''
      }
    }

    // VAE is only loaded for strategies with a separate VAELoader — LTX bakes it
    // into the pipeline, so a missing VAE there is fine. Validate (same
    // no-silent-fallback rule) only when it will actually be used.
    const needsVAELoader = strategy !== 'unet_ltx'
    let vae = ''
    if (needsVAELoader && !(fromCheckpoint && parts?.vae)) {
      try {
        vae = await findMatchingVAE(type)
      } catch (vaeErr) {
        if (!carriesVae) {
          const message = vaeErr instanceof Error ? vaeErr.message : 'Required VAE not found in ComfyUI.'
          throw new WorkflowUnavailableError(message, strategy, undefined, { missing: registrySpecsNamedIn(type, message) })
        }
      }
    }
    const clipFromFile = !clip && !fluxPair
    const vaeFromFile = needsVAELoader && !vae

    if (!useDualFluxClip && !clipFromFile) assertClipTypeKnown(clipType, type, strategy, allNodes)
    if (fromCheckpoint) {
      workflow[unetId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } }
    } else {
      addUnetLoader(workflow, unetId, params.model, allNodes)
    }
    if (!clipFromFile) workflow[clipId] = useDualFluxClip && fluxPair
      ? {
          class_type: 'DualCLIPLoader',
          inputs: { clip_name1: fluxPair.t5, clip_name2: fluxPair.clipL, type: 'flux' },
        }
      : {
          class_type: 'CLIPLoader',
          inputs: { clip_name: clip, type: clipType, device: 'default' },
        }

    let vaeId: string
    if (needsVAELoader && !vaeFromFile) {
      vaeId = String(n++)
      workflow[vaeId] = {
        class_type: 'VAELoader',
        inputs: { vae_name: vae },
      }
    } else {
      vaeId = unetId // fallback reference (won't be used for LTX)
    }

    modelNodeId = unetId
    clipSourceId = clipFromFile ? unetId : clipId
    clipOutputSlot = clipFromFile ? 1 : 0
    vaeSourceId = vaeId
    vaeOutputSlot = vaeFromFile ? 2 : 0
    samplerModelId = unetId

  } else {
    // AnimateDiff: checkpoint + motion model
    const ckptId = String(n++)
    const motionLoadId = String(n++)
    const motionApplyId = String(n++)
    const evolvedId = String(n++)

    workflow[ckptId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    }
    workflow[motionLoadId] = {
      class_type: 'ADE_LoadAnimateDiffModel',
      inputs: { model_name: models.motionModels[0] },
    }
    workflow[motionApplyId] = {
      class_type: 'ADE_ApplyAnimateDiffModelSimple',
      inputs: { motion_model: [motionLoadId, 0] },
    }
    workflow[evolvedId] = {
      class_type: 'ADE_UseEvolvedSampling',
      inputs: {
        model: [ckptId, 0],
        m_models: [motionApplyId, 0],
        beta_schedule: 'autoselect',
      },
    }

    modelNodeId = ckptId
    clipSourceId = ckptId
    clipOutputSlot = 1
    vaeSourceId = ckptId
    vaeOutputSlot = 2
    samplerModelId = evolvedId
  }

  // ─── Phase 1b: Optional LoRA chain + VAE + Skip-CLIP injection (F2 + F3) ───
  //
  // LoRA chain (GH#4; multi-LoRA 2026-06-09): each
  // LoraLoader takes (model, clip) and outputs new (model, clip) — chaining
  // N loaders applies the LoRAs in order, exactly like stacking them in the
  // ComfyUI graph editor. We rewire both refs after every link so the rest
  // of the pipeline sees the fully-stacked versions. Names are resolved
  // against ComfyUI's real LoraLoader enum (fuzzy: extension/case optional)
  // and a miss throws an actionable error instead of ComfyUI's opaque
  // "Value not in list".
  //
  // VAE override (GH#4): VAELoader replaces vaeSourceId. The
  // checkpoint's bundled VAE stays unused.
  //
  // Skip CLIP (GH#4): CLIPSetLastLayer takes a negative
  // `stop_at_clip_layer` index — passing -clipSkip mirrors A1111 /
  // ComfyUI conventions.
  //
  // All three are skipped (no extra nodes) when the corresponding
  // param is unset, so workflows without F2/F3 enabled stay byte-
  // identical to the previous behaviour.
  const loraNames = normalizeLoraList(params.lora)
  if (loraNames.length > 0) {
    const installed: string[] =
      readComboOptions(allNodes?.LoraLoader?.input?.required?.lora_name) ?? []
    const resolved = resolveLoraNames(loraNames, installed)
    const strengths = normalizeLoraStrengths(params.loraStrength, resolved.length)
    resolved.forEach((loraName, i) => {
      const loraId = String(n++)
      workflow[loraId] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: loraName,
          strength_model: strengths[i],
          strength_clip: strengths[i],
          model: [samplerModelId, 0],
          clip: [clipSourceId, clipOutputSlot],
        },
      }
      samplerModelId = loraId
      clipSourceId = loraId
      clipOutputSlot = 1
    })
  }

  if (params.vae && params.vae !== 'auto') {
    // K2: this override used to go straight into VAELoader unchecked, so a
    // stale remembered pick (a name that existed in an older LU/ComfyUI
    // install, a wrong path separator, a subfolder-qualified name ComfyUI's
    // enum does not use) reached /prompt as-is and came back "Value not in
    // list". `models.vaes` is the live VAELoader enum already read off this
    // same /object_info response, validate against it before writing the
    // node. Skip the check only when that enum came back empty (an older
    // ComfyUI that answered a different schema): saying nothing is safer
    // than a false rejection of a value we simply could not verify.
    //
    // K2 (review-create.md nachbessert, Punkt 3): a straight `includes()`
    // rejected an installed file for a purely cosmetic mismatch (backslash
    // vs slash, a leftover subfolder prefix, different case) even though
    // ComfyUI would have accepted the LIVE spelling just fine. Normalize
    // first via normalizeLoaderValue; on a hit, write the LIVE enum's own
    // spelling to the node, not the remembered one, and only throw on a
    // genuine miss.
    let vaeName = params.vae
    if (models.vaes.length > 0 && !models.vaes.includes(vaeName)) {
      const resolved = normalizeLoaderValue(vaeName, models.vaes)
      if (resolved) {
        vaeName = resolved
      } else {
        const list = models.vaes.slice(0, 12).join(', ')
        throw new WorkflowUnavailableError(
          `VAE "${params.vae}" is not installed in ComfyUI. Installed VAEs: ${list}. ` +
          `Put the file into ComfyUI/models/vae and retry, or clear the VAE override.`,
          strategy,
        )
      }
    }
    const vaeId = String(n++)
    workflow[vaeId] = {
      class_type: 'VAELoader',
      inputs: { vae_name: vaeName },
    }
    vaeSourceId = vaeId
    vaeOutputSlot = 0
  }

  if (params.clipSkip && params.clipSkip > 0) {
    const skipId = String(n++)
    workflow[skipId] = {
      class_type: 'CLIPSetLastLayer',
      inputs: {
        stop_at_clip_layer: -Math.abs(params.clipSkip),
        clip: [clipSourceId, clipOutputSlot],
      },
    }
    clipSourceId = skipId
    clipOutputSlot = 0
  }

  // ─── Phase 2: Text Encoding ───

  // Qwen-Image 2.1 edit: the reference image belongs to the text encoder
  // (TextEncodeQwenImage21 sees it AND splices it in as VAE reference
  // latents), not to a VAEEncode latent. Decided here, BEFORE the generic
  // isI2I test in Phase 3, which would otherwise claim the image and turn an
  // edit instruction into ordinary latent img2img.
  const isQwenEdit = !isVideo && strategy === 'unet_qwenimage' && !!gp.inputImage
  // Qwen-Image-Edit 2509/2511 (official template image_qwen_image_edit_2509):
  // the source goes through TextEncodeQwenImageEditPlus on both sides and is
  // the latent itself, sampled at denoise 1.0 like the template.
  const isQwen1Edit = !isVideo && strategy === 'unet_qwenimage1' && !!gp.inputImage && isQwenImageEditModel(params.model)
  // Extra reference images, only for a family that takes them and only as
  // many as it has slots for (lib/edit-references); anything else ignores them.
  const references = (isQwenEdit || isQwen1Edit)
    ? (gp.referenceImages ?? []).slice(0, extraReferenceSlots(type, params.model))
    : []
  // The graphics card, read only for an edit with further images: past what
  // it carries, ComfyUI 0.37 ends the run in "aimdo memory compile error"
  // (lib/comfy-edit-memory). Not on a Mac, where ComfyUI has no such compiler
  // and the figure is the shared memory.
  const cardGb = references.length > 0 && !isMacOS()
    ? await getSystemVRAM().catch(() => null)
    : null
  const fullImages = comfyEditFullImages(cardGb)
  if (isQwen1Edit) {
    const over = qwenEditPlusOverCard(1 + references.length, cardGb)
    if (over) throw new WorkflowUnavailableError(over, strategy)
  }
  if (isQwen1Edit && !allNodes['TextEncodeQwenImageEditPlus']) {
    throw new WorkflowUnavailableError(
      'Qwen-Image-Edit needs a newer ComfyUI (TextEncodeQwenImageEditPlus). Update ComfyUI, then try again.',
      strategy, undefined, { needsComfyUpdate: true },
    )
  }
  let qwen1EditImageRef: [string, number] | null = null

  const posId = String(n++)
  const negId = String(n++)

  if (strategy === 'unet_qwenimage') {
    // ONE node carries prompt and negative prompt, the reference image and
    // the matching empty latent. Outputs: positive 0, negative 1, latent 2.
    //
    // Every name here is read off the official Comfy-Org templates
    // (image_qwen_image_2_1_t2i.json, image_qwen_image_2_1_image_edit.json)
    // and the node's own schema in comfy_extras/nodes_qwen.py, checked
    // 2026-09-21. The dotted input id is not a typo: the reference slots are
    // an Autogrow group called "images" whose entries are named image_1 to
    // image_16, and ComfyUI joins the two with a dot for the API format.
    //
    // The generate path attaches neither image nor vae, exactly as the t2i
    // template does, and takes its latent from EmptyLatentImage below.
    // negId is allocated but unused on this path; the graph is keyed by id,
    // so a gap costs nothing (the I2I override below already leaves one).
    // `resolution` is declared REQUIRED by the node (no optional flag on its
    // Int input), so it goes on BOTH paths or ComfyUI answers "Required input
    // is missing" before anything runs. It only does work when a reference
    // image is attached; on the generate path it is inert, exactly as in the
    // t2i template, which also carries the widget and never uses it.
    const qwenInputs: ComfyNodeInputs = {
      clip: [clipSourceId, clipOutputSlot],
      // Transparent background: the model writes an alpha channel when the
      // prompt is wrapped the way the official template says, and SaveImage
      // below keeps it (lib/transparent-image.ts). An edit takes its picture
      // from the reference, so the wrapper stays out of it.
      // An edit names its images the way the encoder labels them, <image2>,
      // however the user spelled them (lib/image-ref-names).
      prompt: isQwenEdit
        ? canonicalImageRefs(params.prompt, 1 + references.length, 'qwen21')
        : gp.transparent ? transparentPrompt(params.prompt) : params.prompt,
      negative_prompt: isQwenEdit
        ? canonicalImageRefs(params.negativePrompt || '', 1 + references.length, 'qwen21')
        : params.negativePrompt || '',
      // With more images in an edit than the card carries at full size
      // (four, fewer on a card under 24 GB) they share a pixel budget
      // (referenceSide in lib/edit-references, lib/comfy-edit-memory).
      // The node takes ONE side for all of them and the result follows the
      // first, so such an edit comes out smaller than the canvas.
      resolution: isQwenEdit
        ? referenceSide(qwenEditResolution(params.width, params.height), 1 + references.length, fullImages)
        : qwenEditResolution(params.width, params.height),
    }
    if (isQwenEdit) {
      // The source is image_1 and sets the output shape; the references the
      // user added follow as image_2 and up, the names the prompt uses.
      const images = [gp.inputImage!, ...references]
      for (const [i, image] of images.entries()) {
        const loadId = String(n++)
        workflow[loadId] = { class_type: 'LoadImage', inputs: { image } }
        qwenInputs[`images.image_${i + 1}`] = [loadId, 0]
      }
      qwenInputs.vae = [vaeSourceId, vaeOutputSlot]
    }
    workflow[posId] = { class_type: 'TextEncodeQwenImage21', inputs: qwenInputs }
  } else if (isQwen1Edit) {
    const loadId = String(n++)
    workflow[loadId] = { class_type: 'LoadImage', inputs: { image: gp.inputImage } }
    qwen1EditImageRef = [loadId, 0]
    if (allNodes['FluxKontextImageScale']) {
      // The template scales the source to a size the model was trained on.
      const scaleId = String(n++)
      workflow[scaleId] = { class_type: 'FluxKontextImageScale', inputs: { image: [loadId, 0] } }
      qwen1EditImageRef = [scaleId, 0]
    }
    // References go in unscaled as image2 and image3: the node resizes every
    // extra image itself, only image1 sets the canvas.
    const refInputs: ComfyNodeInputs = {}
    for (const [i, image] of references.entries()) {
      const refId = String(n++)
      workflow[refId] = { class_type: 'LoadImage', inputs: { image } }
      refInputs[`image${i + 2}`] = [refId, 0]
    }
    const editInputs = (prompt: string): ComfyNodeInputs => ({
      clip: [clipSourceId, clipOutputSlot], prompt, vae: [vaeSourceId, vaeOutputSlot], image1: qwen1EditImageRef!, ...refInputs,
    })
    // The node labels its images "Picture 1: ", "Picture 2: ", so the prompt
    // names them that way too (lib/image-ref-names).
    const pictures = (text: string) => canonicalImageRefs(text, 1 + references.length, 'qwenEditPlus')
    workflow[posId] = { class_type: 'TextEncodeQwenImageEditPlus', inputs: editInputs(pictures(params.prompt)) }
    workflow[negId] = { class_type: 'TextEncodeQwenImageEditPlus', inputs: editInputs(pictures(params.negativePrompt || '')) }
  } else {
    workflow[posId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        // Lumina 2 is trained on a system prompt ahead of the user's; without
        // it the output drifts badly (CLIPTextEncodeLumina2 does the same join).
        text: strategy === 'unet_lumina2' ? `${LUMINA2_POSITIVE_SYSTEM} <Prompt Start> ${params.prompt}` : params.prompt,
        clip: [clipSourceId, clipOutputSlot],
      },
    }

    if (strategy === 'unet_ernie_image' || (strategy === 'unet_krea2' && params.cfgScale === 1)) {
      // ERNIE-Image always, and Krea 2 at CFG 1 (K9, GH #136, LUSTIFY! v10
      // Krea2): the negative branch is a no-op at CFG 1, so ConditioningZeroOut
      // replaces the wasted CLIPTextEncode pass (NOT a plain negative prompt).
      workflow[negId] = {
        class_type: 'ConditioningZeroOut',
        inputs: { conditioning: [posId, 0] },
      }
    } else {
      workflow[negId] = {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: strategy === 'unet_lumina2'
            ? `${LUMINA2_NEGATIVE_SYSTEM} <Prompt Start> ${params.negativePrompt || ''}`
            : params.negativePrompt || '',
          clip: [clipSourceId, clipOutputSlot],
        },
      }
    }
  }

  // ─── Phase 3: Latent Initialization ───
  // Inpaint mode (local Edit): source + painted mask on the checkpoint path.
  // Takes precedence over plain I2I — a mask means "repaint THIS area", never
  // "repaint everything". Ported 1:1 from the web app's tested builder
  // (create-workflows.ts): same node classes, same defaults.
  const isInpaint = !isVideo && !!gp.inputImage && !!gp.maskImage && sdCheckpointFamily
  // I2I mode: LoadImage → VAEEncode instead of empty latent. A Qwen-Image 2.1
  // edit is excluded: its reference image is already wired into the text
  // encoder above, and its sampler runs at denoise 1.0 like the official
  // template (instruction editing, not a partial re-noise of the source).
  const isI2I = !isVideo && !isInpaint && !isQwenEdit && !isQwen1Edit && params.inputImage && (params.denoise ?? 1.0) < 1.0

  const latentId = String(n++)

  if (strategy === 'unet_video') {
    // Wan/Hunyuan video latent
    const latentNode = nodes.latentInit.includes('EmptyHunyuanLatentVideo')
      ? 'EmptyHunyuanLatentVideo'
      : 'EmptyLatentImage'

    workflow[latentId] = {
      class_type: latentNode,
      inputs: latentNode === 'EmptyHunyuanLatentVideo'
        ? { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 }
        : { width: params.width, height: params.height, batch_size: videoParams.frames },
    }
  } else if (strategy === 'animatediff') {
    // AnimateDiff: batch_size = frames
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: videoParams.frames },
    }
  } else if (strategy === 'unet_mochi') {
    // Mochi video latent
    const latentNode = nodes.latentInit.includes('EmptyMochiLatentVideo')
      ? 'EmptyMochiLatentVideo'
      : 'EmptyHunyuanLatentVideo'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 },
    }
  } else if (strategy === 'unet_cosmos') {
    // Cosmos video latent
    const latentNode = nodes.latentInit.includes('EmptyCosmosLatentVideo')
      ? 'EmptyCosmosLatentVideo'
      : 'EmptyHunyuanLatentVideo'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 },
    }
  } else if (strategy === 'unet_ltx') {
    // LTX Video latent — uses length instead of batch_size
    workflow[latentId] = {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 },
    }
  } else if (strategy === 'unet_flux2' || strategy === 'unet_ernie_image') {
    // FLUX 2 / ERNIE-Image use Flux2 latent node
    const latentNode = nodes.latentInit.includes('EmptyFlux2LatentImage')
      ? 'EmptyFlux2LatentImage'
      : 'EmptySD3LatentImage'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else if (strategy === 'unet_qwenimage') {
    // Qwen-Image 2.1 generate: plain EmptyLatentImage, the node the official
    // t2i template uses. Its autoencoder has 64 channels and compresses 16x
    // where this node writes 4 channels at an eighth, but the node reports
    // its own downscale_ratio_spacial and ComfyUI repairs an all-zero latent
    // to the model's format before sampling, so the canvas comes out at the
    // size that was asked for. On the edit path this node is dropped again
    // further down: there the latent comes from TextEncodeQwenImage21, so
    // the result follows the reference image.
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else if (SD3_LATENT_STRATEGIES.has(strategy)) {
    // Chroma, HiDream, SD 3.5, Lumina 2 and Qwen-Image 1: EmptySD3LatentImage,
    // as in every one of their official templates.
    workflow[latentId] = {
      class_type: nodes.latentInit.includes('EmptySD3LatentImage') ? 'EmptySD3LatentImage' : 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else if (strategy === 'unet_zimage') {
    // Z-Image uses SD3 latent (same architecture family)
    const latentNode = nodes.latentInit.includes('EmptySD3LatentImage')
      ? 'EmptySD3LatentImage'
      : 'EmptyLatentImage'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else if (strategy === 'unet_flux') {
    // FLUX 1 uses SD3 latent
    const latentNode = nodes.latentInit.includes('EmptySD3LatentImage')
      ? 'EmptySD3LatentImage'
      : 'EmptyLatentImage'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else {
    // Checkpoint (SDXL/SD1.5)
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  }

  // The sampler consumes these refs; the I2I/inpaint overrides re-point them.
  let latentRef: [string, number] = [latentId, 0]
  let positiveRef: [string, number] = [posId, 0]
  let negativeRef: [string, number] = [negId, 0]

  if (strategy === 'unet_qwenimage') {
    // One encode node, both conditionings (slots 0 and 1).
    negativeRef = [posId, 1]
    if (isQwenEdit) {
      // ...and, with a reference image attached, the latent too (slot 2): an
      // empty latent on the reference's own size, which the node's tooltip
      // calls out as required, because any other size shifts the edit.
      latentRef = [posId, 2]
      delete workflow[latentId]
    }
  }

  if (isQwen1Edit && qwen1EditImageRef) {
    const encId = String(n++)
    workflow[encId] = { class_type: 'VAEEncode', inputs: { pixels: qwen1EditImageRef, vae: [vaeSourceId, vaeOutputSlot] } }
    latentRef = [encId, 0]
    delete workflow[latentId]
  }

  // I2I override: replace empty latent with LoadImage → VAEEncode
  if (isI2I) {
    const loadImageId = String(n++)
    const vaeEncodeId = String(n++)
    workflow[loadImageId] = {
      class_type: 'LoadImage',
      inputs: { image: params.inputImage },
    }
    workflow[vaeEncodeId] = {
      class_type: 'VAEEncode',
      inputs: { pixels: [loadImageId, 0], vae: [vaeSourceId, vaeOutputSlot] },
    }
    latentRef = [vaeEncodeId, 0]
    // Remove the empty latent node since we're using the encoded image
    delete workflow[latentId]
  } else if (isInpaint) {
    // Inpaint override: LoadImage + LoadImageMask (channel red — the mask
    // editor exports white-where-painted on black), then:
    //   Path B (InpaintModelConditioning, FLUX-fill/SD3-style) when the node
    //   exists — rewrites BOTH conditionings and emits the latent on slot 2.
    //   Path A (core VAEEncodeForInpaint) — works with any SDXL/SD1.5
    //   checkpoint; grow_mask_by feathers the mask edge.
    const loadImageId = String(n++)
    const loadMaskId = String(n++)
    workflow[loadImageId] = {
      class_type: 'LoadImage',
      inputs: { image: params.inputImage },
    }
    workflow[loadMaskId] = {
      class_type: 'LoadImageMask',
      inputs: { image: gp.maskImage, channel: 'red' },
    }
    if (allNodes['InpaintModelConditioning']) {
      const condId = String(n++)
      workflow[condId] = {
        class_type: 'InpaintModelConditioning',
        inputs: {
          positive: positiveRef, negative: negativeRef,
          vae: [vaeSourceId, vaeOutputSlot],
          pixels: [loadImageId, 0], mask: [loadMaskId, 0], noise_mask: true,
        },
        _meta: { title: 'Inpaint Path B' },
      }
      positiveRef = [condId, 0]
      negativeRef = [condId, 1]
      latentRef = [condId, 2]
    } else {
      const encId = String(n++)
      workflow[encId] = {
        class_type: 'VAEEncodeForInpaint',
        inputs: {
          pixels: [loadImageId, 0], vae: [vaeSourceId, vaeOutputSlot],
          mask: [loadMaskId, 0], grow_mask_by: gp.growMaskBy ?? 6,
        },
        _meta: { title: 'Inpaint Path A' },
      }
      latentRef = [encId, 0]
    }
    delete workflow[latentId]
  }

  // ─── I2V override (Animate — local lane restored, 2026-07-17) ───
  // A video request carrying an inputImage swaps the empty latent for the
  // family's image-to-video conditioning node. Covers every family core
  // ComfyUI can animate on this main path (WAN i2v, Hunyuan i2v, LTX,
  // Cosmos); wan22/SVD/FramePack already handle the image in their dedicated
  // builders above. Wiring is schema-driven — we only feed inputs the live
  // node declares and map outputs by their declared types — so version drift
  // in these nodes degrades to a ComfyUI validation error, not a bad graph.
  // A later section of a long clip (B18) is an I2V run too: it starts on the
  // last frames of the clip so far instead of on one picture.
  const continueFrom = isVideo ? videoParams.continueFrom : undefined
  let continued: ContinueSource | null = null
  const isI2V = isVideo && (!!(params as GenerateParams).inputImage || !!continueFrom)
  if (isI2V && ['unet_video', 'unet_ltx', 'unet_cosmos', 'unet_mochi'].includes(strategy)) {
    if (strategy === 'unet_mochi') {
      throw new WorkflowUnavailableError(
        'Mochi is text-to-video only, pick an i2v-capable model (WAN i2v, WAN 2.2 ti2v, SVD, LTX, Cosmos) to animate an image.',
        strategy,
      )
    }
    const i2vNode =
      strategy === 'unet_ltx' ? 'LTXVImgToVideo'
      : strategy === 'unet_cosmos' ? 'CosmosImageToVideoLatent'
      : type === 'hunyuan' ? 'HunyuanImageToVideo'
      : 'WanImageToVideo'
    const meta = allNodes[i2vNode]
    if (!meta) {
      throw new WorkflowUnavailableError(
        `Animating with this model family needs the ${i2vNode} node, which your ComfyUI doesn't have. Update ComfyUI, then try again.`,
        strategy,
        undefined,
        { needsComfyUpdate: true },
      )
    }
    if (continueFrom && i2vNode !== 'WanImageToVideo') {
      throw new WorkflowUnavailableError('Continuing a clip in sections works with Wan, Wan 2.2 and LTX 2.5. Pick one of those models, or make this clip in one run.', strategy)
    }
    let startRef: [string, number]
    if (continueFrom) {
      requireContinueNodes(allNodes, strategy)
      continued = addContinueSource(workflow, n, continueFrom, allNodes)
      n = continued.n
      startRef = continued.tail
    } else {
      const loadId = String(n++)
      workflow[loadId] = { class_type: 'LoadImage', inputs: { image: (params as GenerateParams).inputImage } }
      startRef = [loadId, 0]
    }
    const required = meta.input?.required ?? {}
    const optional = meta.input?.optional ?? {}
    const decl = { ...required, ...optional }
    const inputs: ComfyNodeInputs = {}
    if (decl.positive) inputs.positive = positiveRef
    if (decl.negative) inputs.negative = negativeRef
    if (decl.vae) inputs.vae = [vaeSourceId, vaeOutputSlot]
    if (decl.width) inputs.width = params.width
    if (decl.height) inputs.height = params.height
    if (decl.length) inputs.length = videoParams.frames
    if (decl.batch_size) inputs.batch_size = 1
    if (decl.start_image) inputs.start_image = startRef
    else if (decl.image) inputs.image = startRef
    else if (decl.init_image) inputs.init_image = startRef
    // SVI-style anti-drift padding (core WanImageToVideo, 2026): the empty
    // frames of a continued section are filled with the clip's first picture
    // instead of grey, so faces and colours stay where the clip started.
    if (continued && decl.ref_pad_image) inputs.ref_pad_image = continued.first
    // Remaining REQUIRED widgets we don't model: take the schema default,
    // for a combo the first option. Same live-schema pattern as the RMBG
    // builder, and the combo read goes through the one shared reader so the
    // newer COMBO/options shape cannot leave a required widget unset.
    for (const [key, spec] of Object.entries(required)) {
      if (inputs[key] !== undefined) continue
      const combo = readComboOptions(spec)
      if (combo && combo.length) inputs[key] = combo[0]
      else {
        const dflt = specDefault(spec)
        if (dflt !== undefined) inputs[key] = dflt
      }
    }
    const i2vId = String(n++)
    workflow[i2vId] = { class_type: i2vNode, inputs, _meta: { title: 'I2V conditioning' } }
    // Outputs by declared type: 1st CONDITIONING → positive, 2nd → negative
    // (Hunyuan emits only one — its negative stays on the text encoder),
    // LATENT → sampler latent. A latent-only node (Cosmos) leaves both
    // conditionings untouched.
    const outs: string[] = (meta.output ?? []) as string[]
    const latSlot = outs.indexOf('LATENT')
    latentRef = [i2vId, latSlot >= 0 ? latSlot : 0]
    const condSlots = outs.map((t, i) => (t === 'CONDITIONING' ? i : -1)).filter((i) => i >= 0)
    if (condSlots.length >= 1) positiveRef = [i2vId, condSlots[0]]
    if (condSlots.length >= 2) negativeRef = [i2vId, condSlots[1]]
    delete workflow[latentId]
  }

  // K9 (GH #136), corrected Runde 3 after review: the issue documents TWO
  // Krea 2 author recipes that disagree on this exact node. LUSTIFY! v10
  // Krea2 carries ModelSamplingAuraFlow at shift 4; FinePorn v4 NVFP4, the
  // reporter's only run he actually PROVED working end to end, used NO such
  // node and ComfyUI's own default sampling. classifyModel cannot tell a
  // LUSTIFY-style checkpoint from a FinePorn-style one (both classify as
  // 'krea2'), so forcing shift 4 on every one of them - what this branch
  // used to do - applied an unevidenced sigma-schedule change to the one
  // variant the issue actually proves works without it. Deliberately absent:
  // no ModelSamplingAuraFlow node, ComfyUI's built-in default applies,
  // matching the proven recipe. If a future signal can tell the two variants
  // apart (filename convention, a CivitAI metadata field, ...), gate this
  // node on that signal rather than reintroducing it unconditionally.

  // Sampling patches of the header-sniffed families, straight from their
  // official templates: AuraFlow shift 1 (Chroma), 6 (Lumina 2), 3.1 / 3
  // (Qwen-Image / -Edit); ModelSamplingSD3 shift 3 (HiDream fast/full) or 6
  // (dev). Qwen-Image-Edit also runs CFGNorm at strength 1.
  const auraShift = strategy === 'unet_chroma' ? 1
    : strategy === 'unet_lumina2' ? 6
    : strategy === 'unet_qwenimage1' ? (isQwenImageEditModel(params.model) ? 3 : 3.1)
    : null
  if (auraShift !== null && allNodes['ModelSamplingAuraFlow']) {
    const id = String(n++)
    workflow[id] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: [samplerModelId, 0], shift: auraShift } }
    samplerModelId = id
  }
  if (strategy === 'unet_hidream' && allNodes['ModelSamplingSD3']) {
    const id = String(n++)
    workflow[id] = { class_type: 'ModelSamplingSD3', inputs: { model: [samplerModelId, 0], shift: /dev/i.test(params.model) ? 6 : 3 } }
    samplerModelId = id
  }
  if (isQwen1Edit && allNodes['CFGNorm']) {
    const id = String(n++)
    workflow[id] = { class_type: 'CFGNorm', inputs: { model: [samplerModelId, 0], strength: 1 } }
    samplerModelId = id
  }
  // Qwen-Image 2.1, full model and Turbo: both official templates put
  // QwenImage21Cache ("auto", "default") between the model and the sampler.
  // It only sets where the key/value cache of the prompt prefix lives
  // (comfy_extras/nodes_qwen.py), so it goes after the LoRA chain: UNET →
  // LoRAs → cache → sampler. A ComfyUI without the node runs without it.
  if (strategy === 'unet_qwenimage' && allNodes['QwenImage21Cache']) {
    const id = String(n++)
    workflow[id] = { class_type: 'QwenImage21Cache', inputs: { model: [samplerModelId, 0], device: 'auto', dtype: 'default' } }
    samplerModelId = id
  }
  // Qwen-Image 2.1 Turbo (lib/render/qwen21-turbo): its own eight step
  // schedule through SamplerCustomAdvanced, as the official Turbo templates
  // run it, for Generate and Edit alike. Steps, sampler and scheduler of the
  // sliders do not reach it. CFG does: the Turbo edit template offers cfg as
  // a setting of its own (1, "raise it only if you use a negative prompt"),
  // and Create presets 1 for a Turbo file and says so when it is higher.
  // Without one of the custom sampler nodes the run falls back to a KSampler
  // at eight steps, euler, simple.
  const qwenTurbo = strategy === 'unet_qwenimage' && isQwenImage21Turbo(params.model)
  const qwenTurboChain = qwenTurbo && QWEN21_TURBO_NODES.every((c) => !!allNodes[c])
  if (qwenTurbo) {
    log.info(`[dynamic-workflow] Qwen-Image 2.1 Turbo: ${qwenTurboChain ? 'SamplerCustomAdvanced on the template sigmas' : 'KSampler fallback, 8 steps'}`)
  }

  // ─── Phase 4: Sampling ───

  // Wan 2.2 A14B (GH #193): the high noise half lays out the clip, the low
  // noise half finishes it, the split ComfyUI's own template runs (two
  // KSamplerAdvanced, the first returns its leftover noise). Only when the
  // picked file is the high half and its partner sits in the same loader
  // list; otherwise the one file runs alone as before. LoRAs stay on the
  // picked half.
  const lowNoisePartner = isVideo && type === 'wan' && !fromCheckpoint && !!allNodes['KSamplerAdvanced']
    ? wan22LowNoisePartner(params.model, listedUnets)
    : null
  let highNoiseStage: { id: string; lowId: string; split: number } | null = null
  let lowModelRef: [string, number] | null = null
  if (lowNoisePartner) {
    const lowLoaderId = String(n++)
    addUnetLoader(workflow, lowLoaderId, lowNoisePartner, allNodes)
    lowModelRef = [lowLoaderId, 0]
  }

  // Wan (B18, 3.0.9): the sampling shift of the official templates, which the
  // main path never set, and the lightx2v speed LoRAs for a fast run (4 steps
  // at cfg 1, lib/wan-speed). The LoRAs go on each half its own: the high
  // noise LoRA on the high noise model, the low noise one on the low. A fast
  // run without its LoRA would come out as mush, so it stops with the file
  // names instead.
  if (isVideo && type === 'wan' && strategy === 'unet_video' && !fromCheckpoint) {
    const kind = wanSpeedKind(params.model)
    const fast = !!kind && isFastSampling(params.steps, params.cfgScale)
    if (fast && kind) {
      const listedLoras = [
        ...nodeComboOptions(allNodes, 'LoraLoaderModelOnly', 'lora_name'),
        ...nodeComboOptions(allNodes, 'LoraLoader', 'lora_name'),
      ]
      const halves: Array<'high' | 'low' | 'single'> = kind.startsWith('a14b') ? ['high', 'low'] : ['single']
      const picks = halves.map((h) => findWanSpeedLora(kind, h, listedLoras))
      if (picks.some((p) => !p) || (kind.startsWith('a14b') && !lowModelRef)) {
        const need = wanSpeedLoraNames(kind)
        throw new WorkflowUnavailableError(
          kind.startsWith('a14b') && !lowModelRef && picks.every(Boolean)
            ? `Fast mode runs both halves of ${params.model}: the matching low noise file is not installed. Install the whole Wan 2.2 A14B bundle, or switch Speed to Quality.`
            : `Fast mode (4 steps) needs the lightx2v speed LoRA${need.length > 1 ? 's' : ''} ${need.join(' and ')} in ComfyUI/models/loras. Download "Wan speed LoRAs" in the Model Manager, or switch Speed to Quality.`,
          strategy,
        )
      }
      const loraNode = allNodes['LoraLoaderModelOnly'] ? 'LoraLoaderModelOnly' : null
      const patch = (model: [string, number], lora: string): [string, number] => {
        const id = String(n++)
        workflow[id] = loraNode
          ? { class_type: loraNode, inputs: { lora_name: lora, strength_model: 1.0, model }, _meta: { title: 'Speed LoRA' } }
          : { class_type: 'LoraLoader', inputs: { lora_name: lora, strength_model: 1.0, strength_clip: 0, model, clip: [clipSourceId, clipOutputSlot] }, _meta: { title: 'Speed LoRA' } }
        return [id, 0]
      }
      samplerModelId = patch([samplerModelId, 0], picks[0]!)[0]
      if (lowModelRef && picks[1]) lowModelRef = patch(lowModelRef, picks[1])
    }
    if (allNodes['ModelSamplingSD3']) {
      const shift = fast ? WAN_FAST.shift : (wanSamplingFor(params.model, 'quality')?.shift ?? 8)
      const shiftOf = (model: [string, number]): [string, number] => {
        const id = String(n++)
        workflow[id] = { class_type: 'ModelSamplingSD3', inputs: { model, shift } }
        return [id, 0]
      }
      samplerModelId = shiftOf([samplerModelId, 0])[0]
      if (lowModelRef) lowModelRef = shiftOf(lowModelRef)
    }
  }

  // One pass past the native length (B18): sliding context windows on the
  // model(s), when asked for and the core has the node.
  if (isVideo && videoParams.contextWindows && !continueFrom) {
    const win = addContextWindows(workflow, n, [samplerModelId, 0], type, videoParams.frames, allNodes)
    n = win.n
    samplerModelId = win.model[0]
    if (lowModelRef) {
      const low = addContextWindows(workflow, n, lowModelRef, type, videoParams.frames, allNodes)
      n = low.n
      lowModelRef = low.model
    }
  }

  if (lowNoisePartner && lowModelRef) {
    highNoiseStage = { lowId: lowModelRef[0], id: String(n++), split: Math.max(1, Math.floor(params.steps / 2)) }
    const { id, split } = highNoiseStage
    workflow[id] = {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: [samplerModelId, 0], add_noise: 'enable', noise_seed: seed,
        steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler,
        positive: positiveRef, negative: negativeRef, latent_image: latentRef,
        start_at_step: 0, end_at_step: split, return_with_leftover_noise: 'enable',
      },
      _meta: { title: 'Wan 2.2 high noise' },
    }
    log.info(`[dynamic-workflow] Wan 2.2 A14B pair: ${params.model} → ${lowNoisePartner}, split at step ${split}`)
  }

  // The four inputs of the Turbo chain besides the latent, one node each.
  let qwenTurboCustom: ComfyNodeInputs | null = null
  if (qwenTurboChain) {
    const part = (node: { class_type: string; inputs: ComfyNodeInputs }): [string, number] => {
      const id = String(n++)
      workflow[id] = node
      return [id, 0]
    }
    qwenTurboCustom = {
      noise: part({ class_type: 'RandomNoise', inputs: { noise_seed: seed } }),
      guider: part({
        class_type: 'CFGGuider',
        inputs: { model: [samplerModelId, 0], positive: positiveRef, negative: negativeRef, cfg: params.cfgScale },
      }),
      sampler: part({ class_type: 'KSamplerSelect', inputs: { sampler_name: QWEN21_TURBO_SAMPLING.sampler } }),
      sigmas: part({ class_type: 'ManualSigmas', inputs: { sigmas: QWEN21_TURBO_SIGMAS } }),
    }
  }

  const samplerId = String(n++)

  workflow[samplerId] = highNoiseStage ? {
    class_type: 'KSamplerAdvanced',
    inputs: {
      model: [highNoiseStage.lowId, 0], add_noise: 'disable', noise_seed: seed,
      steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler,
      positive: positiveRef, negative: negativeRef, latent_image: [highNoiseStage.id, 0],
      start_at_step: highNoiseStage.split, end_at_step: 10000, return_with_leftover_noise: 'disable',
    },
    _meta: { title: 'Wan 2.2 low noise' },
  } : qwenTurboCustom ? {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      ...qwenTurboCustom,
      latent_image: latentRef,
    },
    _meta: { title: 'Qwen-Image 2.1 Turbo' },
  } : {
    class_type: 'KSampler',
    inputs: {
      model: [samplerModelId, 0],
      positive: positiveRef,
      negative: negativeRef,
      latent_image: latentRef,
      seed,
      steps: qwenTurbo ? QWEN21_TURBO_SAMPLING.steps : params.steps,
      cfg: params.cfgScale,
      sampler_name: qwenTurbo ? QWEN21_TURBO_SAMPLING.sampler : params.sampler,
      scheduler: qwenTurbo ? QWEN21_TURBO_SAMPLING.scheduler : params.scheduler,
      denoise: isInpaint ? (params.denoise ?? 0.85) : isI2I ? (params.denoise ?? 0.7) : 1.0, // Qwen-Image-Edit: 1.0, like its template
    },
  }

  // ─── Phase 5: Decode ───

  const decodeId = String(n++)

  workflow[decodeId] = isVideo
    ? videoDecodeNode([samplerId, 0], [vaeSourceId, vaeOutputSlot], nodes.decoders.includes('VAEDecodeTiled'))
    : {
        class_type: 'VAEDecode',
        inputs: {
          samples: [samplerId, 0],
          vae: [vaeSourceId, vaeOutputSlot],
        },
      }

  // ─── Phase 6: Output ───

  if (isVideo) {
    // A continued section goes behind the clip so far, without the frames it
    // repeats, and the whole clip is saved (B18).
    let frames: [string, number] = [decodeId, 0]
    if (continued && continueFrom) {
      const joined = addStitch(workflow, n, continued.frames, frames, continueFrom.overlap, allNodes)
      n = joined.n
      frames = joined.images
    }
    // Video output: core SaveVideo (mp4) > VHS > SaveAnimatedWEBP > SaveImage (A19)
    addVideoSave(workflow, n, frames, videoParams.fps, promptFilenamePrefix(params.prompt, true), (c) => nodes.videoSavers.includes(c))
  } else {
    workflow[String(n)] = {
      class_type: 'SaveImage',
      inputs: {
        images: [decodeId, 0],
        filename_prefix: promptFilenamePrefix(params.prompt, false),
      },
    }
  }

  log.info(`[dynamic-workflow] Built ${Object.keys(workflow).length} nodes`, {
    nodes: Object.entries(workflow).map(([id, node]) => `${id}:${node.class_type}`).join(' → ')
  })

  return workflow
}

// ─── Wrapper Workflow Builders ───

// Background removal (ComfyUI-RMBG). Self-contained LoadImage → RMBG → SaveImage
// graph. Every RMBG widget is defaulted from the node's LIVE object_info schema
// (`rmbgMeta`) so the graph stays valid across RMBG versions instead of pinning
// input names/enums we'd have to guess. The `background` widget is nudged toward
// a transparent/alpha option so the result is a real RGBA cutout, not a matte.
function buildRemoveBgWorkflow(params: GenerateParams, rmbgMeta: NodeMetadata): ComfyApiGraph {
  const workflow: ComfyApiGraph = {}
  workflow['1'] = { class_type: 'LoadImage', inputs: { image: params.inputImage } }

  // Fill BOTH required AND optional widgets from the live schema. ComfyUI-RMBG
  // declares process_res / sensitivity / mask_blur / mask_offset as "optional"
  // in INPUT_TYPES but its Python reads them as plain kwargs, so omitting them
  // throws "Error in batch processing: 'process_res' (RMBG)". Defaulting every
  // widget from object_info keeps the graph valid across RMBG versions.
  const required = rmbgMeta.input?.required ?? {}
  const optional = rmbgMeta.input?.optional ?? {}
  const rmbgInputs: ComfyNodeInputs = { image: ['1', 0] }
  for (const [name, spec] of Object.entries({ ...required, ...optional })) {
    if (name === 'image') continue
    const d = rmbgWidgetDefault(name, spec)
    if (d.set) rmbgInputs[name] = d.value
  }
  workflow['2'] = { class_type: 'RMBG', inputs: rmbgInputs }

  // RMBG returns (IMAGE, MASK, …); slot 0 is the cut-out image. SaveImage writes
  // the transparent PNG, picked up by extractComfyOutputFiles like any output.
  workflow['3'] = {
    class_type: 'SaveImage',
    inputs: { images: ['2', 0], filename_prefix: promptFilenamePrefix(params.prompt, false) },
  }
  return workflow
}

// ─── Enhance Image on local ComfyUI (3.0.7) ───
//
// Core nodes only: LoadImage → UpscaleModelLoader + ImageUpscaleWithModel →
// (a resize when the model's own scale is not the factor asked for) →
// SaveImage. ImageUpscaleWithModel tiles on its own and halves the tile when
// the card runs out of memory, so no tile settings are needed here.

export interface UpscaleParams {
  /** The source, as ComfyUI's /upload/image named it. */
  image: string
  /** A file ComfyUI lists for UpscaleModelLoader (models/upscale_models). */
  model: string
  factor: UpscaleFactor
  /** The source's size, for the exact resize when the model's scale is unknown. */
  sourceWidth: number
  sourceHeight: number
}

const UPSCALE_NODES = ['LoadImage', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'SaveImage']

/** The resize method: area to go down (a 4x model asked for 2x), lanczos to go
 *  up. Taken from the node's live list when it can be read, so a ComfyUI that
 *  renamed one never sees a value it would reject. */
function resizeMethod(allNodes: NodePresence, node: 'ImageScaleBy' | 'ImageScale', down: boolean): string {
  const wanted = down ? 'area' : 'lanczos'
  const listed = nodeComboOptions(allNodes, node, 'upscale_method')
  if (listed.length === 0 || listed.includes(wanted)) return wanted
  return listed.includes('bicubic') ? 'bicubic' : listed[0]
}

export function buildUpscaleWorkflow(params: UpscaleParams, allNodes: NodePresence): ComfyApiGraph {
  requireNodes(allNodes, UPSCALE_NODES, 'Enhance Image')
  const listed = nodeComboOptions(allNodes, 'UpscaleModelLoader', 'model_name')
  if (listed.length > 0 && !listed.includes(params.model)) {
    throw new WorkflowUnavailableError(
      `${params.model} is no longer in ComfyUI's upscale model list. It may have been moved or deleted. Restart ComfyUI after adding files, then try again.`,
      'unavailable',
    )
  }
  const workflow: ComfyApiGraph = {}
  workflow['1'] = { class_type: 'LoadImage', inputs: { image: params.image } }
  workflow['2'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: params.model } }
  workflow['3'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } }
  let out: [string, number] = ['3', 0]
  const native = nativeUpscaleScale(params.model)
  if (native !== null && native !== params.factor) {
    // A 4x model asked for 2x: the model's result, scaled by 0.5.
    requireNodes(allNodes, ['ImageScaleBy'], 'Enhance Image')
    const scale = params.factor / native
    workflow['4'] = {
      class_type: 'ImageScaleBy',
      inputs: { image: out, upscale_method: resizeMethod(allNodes, 'ImageScaleBy', scale < 1), scale_by: scale },
    }
    out = ['4', 0]
  } else if (native === null) {
    // The name does not say the model's scale: resize to the exact target.
    requireNodes(allNodes, ['ImageScale'], 'Enhance Image')
    const t = upscaleTarget(params.sourceWidth, params.sourceHeight, params.factor)
    workflow['4'] = {
      class_type: 'ImageScale',
      inputs: { image: out, upscale_method: resizeMethod(allNodes, 'ImageScale', false), width: t.width, height: t.height, crop: 'disabled' },
    }
    out = ['4', 0]
  }
  workflow['5'] = {
    class_type: 'SaveImage',
    inputs: { images: out, filename_prefix: `${promptFilenamePrefix('', false)}_enhanced` },
  }
  return workflow
}

/** The graph against the running ComfyUI's node list. */
export async function buildLocalUpscaleWorkflow(params: UpscaleParams): Promise<ComfyApiGraph> {
  return buildUpscaleWorkflow(params, await getAllNodeInfo())
}

// Resolve a default value for one RMBG widget input from its object_info spec.
// Combo → prefer a transparent option for the background widget, else the
// declared default / first entry. Primitives → their declared default. A
// non-widget connection input (some other IMAGE/MASK) can't be auto-wired, so
// skip it — ComfyUI surfaces a clear error rather than us guessing wrong.
function rmbgWidgetDefault(
  name: string,
  spec: ComfyInputValue | undefined,
): { set: boolean; value?: ComfyInputValue } {
  const { typeName, config: cfg } = specParts(spec)
  // A bare (non-array) spec is its own type marker — RMBG has shipped both.
  const t = typeName ?? (Array.isArray(spec) ? undefined : spec)
  // Both dropdown schemas, through the shared reader: a node that declares its
  // combos the newer way (["COMBO", {options: [...]}]) used to fall through to
  // "not a widget" here, and RMBG then rejected the graph for the missing
  // widget it had just declared.
  const options = readComboOptions(spec)
  if (options && options.length > 0) {
    if (/back\s*ground|(^|_)bg($|_)/i.test(name)) {
      const alpha = options.find((o) => /alpha|transparent/i.test(o))
      if (alpha) return { set: true, value: alpha }
    }
    return { set: true, value: cfg?.default ?? options[0] }
  }
  if (t === 'BOOLEAN') return { set: true, value: cfg?.default ?? false }
  if (t === 'INT' || t === 'FLOAT') return { set: true, value: cfg?.default ?? 0 }
  if (t === 'STRING' || t === 'COLORCODE') return { set: true, value: cfg?.default ?? '' }
  return { set: false }
}


function addVideoOutput(workflow: ComfyApiGraph, n: number, decodeId: string, fps: number, nodes: CategorizedNodes, prompt?: string): number {
  return addVideoSave(workflow, n, [decodeId, 0], fps, promptFilenamePrefix(prompt, true), (c) => nodes.videoSavers.includes(c))
}

// buildCogVideoWorkflow deleted 2026-07-24 (D#88). It emitted CogVideoXCLIPLoader,
// CogVideoXTextEncode, CogVideoXEmptyLatents, CogVideoXSampler and
// CogVideoXVAEDecode, none of which are registered by kijai's wrapper, so it
// only ever produced ComfyUI 400s. Kept out of the tree on purpose: leaving a
// known-wrong graph around invites someone to just reopen the gate. Git history
// has it if the lane is ever rebuilt, which needs a real generate to land.

function buildSVDWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): ComfyApiGraph {
  const workflow: ComfyApiGraph = {}
  let n = 1

  const loaderId = String(n++)
  const imageId = String(n++)
  const scaleId = String(n++)
  const condId = String(n++)
  const guidanceId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[loaderId] = { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: params.model } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  // Aspect-fill the source into the SVD generation resolution (2026-06-11:
  // a portrait/square still fed straight in came back squished and no longer
  // matched the input). crop:'center' scales to cover width×height then
  // centre-crops — so the conditioning sees the source at the right aspect with
  // no distortion, instead of SVD stretching it internally.
  workflow[scaleId] = {
    class_type: 'ImageScale',
    inputs: { image: [imageId, 0], upscale_method: 'lanczos', width: params.width, height: params.height, crop: 'center' },
  }
  workflow[condId] = {
    class_type: 'SVD_img2vid_Conditioning',
    inputs: {
      clip_vision: [loaderId, 1], init_image: [scaleId, 0], vae: [loaderId, 2],
      augmentation_level: 0.0, width: params.width, height: params.height,
      video_frames: params.frames,
      // Lower motion = stays closer to the source (127 = SVD's high-drift default).
      motion_bucket_id: params.motionBucketId ?? 90,
      fps: params.fps,
    },
  }
  workflow[guidanceId] = { class_type: 'VideoLinearCFGGuidance', inputs: { model: [loaderId, 0], min_cfg: 1.0 } }
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: { model: [guidanceId, 0], positive: [condId, 0], negative: [condId, 1], latent_image: [condId, 2], seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 },
  }
  workflow[decodeId] = videoDecodeNode([samplerId, 0], [loaderId, 2], nodes.decoders.includes('VAEDecodeTiled'))

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

/**
 * Snap a frame count to Wan 2.2's length grid. The Wan 2.2 VAE has a temporal
 * stride of 4, so `Wan22ImageToVideoLatent.length` must be 4k+1 (…45, 49, 53…).
 * An off-grid length makes ComfyUI error or silently drop the tail frame.
 * Exported + pure for the unit tests and the vram-handoff duration math.
 */
export function snapWanLength(frames: number): number {
  const f = Number.isFinite(frames) ? Math.round(frames) : 49
  const k = Math.max(1, Math.round((f - 1) / 4))
  return k * 4 + 1
}

/**
 * Wan 2.2 TI2V-5B, one model, both modes. `Wan22ImageToVideoLatent` takes an
 * OPTIONAL `start_image`: present is image-to-video (the clip opens on the
 * source still), absent is text-to-video. Uses the Wan 2.2 VAE, not the 2.1
 * VAE (the 2.2 VAE has 16x spatial / 4x temporal compression, a different
 * latent shape) and the shared UMT5-XXL text encoder. `ModelSamplingSD3`
 * applies Wan's sampling shift.
 *
 * I2V faithfulness (2026-06-11): an `ImageScale(crop:center)` aspect-fills
 * the source into the generation size, so the first frame matches the still
 * instead of being squished, the same fix proven on the SVD path.
 *
 * K2 (review-create.md nachbessert, Punkt 1): the CLIP/VAE names below used
 * to be hardcoded literals, the same failure class as buildS2VWorkflow and
 * buildMotionWorkflow (see their own K2 comments) and Node 3 in this builder
 * is also the VAELoader, so an unresolved live enum produced the identical
 * "Node 3 (VAELoader): Value not in list" here. Wan 2.2 TI2V-5B is the
 * default local Animate model, so this is the actual path a customer hits.
 * Resolved now via the same findMatchingCLIP/findMatchingVAE live-list
 * resolvers Bug C and K2 already use elsewhere, with 'wan22' for the VAE
 * (its own compression profile, comfyui.ts:1441) and 'wan' for the CLIP
 * (wan22 shares the plain Wan UMT5 encoder, component-registry.ts confirms
 * clipType: 'wan' for both wan and wan22).
 */
async function buildWan22Workflow(params: VideoParams, seed: number, nodes: CategorizedNodes, allNodes: NodePresence): Promise<ComfyApiGraph> {
  const workflow: ComfyApiGraph = {}
  let n = 1

  // Wan 2.2 dims snap to 32 (VAE spatial grid); length to 4k+1 (temporal stride 4).
  const snap32 = (v: number | undefined, def: number) => Math.max(64, Math.round(((v && v > 0) ? v : def) / 32) * 32)
  const width = snap32(params.width, 1024)
  const height = snap32(params.height, 576)
  const length = snapWanLength(params.frames || 49)

  const [wan22Clip, wan22Vae] = await Promise.all([
    findMatchingCLIP('wan', params.model),
    findMatchingVAE('wan22'),
  ])

  const unetId = String(n++)
  const clipId = String(n++)
  const vaeId = String(n++)
  const posId = String(n++)
  const negId = String(n++)

  addUnetLoader(workflow, unetId, params.model, allNodes)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: wan22Clip, type: 'wan', device: 'default' } }
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: wan22Vae } }
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  // Optional LoRA chain (D#80): video LoRAs are model-only, so
  // patch the UNET with LoraLoaderModelOnly (no clip side) before the sampling
  // shift. Guarded on params.lora, a plain Wan 2.2 gen stays byte-identical.
  let wanModelSrc = unetId
  const wanLoras = normalizeLoraList(params.lora)
  if (wanLoras.length > 0) {
    const wanStrengths = normalizeLoraStrengths(params.loraStrength, wanLoras.length)
    wanLoras.forEach((loraName, i) => {
      const loraId = String(n++)
      workflow[loraId] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: loraName, strength_model: wanStrengths[i], model: [wanModelSrc, 0] },
      }
      wanModelSrc = loraId
    })
  }

  // Wan's recommended sampling shift. ModelSamplingSD3 is a core node (ships since
  // SD3), so the sampler reads from it to match the official 5B workflow's motion.
  const shiftId = String(n++)
  workflow[shiftId] = { class_type: 'ModelSamplingSD3', inputs: { model: [wanModelSrc, 0], shift: 8.0 } }
  let samplerModel: [string, number] = [shiftId, 0]
  if (params.contextWindows && !params.continueFrom) {
    const win = addContextWindows(workflow, n, samplerModel, 'wan22', length, allNodes)
    n = win.n
    samplerModel = win.model
  }

  // Unified latent: a start_image is attached ONLY for an I2V request. A
  // continued section (B18) attaches the last frames of the clip so far; the
  // node masks every latent frame they cover, so the section picks the
  // motion up where it stopped.
  const latentInputs: ComfyNodeInputs = { vae: [vaeId, 0], width, height, length, batch_size: 1 }
  let continued: ContinueSource | null = null
  if (params.continueFrom) {
    requireContinueNodes(allNodes, 'unet_video')
    continued = addContinueSource(workflow, n, params.continueFrom, allNodes)
    n = continued.n
    const scaleId = String(n++)
    workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: continued.tail, upscale_method: 'lanczos', width, height, crop: 'center' } }
    latentInputs.start_image = [scaleId, 0]
  } else if (params.inputImage) {
    const imageId = String(n++)
    const scaleId = String(n++)
    workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage } }
    workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: [imageId, 0], upscale_method: 'lanczos', width, height, crop: 'center' } }
    latentInputs.start_image = [scaleId, 0]
  }
  const latentId = String(n++)
  workflow[latentId] = { class_type: 'Wan22ImageToVideoLatent', inputs: latentInputs }

  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: samplerModel, positive: [posId, 0], negative: [negId, 0], latent_image: [latentId, 0],
      seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
    },
  }
  const decodeId = String(n++)
  workflow[decodeId] = videoDecodeNode([samplerId, 0], [vaeId, 0], nodes.decoders.includes('VAEDecodeTiled'))

  if (continued && params.continueFrom) {
    const joined = addStitch(workflow, n, continued.frames, [decodeId, 0], params.continueFrom.overlap, allNodes)
    addVideoSave(workflow, joined.n, joined.images, params.fps, promptFilenamePrefix(params.prompt, true), (c) => nodes.videoSavers.includes(c))
    return workflow
  }
  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

/** MiniMax H3 counts frames in blocks of 17 plus 5 (124 is about five
 *  seconds at 24 fps). Rounds UP, as the official template does, so a request
 *  never comes back shorter than asked. */
export function snapMiniMaxH3Length(frames: number): number {
  const f = Math.max(5, Number.isFinite(frames) ? Math.round(frames) : 124)
  return f + ((5 - (f % 17)) + 17) % 17
}

/**
 * MiniMax H3 (Discord, throwaway 2026-09-26: "shows up as an image model").
 * One model writes picture and sound together, wired as the official
 * Comfy-Org t2v/i2v and r2v templates do: the encode node builds the joint
 * latent, BasicGuider and SamplerCustomAdvanced sample it, and VAEDecode and
 * VAEDecodeAudio each pull their half back out before CreateVideo muxes them.
 *
 * Two sets of weights share the family. fl2va takes the source image as the
 * first frame; ref2va takes it as a reference the prompt can call
 * <Picture 1>.
 */
async function buildMiniMaxH3Workflow(params: VideoParams, seed: number, allNodes: NodePresence): Promise<ComfyApiGraph> {
  const fast = isFastH3(params.model)
  const isRef2va = !fast && /ref2va/i.test(params.model)
  const encodeNode = isRef2va ? 'MiniMaxH3ReferenceToVideo' : 'MiniMaxH3ImageToVideo'
  requireNodes(allNodes, [encodeNode, 'BasicGuider', 'SamplerCustomAdvanced', 'VAEDecodeAudio'], 'MiniMax H3')
  if (fast) {
    // FastH3 runs on FastVideo's sparse attention, which ComfyUI has had since
    // 0.35.0 (BlockSparseAttention), and it only distilled text to video.
    requireRelease(allNodes, ['BlockSparseAttention', 'MiniMaxH3SigmaShift'], FASTH3_NEEDS_UPDATE, 'minimaxh3')
    // Read in comfy_extras/nodes_sparse_attention.py (ComfyUI master, 2026-10-02):
    // BlockSparseAttention does NOT use Triton. It calls the compiled sol_attn
    // kernels of comfy_kitchen (CUDA sm_80+ on Linux and Windows x64 wheels, or
    // HIP). Where they are not available (older GPU, CPU) h3_eligible() returns
    // False and the block runs the model's normal dense attention, so the graph
    // is valid on every machine and only loses the speed gain. No platform gate.
    if (params.inputImage) {
      throw new WorkflowUnavailableError('FastH3 makes video from a prompt only. Pick MiniMax H3 to start from an image.', 'minimaxh3')
    }
  }

  const workflow: ComfyApiGraph = {}
  let n = 1
  const snap32 = (v: number | undefined, def: number) => Math.max(32, Math.round(((v && v > 0) ? v : def) / 32) * 32)
  const width = snap32(params.width, 1344)
  const height = snap32(params.height, 768)
  const length = snapMiniMaxH3Length(params.frames || 124)

  const [clipName, vaeName, audioVaeName] = await Promise.all([
    findMatchingCLIP('minimaxh3', params.model),
    findMatchingVAE('minimaxh3'),
    findMiniMaxAudioVAE(),
  ])

  const unetId = String(n++)
  const clipId = String(n++)
  const vaeId = String(n++)
  const audioVaeId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: clipName, type: 'minimax', device: 'default' } }
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: vaeName } }
  workflow[audioVaeId] = { class_type: 'VAELoader', inputs: { vae_name: audioVaeName } }

  // Video LoRAs (the turbo ones included) patch the model only.
  let modelSrc = unetId
  const stack = normalizeLoraList(params.lora)
  const stackStrengths = normalizeLoraStrengths(params.loraStrength, stack.length)
  // FastH3 is already the 8 step distillation. A step LoRA (the H3 turbo one)
  // on top of it distils twice, so on FastH3 it is left out; every other LoRA
  // in the stack still patches the model.
  const keep = stack.map((l) => !(fast && H3_STEP_LORA.test(l)))
  const loras = stack.filter((_, i) => keep[i])
  const strengths = stackStrengths.filter((_, i) => keep[i])
  loras.forEach((loraName, i) => {
    const loraId = String(n++)
    workflow[loraId] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { lora_name: loraName, strength_model: strengths[i], model: [modelSrc, 0] },
    }
    modelSrc = loraId
  })

  if (fast) {
    // The official template (video_fastvideo_fasth3_t2v) patches the model with
    // the distilled schedule's shifts (video 10, audio 3, not the base model's
    // 12) and then the VSA sparse attention the checkpoint was trained with
    // (keep 10 percent of the video cubes). The template also picks the comfy
    // kitchen attention for the dense layers; that choice is left to ComfyUI's
    // default because the option is missing on cards that cannot run it.
    const shiftId = String(n++)
    const sparseId = String(n++)
    workflow[shiftId] = { class_type: 'MiniMaxH3SigmaShift', inputs: { model: [modelSrc, 0], shift_video: 10, shift_audio: 3 } }
    workflow[sparseId] = {
      class_type: 'BlockSparseAttention',
      inputs: {
        model: [shiftId, 0], selection: 'vsa', 'selection.keep_percent': 10,
        start_percent: 0.2, end_percent: 1, dense_blocks: '', min_tokens: 12288, extra_tokens: 256,
        sink_conditioning: 'exact_kv_and_rows', verbose: false,
      },
    }
    modelSrc = sparseId
  }

  const encodeInputs: ComfyNodeInputs = { clip: [clipId, 0], vae: [vaeId, 0], prompt: params.prompt, width, height, length }
  if (params.inputImage) {
    // The node stretches a first frame to the canvas; a center crop keeps
    // the picture's proportions instead.
    const imageId = String(n++)
    const scaleId = String(n++)
    workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage } }
    workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: [imageId, 0], upscale_method: 'lanczos', width, height, crop: 'center' } }
    if (isRef2va) encodeInputs['ref_images.ref_image_0'] = [scaleId, 0]
    else encodeInputs.first_frame = [scaleId, 0]
  }
  if (isRef2va) {
    encodeInputs.audio_vae = [audioVaeId, 0]
    encodeInputs.ref_image_size = 'match'
  }
  const encodeId = String(n++)
  workflow[encodeId] = { class_type: encodeNode, inputs: encodeInputs }

  const guiderId = String(n++)
  const schedulerId = String(n++)
  const samplerSelectId = String(n++)
  const noiseId = String(n++)
  const sampleId = String(n++)
  workflow[guiderId] = { class_type: 'BasicGuider', inputs: { model: [modelSrc, 0], conditioning: [encodeId, 0] } }
  // The H3 turbo LoRA says its step count in its name (minimax_h3_fl2v_turbo_
  // 8step_...), and the official template runs it at exactly that (Discord
  // 2026-10-02, a user's ComfyUI screenshot: turbo_steps 8). The
  // slider's 20 or more would only cost time on a 24 GB model.
  const turbo = loras.map((l) => H3_STEP_LORA.exec(l)).find((m) => m)
  // FastH3 is the 8 step checkpoint: the template runs exactly 8.
  const steps = fast ? 8 : turbo ? Number(turbo[1]) : params.steps
  workflow[schedulerId] = { class_type: 'BasicScheduler', inputs: { model: [modelSrc, 0], scheduler: params.scheduler || 'simple', steps, denoise: 1 } }
  workflow[samplerSelectId] = { class_type: 'KSamplerSelect', inputs: { sampler_name: params.sampler || 'res_multistep' } }
  workflow[noiseId] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  workflow[sampleId] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: [noiseId, 0], guider: [guiderId, 0], sampler: [samplerSelectId, 0], sigmas: [schedulerId, 0], latent_image: [encodeId, 1] },
  }

  const decodeId = String(n++)
  const decodeAudioId = String(n++)
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [sampleId, 0], vae: [vaeId, 0] } }
  workflow[decodeAudioId] = { class_type: 'VAEDecodeAudio', inputs: { samples: [sampleId, 0], vae: [audioVaeId, 0] } }

  addVideoWithAudioOutput(workflow, n, decodeId, params.fps || 24, [decodeAudioId, 0], allNodes, params.prompt)
  return workflow
}

/** LTX counts frames in blocks of 8 plus 1 (97 and 121 are the usual ones).
 *  Rounds to the nearest block, never below 9. */
export function snapLtx25Length(frames: number): number {
  const f = Number.isFinite(frames) && frames > 0 ? Math.round(frames) : 121
  return Math.max(9, Math.round((f - 1) / 8) * 8 + 1)
}

/** The two sigma ladders of the distilled model: 8 steps on the half size
 *  picture, then 3 after the latent upscale. Straight from the official
 *  video_ltx2_5_t2v / _i2v templates. */
const LTX25_SIGMAS_FIRST = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0'
const LTX25_SIGMAS_SECOND = '0.85, 0.7250, 0.4219, 0.0'

/**
 * LTX 2.5 (Lightricks, ComfyUI 0.32.0). Picture and sound come out of one
 * model in two passes, wired as the official Comfy-Org templates
 * video_ltx2_5_t2v and video_ltx2_5_i2v do:
 *
 *   pass 1  an empty picture latent at HALF size plus an empty sound latent,
 *           joined (LTXVConcatAVLatent), sampled with the 8 step ladder
 *   upscale the picture half is split off, doubled by the latent upscaler and
 *           joined with the sound half again
 *   pass 2  3 more steps at full size
 *   output  tiled VAE decode for the frames, the audio VAE for the sound,
 *           CreateVideo muxes them
 *
 * A start image (i2v) is cut to the canvas, preprocessed and written into the
 * first frame twice: at strength 0.7 on the half size latent, at 1 after the
 * upscale. The official template also has a prompt enhancer (a second, 5 GB
 * Gemma) and an auto duration head; both are optional there and left out here.
 * Multishot needs nothing in the graph: it is the model's own behaviour.
 */
async function buildLtx25Workflow(params: VideoParams, seed: number, allNodes: NodePresence): Promise<ComfyApiGraph> {
  requireRelease(allNodes, ['LTXVDualCFGGuider'], LTX25_NEEDS_UPDATE, 'ltx25')
  requireNodes(allNodes, [
    'LTXVConditioning', 'EmptyLTXVLatentVideo', 'LTXVEmptyLatentAudio', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent',
    'LTXVLatentUpsampler', 'LatentUpscaleModelLoader', 'LTXVAudioVAEDecode', 'ManualSigmas', 'KSamplerSelect',
    'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecodeTiled', 'CLIPTextEncode',
  ], 'LTX 2.5')
  if (params.inputImage || params.continueFrom) requireNodes(allNodes, ['LTXVImgToVideoInplace', 'LTXVPreprocess', 'LoadImage', 'ImageScale'], 'LTX 2.5 image to video')
  if (params.continueFrom) requireContinueNodes(allNodes, 'ltx25')

  // The graph is the distilled one. The dev weights need a different schedule
  // and guidance, and running them on this one gives noise.
  if (/dev/i.test(params.model) && !/distilled/i.test(params.model)) {
    throw new WorkflowUnavailableError(
      'LU runs the distilled LTX 2.5 model. Pick the file with "distilled" in its name.',
      'ltx25',
    )
  }

  // The first pass runs at half size, so the final canvas must halve onto the
  // 32 pixel grid the video VAE works on: multiples of 64.
  const snap64 = (v: number | undefined, def: number) => Math.max(256, Math.round(((v && v > 0) ? v : def) / 64) * 64)
  const width = snap64(params.width, 1280)
  const height = snap64(params.height, 704)
  const length = snapLtx25Length(params.frames || 121)
  const fps = params.fps || 24

  const [clipName, vaeName, audioVaeName] = await Promise.all([
    findMatchingCLIP('ltx25', params.model),
    findMatchingVAE('ltx25'),
    findLtx25AudioVAE(),
  ])
  const upscalerName = nodeComboOptions(allNodes, 'LatentUpscaleModelLoader', 'model_name')
    .find((m) => /ltx[._\- ]?2[._\- ]?5/i.test(m) && /spatial/i.test(m))
  if (!upscalerName) {
    throw new Error('No LTX 2.5 latent upscaler found. Download "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" from the Model Manager.')
  }

  const workflow: ComfyApiGraph = {}
  let n = 1
  const add = (class_type: string, inputs: ComfyNodeInputs): string => {
    const id = String(n++)
    workflow[id] = { class_type, inputs }
    return id
  }

  // The small variant is a GGUF quant (ComfyUI-GGUF), the full one a safetensors file.
  const unetId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  const clipId = add('CLIPLoader', { clip_name: clipName, type: 'ltxv', device: 'default' })
  const vaeId = add('VAELoader', { vae_name: vaeName })
  const audioVaeId = add('VAELoader', { vae_name: audioVaeName })
  const upscaleLoaderId = add('LatentUpscaleModelLoader', { model_name: upscalerName })

  const posId = add('CLIPTextEncode', { text: params.prompt, clip: [clipId, 0] })
  const negId = add('CLIPTextEncode', { text: params.negativePrompt || '', clip: [clipId, 0] })
  const condId = add('LTXVConditioning', { positive: [posId, 0], negative: [negId, 0], frame_rate: fps })

  // A continued section (B18) pins the last frames of the clip so far, an
  // 8n+1 run (17 frames are three latent frames), instead of one picture,
  // and pins them fully in both passes: they are frames that already exist.
  let imageSrc: string | null = null
  let continued: ContinueSource | null = null
  if (params.continueFrom) {
    continued = addContinueSource(workflow, n, params.continueFrom, allNodes)
    n = continued.n
    const scaleId = add('ImageScale', { image: continued.tail, upscale_method: 'lanczos', width, height, crop: 'center' })
    imageSrc = add('LTXVPreprocess', { image: [scaleId, 0], img_compression: 18 })
  } else if (params.inputImage) {
    const loadId = add('LoadImage', { image: params.inputImage })
    const scaleId = add('ImageScale', { image: [loadId, 0], upscale_method: 'lanczos', width, height, crop: 'center' })
    imageSrc = add('LTXVPreprocess', { image: [scaleId, 0], img_compression: 18 })
  }
  const pin = (latent: string, strength: number): string =>
    imageSrc
      ? add('LTXVImgToVideoInplace', { vae: [vaeId, 0], image: [imageSrc, 0], latent: [latent, 0], strength: continued ? 1 : strength, bypass: false })
      : latent

  // One pass past one window: context windows on the model (LTXVContextWindows).
  let model: [string, number] = [unetId, 0]
  if (params.contextWindows && !continued) {
    const win = addContextWindows(workflow, n, model, 'ltx25', length, allNodes)
    n = win.n
    model = win.model
  }

  // Pass 1: half size.
  const emptyId = add('EmptyLTXVLatentVideo', { width: width / 2, height: height / 2, length, batch_size: 1 })
  const videoLatent1 = pin(emptyId, 0.7)
  const audioLatentId = add('LTXVEmptyLatentAudio', { frames_number: length, frame_rate: fps, batch_size: 1, audio_vae: [audioVaeId, 0] })
  const joint1 = add('LTXVConcatAVLatent', { video_latent: [videoLatent1, 0], audio_latent: [audioLatentId, 0] })
  const guider1 = add('LTXVDualCFGGuider', { model, positive: [condId, 0], negative: [condId, 1], video_cfg: 1, audio_cfg: 1 })
  const sampler1 = add('KSamplerSelect', { sampler_name: 'euler_ancestral' })
  const sigmas1 = add('ManualSigmas', { sigmas: LTX25_SIGMAS_FIRST })
  const noise1 = add('RandomNoise', { noise_seed: seed })
  const sample1 = add('SamplerCustomAdvanced', {
    noise: [noise1, 0], guider: [guider1, 0], sampler: [sampler1, 0], sigmas: [sigmas1, 0], latent_image: [joint1, 0],
  })
  const split1 = add('LTXVSeparateAVLatent', { av_latent: [sample1, 0] })

  // Upscale the picture half, keep the sound half.
  const upscaled = add('LTXVLatentUpsampler', { samples: [split1, 0], upscale_model: [upscaleLoaderId, 0], vae: [vaeId, 0] })
  const videoLatent2 = pin(upscaled, 1)
  const joint2 = add('LTXVConcatAVLatent', { video_latent: [videoLatent2, 0], audio_latent: [split1, 1] })

  // Pass 2: full size.
  const guider2 = add('LTXVDualCFGGuider', { model, positive: [condId, 0], negative: [condId, 1], video_cfg: 1, audio_cfg: 1 })
  const sampler2 = add('KSamplerSelect', { sampler_name: 'euler_ancestral' })
  const sigmas2 = add('ManualSigmas', { sigmas: LTX25_SIGMAS_SECOND })
  const noise2 = add('RandomNoise', { noise_seed: seed })
  const sample2 = add('SamplerCustomAdvanced', {
    noise: [noise2, 0], guider: [guider2, 0], sampler: [sampler2, 0], sigmas: [sigmas2, 0], latent_image: [joint2, 0],
  })
  const split2 = add('LTXVSeparateAVLatent', { av_latent: [sample2, 0] })

  const decodeId = add('VAEDecodeTiled', { samples: [split2, 0], vae: [vaeId, 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 })
  const audioDecodeId = add('LTXVAudioVAEDecode', { samples: [split2, 1], audio_vae: [audioVaeId, 0] })

  if (continued && params.continueFrom) {
    const joined = addStitch(workflow, n, continued.frames, [decodeId, 0], params.continueFrom.overlap, allNodes)
    n = joined.n
    // The sound so far plus the new sound past the overlap. A clip so far
    // without sound (made elsewhere) keeps only the new part's sound.
    const sound = addAudioStitch(workflow, n, continued.audio, [audioDecodeId, 0], params.continueFrom.overlap / fps, allNodes)
    if (sound) n = sound.n
    addVideoWithAudioOutput(workflow, n, joined.images[0], fps, sound ? sound.audio : [audioDecodeId, 0], allNodes, params.prompt)
    return workflow
  }
  addVideoWithAudioOutput(workflow, n, decodeId, fps, [audioDecodeId, 0], allNodes, params.prompt)
  return workflow
}

// ─── 2.5.8 specialized local lanes (music / talking character / motion) ─────
//
// These intents run on node families that ship with CURRENT ComfyUI cores
// (ACE audio, Wan 2.2 S2V, Wan 2.2 Animate, Wan VACE — verified against the
// July 2026 core). Every builder gates on live node presence and throws
// WorkflowUnavailableError with an "Update ComfyUI" message when the install
// predates the family — REJECT-AND-REPORT, never a broken graph.

export interface LocalOpParams {
  op: 'music' | 'lipsync' | 'motion'
  model: string
  prompt: string
  negativePrompt?: string
  seed: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  width: number
  height: number
  frames: number
  fps: number
  /** music: track length in seconds + optional lyrics. */
  seconds?: number
  lyrics?: string
  /** lipsync: speech audio staged in ComfyUI's input dir + the portrait. */
  audioFile?: string
  refImage?: string
  /** motion: driving video staged in ComfyUI's input dir. */
  drivingVideo?: string
}

const UPDATE_COMFY_HINT =
  'Update ComfyUI (Settings, AI Backends, Update ComfyUI), restart it, then generate again.'

/** The core video nodes a continued section is built from (B18). */
function requireContinueNodes(allNodes: NodePresence, strategy: WorkflowStrategy): void {
  requireRelease(allNodes, ['LoadVideo', 'GetVideoComponents', 'ImageFromBatch'], CONTINUE_NEEDS_UPDATE, strategy)
}

function requireNodes(allNodes: NodePresence, needed: string[], lane: string): void {
  const missing = needed.filter((n) => !allNodes[n])
  if (missing.length > 0) {
    throw new WorkflowUnavailableError(
      `${lane} needs ComfyUI nodes this install does not have yet (${missing.join(', ')}). ${UPDATE_COMFY_HINT}`,
      'unavailable',
      undefined,
      { needsComfyUpdate: true },
    )
  }
}

/** Like requireNodes, for a model that arrived in a known ComfyUI release: the
 *  missing marker node means an older install, and the answer is the update
 *  sentence for THAT model (not a list of node names), flagged so Create offers
 *  the one click update. */
function requireRelease(allNodes: NodePresence, marker: string[], updateSentence: string, strategy: WorkflowStrategy): void {
  if (marker.every((m) => allNodes[m])) return
  throw new WorkflowUnavailableError(updateSentence, strategy, undefined, { needsComfyUpdate: true })
}

/** UNET loader that understands GGUF quants: .gguf files load through the
 *  city96 GGUF pack's UnetLoaderGGUF, everything else through core UNETLoader. */
/** Discord 2026-09-26/28: "Node 1
 *  (CheckpointLoaderSimple): Value not in list". The strategy comes from the
 *  file NAME, and a name LU cannot place ('unknown') falls to the checkpoint
 *  pipeline. For a file that sits in diffusion_models that is a guaranteed
 *  rejection, because CheckpointLoaderSimple only lists models/checkpoints.
 *  Say what is wrong instead. An unreadable enum stays silent, as before. */
function assertCheckpointListed(model: string, allNodes: NodePresence): void {
  const checkpoints = nodeComboOptions(allNodes, 'CheckpointLoaderSimple', 'ckpt_name')
  if (checkpoints.length === 0 || checkpoints.includes(model)) return
  const unets = [
    ...nodeComboOptions(allNodes, 'UNETLoader', 'unet_name'),
    ...nodeComboOptions(allNodes, 'UnetLoaderGGUF', 'unet_name'),
  ]
  throw new WorkflowUnavailableError(
    unets.includes(model)
      ? `LU does not recognize which model family ${model} belongs to, so it has no pipeline for it. It sits in models/diffusion_models, where an SD 1.5 / SDXL checkpoint does not work. Pick another model, or report the file name so LU can learn it.`
      : `${model} is no longer in ComfyUI's model list. It may have been moved or deleted. Pick another model, or restart ComfyUI after adding files.`,
    'checkpoint',
  )
}

/** Discord 2026-09-26: "Node 2 (CLIPLoader): Value not in list".
 *  Newer model families need a CLIPLoader type an older ComfyUI does not have
 *  yet (flux2, krea2, qwen_image). Only checked when the enum is readable. */
function assertClipTypeKnown(clipType: string, type: ModelType, strategy: WorkflowStrategy, allNodes: NodePresence): void {
  const types = nodeComboOptions(allNodes, 'CLIPLoader', 'type')
  if (types.length === 0 || types.includes(clipType)) return
  throw new WorkflowUnavailableError(
    `Your ComfyUI is too old for ${type} models (its text encoder loader has no "${clipType}" type). Update ComfyUI, then try again.`,
    strategy,
    undefined,
    { needsComfyUpdate: true },
  )
}

function addUnetLoader(workflow: ComfyApiGraph, id: string, model: string, allNodes: NodePresence): void {
  if (model.toLowerCase().endsWith('.gguf')) {
    if (!allNodes['UnetLoaderGGUF']) {
      throw new WorkflowUnavailableError(
        'This model is a GGUF quant, which needs the ComfyUI-GGUF node pack. Install it from the model card, or pick the safetensors variant.',
        'unavailable',
        { pack: 'ComfyUI-GGUF', url: 'https://github.com/city96/ComfyUI-GGUF' },
      )
    }
    workflow[id] = { class_type: 'UnetLoaderGGUF', inputs: { unet_name: model } }
  } else {
    workflow[id] = { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } }
  }
}

/** Sound-carrying video output: core CreateVideo muxes the audio track into
 *  the frames, SaveVideo writes an mp4. The talking-character / motion clips
 *  are pointless without their sound, so this path requires the core video
 *  nodes (same family as the lanes themselves — present on any core new
 *  enough to run them). */
function addVideoWithAudioOutput(
  workflow: ComfyApiGraph,
  n: number,
  decodeId: string,
  fps: number,
  audioSrc: [string, number] | null,
  allNodes: NodePresence,
  prompt?: string,
): number {
  requireNodes(allNodes, ['CreateVideo', 'SaveVideo'], 'This video output')
  const createId = String(n++)
  const inputs: ComfyNodeInputs = { images: [decodeId, 0], fps }
  if (audioSrc) inputs.audio = audioSrc
  workflow[createId] = { class_type: 'CreateVideo', inputs }
  const saveId = String(n++)
  workflow[saveId] = {
    class_type: 'SaveVideo',
    inputs: { video: [createId, 0], filename_prefix: promptFilenamePrefix(prompt, true), format: 'auto', codec: 'auto' },
  }
  return n
}

/**
 * YuE2 (m-a-p, ComfyUI 0.36.0). Songs with vocals from a style and lyrics, the
 * graph of the official template audio_yue2_text2music with ABC planning off:
 * the checkpoint's own text model writes the music tokens
 * (YuE2GenerateMusic, which also reports how many seconds it made), a
 * KSampler turns them into audio latents of exactly that length
 * (EmptyYuE2LatentAudio) and the checkpoint's VAE decodes them.
 *
 * The sampler is the template's (32 steps, cfg 1, dpm_2, sgm_uniform) and is
 * pinned: the music sliders are tuned for ACE Step. The prompt is the style,
 * the lyrics field is the lyrics. An empty ABC input makes the node switch to
 * its own "off" mode, as the template does.
 */
function buildYue2Workflow(params: LocalOpParams, seed: number, allNodes: NodePresence): ComfyApiGraph {
  requireRelease(allNodes, ['YuE2GenerateMusic', 'EmptyYuE2LatentAudio'], YUE2_NEEDS_UPDATE, 'unavailable')
  requireNodes(allNodes, ['ConditioningZeroOut', 'KSampler', 'VAEDecodeAudio', 'SaveAudioMP3'], 'Local music')

  const workflow: ComfyApiGraph = {}
  let n = 1
  const seconds = Math.max(5, Math.min(600, params.seconds || 120))

  const ckptId = String(n++)
  workflow[ckptId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } }
  const musicId = String(n++)
  workflow[musicId] = {
    class_type: 'YuE2GenerateMusic',
    inputs: {
      clip: [ckptId, 1], style: params.prompt, lyrics: params.lyrics || '', abc: '', seed, mode: 'full',
      max_duration: seconds, temperature: 1, top_p: 0.95, top_k: 100, repetition_penalty: 1.2,
    },
  }
  const negId = String(n++)
  workflow[negId] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: [musicId, 0] } }
  const latentId = String(n++)
  workflow[latentId] = { class_type: 'EmptyYuE2LatentAudio', inputs: { seconds: [musicId, 1], batch_size: 1 } }
  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [ckptId, 0], positive: [musicId, 0], negative: [negId, 0], latent_image: [latentId, 0],
      seed, steps: 32, cfg: 1.0, sampler_name: 'dpm_2', scheduler: 'sgm_uniform', denoise: 1.0,
    },
  }
  const decodeId = String(n++)
  workflow[decodeId] = { class_type: 'VAEDecodeAudio', inputs: { samples: [samplerId, 0], vae: [ckptId, 2] } }
  const saveId = String(n++)
  workflow[saveId] = {
    class_type: 'SaveAudioMP3',
    inputs: { audio: [decodeId, 0], filename_prefix: promptFilenamePrefix(params.prompt, false), quality: 'V0' },
  }
  return workflow
}

/**
 * Music (ACE-Step). All-in-one checkpoint → ACE text encode (tags + lyrics) →
 * KSampler → VAEDecodeAudio → SaveAudioMP3. ACE-Step 1.5 checkpoints route
 * through the 1.5 encoder/latent pair (different node ids AND different latent
 * shape); everything else uses the v1 pair. Negative conditioning: v1 encodes
 * the negative prompt (cheap), 1.5 zero-outs the positive instead — its
 * encoder runs an LLM pass that would double the cost for no benefit.
 */
export function buildMusicWorkflow(params: LocalOpParams, seed: number, allNodes: NodePresence): ComfyApiGraph {
  if (classifyModel(params.model) === 'yue2') return buildYue2Workflow(params, seed, allNodes)
  const workflow: ComfyApiGraph = {}
  let n = 1
  const isAce15 = /1[._-]?5/.test(params.model.toLowerCase().replace(/\.safetensors$/, '').replace(/^.*ace[_-]?step/, ''))
  const encodeNode = isAce15 ? 'TextEncodeAceStepAudio1.5' : 'TextEncodeAceStepAudio'
  const latentNode = isAce15 ? 'EmptyAceStep1.5LatentAudio' : 'EmptyAceStepLatentAudio'
  requireNodes(allNodes, [encodeNode, latentNode, 'VAEDecodeAudio', 'SaveAudioMP3'], 'Local music')

  const seconds = Math.max(5, Math.min(600, params.seconds || 120))
  const ckptId = String(n++)
  workflow[ckptId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } }

  const posId = String(n++)
  if (isAce15) {
    workflow[posId] = {
      class_type: encodeNode,
      inputs: {
        clip: [ckptId, 1], tags: params.prompt, lyrics: params.lyrics || '',
        seed, bpm: 120, duration: seconds, timesignature: '4', language: 'en',
        keyscale: 'C major', generate_audio_codes: true, cfg_scale: 2.0,
        temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
      },
    }
  } else {
    workflow[posId] = {
      class_type: encodeNode,
      inputs: { clip: [ckptId, 1], tags: params.prompt, lyrics: params.lyrics || '', lyrics_strength: 1.0 },
    }
  }
  const negId = String(n++)
  if (isAce15) {
    workflow[negId] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: [posId, 0] } }
  } else {
    workflow[negId] = {
      class_type: encodeNode,
      inputs: { clip: [ckptId, 1], tags: params.negativePrompt || '', lyrics: '', lyrics_strength: 1.0 },
    }
  }

  const shiftId = String(n++)
  workflow[shiftId] = { class_type: 'ModelSamplingSD3', inputs: { model: [ckptId, 0], shift: 5.0 } }
  const latentId = String(n++)
  workflow[latentId] = { class_type: latentNode, inputs: { seconds, batch_size: 1 } }
  // ACE-Step samples on the flow-match euler/simple pairing, NOT the composer's
  // image-model sampler (dpmpp_2m/karras etc. leaks in through the shared knobs).
  // And the 1.5 TURBO checkpoint is distilled for ~10 steps at cfg 1.0 — the
  // shared 'ace' default (50 steps, cfg 5) overcooks it into near-silence
  // (measured: -43 dB mean output vs -18 dB at the turbo recipe, the owner's "quiet
  // noise" bug). Pin the turbo recipe by name; other ACE checkpoints keep the
  // composer's step/cfg but still sample on euler/simple.
  const isTurbo = /turbo/.test(params.model.toLowerCase())
  const musicSteps = isTurbo ? Math.min(params.steps || 10, 10) : params.steps
  const musicCfg = isTurbo ? 1.0 : params.cfgScale
  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [shiftId, 0], positive: [posId, 0], negative: [negId, 0], latent_image: [latentId, 0],
      seed, steps: musicSteps, cfg: musicCfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
  }
  const decodeId = String(n++)
  workflow[decodeId] = { class_type: 'VAEDecodeAudio', inputs: { samples: [samplerId, 0], vae: [ckptId, 2] } }
  const saveId = String(n++)
  workflow[saveId] = {
    class_type: 'SaveAudioMP3',
    inputs: { audio: [decodeId, 0], filename_prefix: promptFilenamePrefix(params.prompt, false), quality: 'V0' },
  }
  return workflow
}

/**
 * Talking character (Wan 2.2 S2V, core). Portrait + speech audio → the
 * character speaks it. wav2vec2 audio embeddings feed WanSoundImageToVideo;
 * the finished frames are muxed WITH the speech track (CreateVideo), because
 * a silent talking-head clip is useless. Uses the Wan 2.1 VAE + UMT5 encoder
 * (the S2V-14B pairing from the official release).
 *
 * K2 (a user, Discord "HELP WITH MODELS"/help-18,
 * 2026-09-15/17): the CLIP/VAE/audio-encoder filenames below used to be
 * written straight into their loader nodes as literal strings, never checked
 * against what ComfyUI actually has installed. Whichever one the box didn't
 * have failed validation with "Value not in list", specifically Node 3
 * (VAELoader) in the reports, because that is the third node this builder
 * creates. Resolve
 * every one of them against the live enum first (same rule Bug C already
 * applied to the FLUX/video lanes in buildDynamicWorkflow), so a mismatch is
 * caught before /prompt submission with an actionable "download <file>"
 * message instead of ComfyUI's opaque rejection.
 */
export async function buildS2VWorkflow(params: LocalOpParams, seed: number, allNodes: NodePresence): Promise<ComfyApiGraph> {
  const workflow: ComfyApiGraph = {}
  let n = 1
  requireNodes(
    allNodes,
    ['WanSoundImageToVideo', 'AudioEncoderLoader', 'AudioEncoderEncode', 'LoadAudio'],
    'Talking character',
  )
  if (!params.audioFile) throw new Error('Add a voice first. Record, upload or pick an audio track.')
  if (!params.refImage) throw new Error('Add the portrait the character should speak from.')

  const snap16 = (v: number, def: number) => Math.max(16, Math.round(((v && v > 0) ? v : def) / 16) * 16)
  const width = snap16(params.width, 832)
  const height = snap16(params.height, 480)
  const length = snapWanLength(params.frames || 77)

  const [wanClip, wanVae, audioEncoder] = await Promise.all([
    findMatchingCLIP('wan', params.model),
    findMatchingVAE('wan'),
    findMatchingAudioEncoder(),
  ])

  const unetId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  const clipId = String(n++)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: wanClip, type: 'wan', device: 'default' } }
  const vaeId = String(n++)
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: wanVae } }
  const posId = String(n++)
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || 'a person talking naturally, natural expression', clip: [clipId, 0] } }
  const negId = String(n++)
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  const audioLoadId = String(n++)
  workflow[audioLoadId] = { class_type: 'LoadAudio', inputs: { audio: params.audioFile } }
  const audioEncLoadId = String(n++)
  workflow[audioEncLoadId] = { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: audioEncoder } }
  const audioEncId = String(n++)
  workflow[audioEncId] = { class_type: 'AudioEncoderEncode', inputs: { audio_encoder: [audioEncLoadId, 0], audio: [audioLoadId, 0] } }

  const imageId = String(n++)
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.refImage } }
  const scaleId = String(n++)
  workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: [imageId, 0], upscale_method: 'lanczos', width, height, crop: 'center' } }

  const s2vId = String(n++)
  workflow[s2vId] = {
    class_type: 'WanSoundImageToVideo',
    inputs: {
      positive: [posId, 0], negative: [negId, 0], vae: [vaeId, 0],
      width, height, length, batch_size: 1,
      audio_encoder_output: [audioEncId, 0], ref_image: [scaleId, 0],
    },
  }

  const shiftId = String(n++)
  workflow[shiftId] = { class_type: 'ModelSamplingSD3', inputs: { model: [unetId, 0], shift: 8.0 } }
  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [shiftId, 0], positive: [s2vId, 0], negative: [s2vId, 1], latent_image: [s2vId, 2],
      seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
    },
  }
  const decodeId = String(n++)
  workflow[decodeId] = videoDecodeNode([samplerId, 0], [vaeId, 0], 'VAEDecodeTiled' in allNodes)

  addVideoWithAudioOutput(workflow, n, decodeId, params.fps || 16, [audioLoadId, 0], allNodes, params.prompt)
  return workflow
}

/**
 * Motion control. A character image copies the moves of a driving video.
 * Wan 2.2 Animate models take a DWPose skeleton video (pose_video); Wan VACE
 * models take the same skeleton as their control_video — both need the
 * DWPreprocessor from comfyui_controlnet_aux (one-click install; its CPU
 * onnxruntime path works on every Windows box, no GPU wheel roulette).
 * The driving clip's own audio is carried over into the result.
 *
 * K2: same live-list-first fix as buildS2VWorkflow above, since CLIP/VAE
 * were hardcoded literals here too.
 */
export async function buildMotionWorkflow(params: LocalOpParams, seed: number, allNodes: NodePresence): Promise<ComfyApiGraph> {
  const workflow: ComfyApiGraph = {}
  let n = 1
  requireNodes(allNodes, ['LoadVideo', 'GetVideoComponents'], 'Motion control')
  if (!allNodes['DWPreprocessor']) {
    throw new WorkflowUnavailableError(
      'Motion control needs the pose extractor (DWPose) from the controlnet_aux node pack. Install it from the card above, then generate again.',
      'unavailable',
      { pack: 'comfyui_controlnet_aux', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux' },
    )
  }
  if (!params.drivingVideo) throw new Error('Add the driving video whose motion the character should copy.')
  if (!params.refImage) throw new Error('Add the character image that should perform the motion.')

  const isVace = classifyModel(params.model) === 'wanvace'
  requireNodes(allNodes, isVace ? ['WanVaceToVideo', 'TrimVideoLatent'] : ['WanAnimateToVideo', 'TrimVideoLatent'], 'Motion control')

  const snap16 = (v: number, def: number) => Math.max(16, Math.round(((v && v > 0) ? v : def) / 16) * 16)
  const width = snap16(params.width, 832)
  const height = snap16(params.height, 480)
  const length = snapWanLength(params.frames || 77)

  const [wanClip, wanVae] = await Promise.all([
    findMatchingCLIP('wan', params.model),
    findMatchingVAE('wan'),
  ])

  const unetId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  const clipId = String(n++)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: wanClip, type: 'wan', device: 'default' } }
  const vaeId = String(n++)
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: wanVae } }
  const posId = String(n++)
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || 'a person moving naturally, high quality', clip: [clipId, 0] } }
  const negId = String(n++)
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  const videoId = String(n++)
  workflow[videoId] = { class_type: 'LoadVideo', inputs: { file: params.drivingVideo } }
  const componentsId = String(n++)
  workflow[componentsId] = { class_type: 'GetVideoComponents', inputs: { video: [videoId, 0] } }
  const poseId = String(n++)
  workflow[poseId] = {
    class_type: 'DWPreprocessor',
    inputs: {
      image: [componentsId, 0], detect_hand: 'enable', detect_body: 'enable', detect_face: 'enable',
      resolution: Math.min(width, height),
      bbox_detector: 'yolox_l.onnx', pose_estimator: 'dw-ll_ucoco_384.onnx',
    },
  }

  const imageId = String(n++)
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.refImage } }
  const scaleId = String(n++)
  workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: [imageId, 0], upscale_method: 'lanczos', width, height, crop: 'center' } }

  const condId = String(n++)
  if (isVace) {
    workflow[condId] = {
      class_type: 'WanVaceToVideo',
      inputs: {
        positive: [posId, 0], negative: [negId, 0], vae: [vaeId, 0],
        width, height, length, batch_size: 1, strength: 1.0,
        control_video: [poseId, 0], reference_image: [scaleId, 0],
      },
    }
  } else {
    workflow[condId] = {
      class_type: 'WanAnimateToVideo',
      inputs: {
        positive: [posId, 0], negative: [negId, 0], vae: [vaeId, 0],
        width, height, length, batch_size: 1,
        reference_image: [scaleId, 0], pose_video: [poseId, 0],
        continue_motion_max_frames: 5, video_frame_offset: 0,
      },
    }
  }

  const shiftId = String(n++)
  workflow[shiftId] = { class_type: 'ModelSamplingSD3', inputs: { model: [unetId, 0], shift: 8.0 } }
  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [shiftId, 0], positive: [condId, 0], negative: [condId, 1], latent_image: [condId, 2],
      seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
    },
  }
  // Both conditioners prepend reference latents — trim them back out so the
  // decoded clip starts on the motion, not on a frozen reference frame.
  const trimId = String(n++)
  workflow[trimId] = { class_type: 'TrimVideoLatent', inputs: { samples: [samplerId, 0], trim_amount: [condId, 3] } }
  const decodeId = String(n++)
  workflow[decodeId] = videoDecodeNode([trimId, 0], [vaeId, 0], 'VAEDecodeTiled' in allNodes)

  addVideoWithAudioOutput(workflow, n, decodeId, params.fps || 16, [componentsId, 1], allNodes, params.prompt)
  return workflow
}

/**
 * Animate with Wan 2.1 VACE as a reference model (D24): the picture goes into
 * WanVaceToVideo as reference_image, with no control video, so the clip is
 * made from the prompt around the subject instead of starting on the picture.
 * The same conditioner, sampling and trim as the VACE path of
 * buildMotionWorkflow above, only without the pose video and its audio.
 */
export async function buildVaceReferenceWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes, allNodes: NodePresence): Promise<ComfyApiGraph> {
  if (!params.inputImage) throw new Error('Add the reference picture first.')
  requireNodes(allNodes, ['WanVaceToVideo', 'TrimVideoLatent', 'LoadImage', 'ImageScale'], 'Animate with VACE')
  const workflow: ComfyApiGraph = {}
  let n = 1

  const snap16 = (v: number, def: number) => Math.max(16, Math.round(((v && v > 0) ? v : def) / 16) * 16)
  const width = snap16(params.width, 832)
  const height = snap16(params.height, 480)
  const length = snapWanLength(params.frames || 81)

  const [wanClip, wanVae] = await Promise.all([
    findMatchingCLIP('wan', params.model),
    findMatchingVAE('wan'),
  ])

  const unetId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  const clipId = String(n++)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: wanClip, type: 'wan', device: 'default' } }
  const vaeId = String(n++)
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: wanVae } }
  const posId = String(n++)
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || 'the subject moving naturally, high quality', clip: [clipId, 0] } }
  const negId = String(n++)
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  const imageId = String(n++)
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage } }
  const scaleId = String(n++)
  workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: [imageId, 0], upscale_method: 'lanczos', width, height, crop: 'center' } }

  const condId = String(n++)
  workflow[condId] = {
    class_type: 'WanVaceToVideo',
    inputs: {
      positive: [posId, 0], negative: [negId, 0], vae: [vaeId, 0],
      width, height, length, batch_size: 1, strength: 1.0,
      reference_image: [scaleId, 0],
    },
  }

  const shiftId = String(n++)
  workflow[shiftId] = { class_type: 'ModelSamplingSD3', inputs: { model: [unetId, 0], shift: 8.0 } }
  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [shiftId, 0], positive: [condId, 0], negative: [condId, 1], latent_image: [condId, 2],
      seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
    },
  }
  // The reference rides in front of the clip as extra latent frames; the trim
  // takes them out again so the video does not open on a still of it.
  const trimId = String(n++)
  workflow[trimId] = { class_type: 'TrimVideoLatent', inputs: { samples: [samplerId, 0], trim_amount: [condId, 3] } }
  const decodeId = String(n++)
  workflow[decodeId] = videoDecodeNode([trimId, 0], [vaeId, 0], 'VAEDecodeTiled' in allNodes)

  addVideoOutput(workflow, n, decodeId, params.fps || 16, nodes, params.prompt)
  return workflow
}

/** Entry point for the specialized local lanes — fetches the live node
 *  catalogue once and dispatches to the lane's builder. */
export async function buildLocalOpWorkflow(params: LocalOpParams): Promise<ComfyApiGraph> {
  const allNodes = await getAllNodeInfo()
  const seed = resolveRunSeed(params.seed)
  switch (params.op) {
    case 'music': return buildMusicWorkflow(params, seed, allNodes)
    case 'lipsync': return await buildS2VWorkflow(params, seed, allNodes)
    case 'motion': return await buildMotionWorkflow(params, seed, allNodes)
  }
}

async function buildFramePackWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Promise<ComfyApiGraph> {
  const workflow: ComfyApiGraph = {}
  let n = 1

  const modelId = String(n++)
  const clipId = String(n++)
  const clipVisionId = String(n++)
  const vaeId = String(n++)
  const imageId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  // VRAM-safe load (2026-06-11, live OOM on his RTX 3060 12GB):
  // `quantization:'disabled' + base_precision:'bf16' + load_device:'main_device'`
  // UPCAST the fp8 13B weights to bf16 (~26 GB) and put the whole transformer on
  // the GPU at once → torch.OutOfMemoryError in LoadFramePackModel before a single
  // step ran. The file is already fp8_e4m3fn, so keep it quantized and load to the
  // OFFLOAD (CPU) device — FramePack's section sampler streams it onto the GPU a
  // window at a time (gpu_memory_preservation governs the headroom). This is the
  // documented low-VRAM combo and is what makes FramePack actually run on 12 GB
  // (and down to ~6 GB) instead of OOMing on every consumer card.
  workflow[modelId] = { class_type: 'LoadFramePackModel', inputs: { model: params.model, base_precision: 'bf16', quantization: 'fp8_e4m3fn', load_device: 'offload_device' } }
  // DualCLIPLoader with type "hunyuan_video": CLIPLoader type "wan" creates Llama2 with
  // 128256 vocab but llava_llama3 has 128320 tokens, causing a state_dict size mismatch.
  // DualCLIPLoader handles both correctly. K2 (Punkt 2): both names used to be hardcoded
  // literals, resolved now via findFramePackCLIPPair against the live CLIP enum.
  const framePackClips = await findFramePackCLIPPair()
  workflow[clipId] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: framePackClips.clipL, clip_name2: framePackClips.llavaLlama3, type: 'hunyuan_video' } }
  // K2: was a hardcoded literal never checked against the live CLIPVisionLoader
  // enum, same "Value not in list" failure mode as the VAE below, just for a
  // different node. Resolved against the live list like the VAE already is.
  workflow[clipVisionId] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: await findMatchingClipVision() } }
  // FramePack is a HunyuanVideo 1.0 model. Its sampler allocates the history
  // buffer with 16 latent channels, and the HunyuanVideo 1.5 VAE encodes 32, so
  // pairing the two dies at the first section with "Expected size 32 but got
  // size 16" (D#104). `6fb83d31` pinned this to the 1.5 file while
  // fixing unrelated filename typos, which broke every FramePack run since.
  //
  // Resolved against the disk rather than pinned again: the resolver refuses a
  // 1.5 VAE outright and names the file to fetch, so a customer whose bundle
  // predates this fix reads "download hunyuan_video_vae_bf16" instead of a raw
  // ComfyUI "value not in list" for a filename he never chose.
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: await findMatchingVAE('framepack') } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  // Scale the source to the resolved generation size before encoding (the owner
  // 2026-06-11). FramePack otherwise samples at the full source resolution
  // (a 1024×1024 still → very slow + heavy on a 12 GB card). resolveI2VResolution
  // already picked an aspect-preserving size capped at 768 / snapped to 16;
  // crop:'center' fills it without distortion. Feeds BOTH the CLIP-vision and
  // VAE encoders so the embeds and latent agree on the framing.
  const fpScaleId = String(n++)
  workflow[fpScaleId] = {
    class_type: 'ImageScale',
    inputs: { image: [imageId, 0], upscale_method: 'lanczos', width: params.width || 640, height: params.height || 640, crop: 'center' },
  }
  // Encode image for CLIP vision embeddings (FramePackSampler image_embeds input)
  const clipVisionEncodeId = String(n++)
  workflow[clipVisionEncodeId] = { class_type: 'CLIPVisionEncode', inputs: { crop: 'center', clip_vision: [clipVisionId, 0], image: [fpScaleId, 0] } }
  // Encode image to latent (FramePackSampler needs LATENT, not IMAGE)
  const vaeEncodeId = String(n++)
  workflow[vaeEncodeId] = { class_type: 'VAEEncode', inputs: { pixels: [fpScaleId, 0], vae: [vaeId, 0] } }
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  const negId = String(n++)
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: [clipId, 0] } }
  workflow[samplerId] = {
    class_type: 'FramePackSampler',
    inputs: {
      model: [modelId, 0], positive: [posId, 0], negative: [negId, 0],
      start_latent: [vaeEncodeId, 0], image_embeds: [clipVisionEncodeId, 0],
      steps: params.steps, cfg: params.cfgScale || 1.0,
      guidance_scale: 10.0, shift: 3.0, seed, latent_window_size: 9,
      // VideoParams carries `frames` (not `numFrames`) — reading the wrong field
      // pinned every FramePack clip to the 49-frame default and silently ignored
      // the caller's requested length. FramePack is duration-driven, so the clip
      // length = frames / fps seconds.
      total_second_length: (params.frames || 49) / (params.fps || 16),
      gpu_memory_preservation: 6.0, sampler: 'unipc_bh2',
      use_teacache: true, teacache_rel_l1_thresh: 0.15,
    },
  }
  workflow[decodeId] = videoDecodeNode([samplerId, 0], [vaeId, 0], nodes.decoders.includes('VAEDecodeTiled'))

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

// buildPyramidFlowWorkflow and buildAllegroWorkflow deleted 2026-07-24, same
// audit and same reason as buildCogVideoWorkflow above. Pyramid Flow named the
// loader PyramidFlowModelLoader (registered as PyramidFlowTransformerLoader),
// decoded through a PyramidFlowDecode that does not exist, and fed the sampler
// steps and frames where it wants prompt_embeds and per stage step strings.
// Allegro followed the identical invented shape against a wrapper we have never
// had installed. Both are recoverable from git history for a rebuild.
