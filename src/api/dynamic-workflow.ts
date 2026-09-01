import { classifyModel, findMatchingVAE, findMatchingCLIP, findFluxCLIPPair } from './comfyui'
import type { ModelType, GenerateParams, VideoParams } from './comfyui'
import { log } from '../lib/logger'
import { resolveRunSeed } from '../lib/run-seed'
import { readComboOptions } from './comfyui-enum'
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
import { promptFilenamePrefix, videoDecodeNode } from './comfyui-graph'

// ─── Strategy Detection ───

export type WorkflowStrategy =
  | 'unet_flux'       // FLUX 1: UNETLoader + CLIPLoader + VAELoader + EmptySD3LatentImage
  | 'unet_flux2'      // FLUX 2: UNETLoader + CLIPLoader + VAELoader + EmptyFlux2LatentImage
  | 'unet_zimage'     // Z-Image: UNETLoader + CLIPLoader(qwen_image) + VAELoader + EmptySD3LatentImage
  | 'unet_ernie_image' // ERNIE-Image: UNETLoader + CLIPLoader(flux2) + VAELoader + EmptyFlux2LatentImage + ConditioningZeroOut
  | 'unet_video'      // Wan/Hunyuan: UNETLoader + CLIPLoader + VAELoader + EmptyHunyuanLatentVideo
  | 'wan22'           // Wan 2.2 TI2V-5B: UNET + CLIP + Wan 2.2 VAE + Wan22ImageToVideoLatent (unified T2V/I2V)
  | 'unet_ltx'        // LTX Video: UNETLoader + CLIPLoader + EmptyLTXVLatentVideo
  | 'unet_mochi'      // Mochi: UNETLoader + CLIPLoader + VAELoader + EmptyMochiLatentVideo
  | 'unet_cosmos'     // Cosmos: UNETLoader + CLIPLoader(oldt5) + VAELoader + EmptyCosmosLatentVideo
  | 'svd'             // SVD: ImageOnlyCheckpointLoader + SVD_img2vid_Conditioning
  | 'framepack'       // FramePack: Kijai wrapper + image input
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
   * link so users like vvvxxxvvv_80435 (CogVideoX 1.5 5B → UNETLoader
   * mismatch on v2.4.3) get a clear next step instead of just a
   * blocking error. (Bug #6)
   */
  installHint?: { pack: string; url: string }
}

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

  // Z-Image → UNET + CLIPLoader(qwen_image) + VAE + SD3LatentImage
  if (modelType === 'zimage') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_zimage', reason: 'Z-Image model → UNETLoader + CLIPLoader(qwen_image)' }
    }
    return { strategy: 'unavailable', reason: 'Z-Image requires UNETLoader + CLIPLoader + VAELoader nodes' }
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

  // LTX Video → UNET + LTXVLatentVideo (no separate VAE needed)
  if (modelType === 'ltx') {
    if (hasUNET && hasCLIPLoader) {
      return { strategy: 'unet_ltx', reason: 'LTX Video → UNETLoader + EmptyLTXVLatentVideo' }
    }
    return { strategy: 'unavailable', reason: 'LTX Video requires UNETLoader + CLIPLoader nodes' }
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
  // 2026-07-24 (bob80817-dev, D#88 "it says I'm missing custom nodes, but they
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

  // Last resort: try UNET if available
  if (hasUNET && hasCLIPLoader && hasVAELoader) {
    return { strategy: 'unet_flux', reason: 'Fallback to UNETLoader (no checkpoint loader)' }
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
  constructor(message: string, strategy: WorkflowStrategy, installHint?: { pack: string; url: string }) {
    super(message)
    this.name = 'WorkflowUnavailableError'
    this.strategy = strategy
    this.installHint = installHint
  }
}

/**
 * Probe ComfyUI for the video output node we need. When neither VHS nor
 * SaveAnimatedWEBP is present, the workflow will fall back to SaveImage
 * (single frames on disk) — Turbulent_Tomato7559's "videos generate as
 * .webp" was caused by VHS missing while SaveAnimatedWEBP still produced
 * an animated still. UI calls this BEFORE Generate so users see a banner
 * rather than discovering after the fact.
 */
export async function checkVideoOutputCapability(): Promise<{ mp4Capable: boolean; webpOnly: boolean; missingNodes: string[] }> {
  const allNodes = await getAllNodeInfo()
  const cats = categorizeNodes(allNodes)
  const hasVHS = cats.videoSavers.includes('VHS_VideoCombine')
  const hasWebp = cats.videoSavers.includes('SaveAnimatedWEBP')
  const missing: string[] = []
  if (!hasVHS) missing.push('VHS_VideoCombine (ComfyUI-VideoHelperSuite)')
  return {
    mp4Capable: hasVHS,
    webpOnly: !hasVHS && hasWebp,
    missingNodes: missing,
  }
}

/** Multi-LoRA (konata 2026-06-09) — normalize the `lora` param into an
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
    const hit = resolveOneLora(req, installed)
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

function resolveOneLora(req: string, installed: string[]): string | null {
  if (installed.includes(req)) return req
  const norm = (s: string) =>
    s.toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '').replace(/\\/g, '/')
  // Separator-insensitive form: users/LLMs say "pixel art" for
  // "pixel-art-xl.safetensors" — spaces, dashes and underscores all collapse.
  const loose = (s: string) => norm(s).replace(/[-_\s]+/g, '')
  const rq = norm(req)
  let hits = installed.filter((c) => norm(c) === rq)
  if (hits.length === 1) return hits[0]
  // Enum entries can be "subfolder/name.safetensors" — try basename equality.
  const rqBase = rq.split('/').pop() || rq
  hits = installed.filter((c) => (norm(c).split('/').pop() || '') === rqBase)
  if (hits.length === 1) return hits[0]
  // Unique substring either way round (separator-insensitive).
  const rqLoose = loose(req)
  hits = installed.filter((c) => loose(c).includes(rqLoose) || rqLoose.includes(loose(c)))
  if (hits.length === 1) return hits[0]
  return null
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

  const { strategy, reason, installHint } = determineStrategy(type, isVideo, nodes, models)
  log.info(`[dynamic-workflow] Strategy: ${strategy} (${reason})`)

  if (strategy === 'unavailable') {
    throw new WorkflowUnavailableError(reason, strategy, installHint)
  }

  // Local Edit (mask inpaint) runs on the SDXL/SD1.5 checkpoint pipeline only.
  // Reject other strategies explicitly instead of silently dropping the mask —
  // the pre-2.5.7 behavior was exactly that: a masked edit fell through to
  // plain img2img and repainted the WHOLE image.
  if (!isVideo && gp.inputImage && gp.maskImage && strategy !== 'checkpoint') {
    throw new WorkflowUnavailableError(
      'Local image editing needs an SD 1.5 / SDXL checkpoint. Pick a checkpoint model for Edit. FLUX and video models are not wired for local inpaint.',
      strategy,
    )
  }

  const seed = resolveRunSeed(params.seed)

  // ─── Wrapper Strategies (custom node pipelines — completely different node chains) ───

  if (strategy === 'svd') {
    return buildSVDWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'wan22') {
    return buildWan22Workflow(params as VideoParams, seed, nodes, allNodes)
  }
  if (strategy === 'framepack') {
    return await buildFramePackWorkflow(params as VideoParams, seed, nodes)
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

  } else if (strategy === 'unet_flux' || strategy === 'unet_flux2' || strategy === 'unet_zimage' || strategy === 'unet_ernie_image' || strategy === 'unet_video' || strategy === 'unet_ltx'
    || strategy === 'unet_mochi' || strategy === 'unet_cosmos') {
    // Separate loaders
    const unetId = String(n++)
    const clipId = String(n++)

    const clipType = type === 'zimage' ? 'qwen_image'
      : type === 'ernie_image' ? 'flux2'
      : type === 'flux2' ? 'flux2'
      : type === 'flux' ? 'flux'
      : type === 'ltx' ? 'ltxv'
      : (type === 'wan' || type === 'hunyuan') ? 'wan'
      : type === 'mochi' ? 'mochi'
      : type === 'cosmos' ? 'cosmos'
      : 'flux'

    // Resolve the text encoder from the LIVE ComfyUI node enum. CRITICAL
    // (Bug C / aldrich "CLIPLoader: Value not in list"): do NOT silently fall
    // back to models.clips[0] / '' on a miss — an empty or wrong clip_name makes
    // ComfyUI reject the prompt with that exact cryptic error. The resolvers
    // throw actionable "download <encoder>" messages; propagate them as a
    // WorkflowUnavailableError so the user gets the download hint instead of a
    // raw rejection. Pass the active UNet filename so the resolver prefers the
    // matching quant tier (fp4 model → fp4 encoder; fp8/bf16 → full precision).
    //
    // C2 (aldrich follow-up, v2.5.3 fix #5): modern ComfyUI (v0.12.0 confirmed)
    // removed 'flux' from the single CLIPLoader's type enum — FLUX v1 text
    // encoding lives in DualCLIPLoader (clip_name1 = T5-XXL, clip_name2 =
    // CLIP-L, type 'flux'), which has shipped with every FLUX-era ComfyUI.
    // Emit it whenever the instance has the node; the single-CLIPLoader path
    // stays as the fallback for pre-FLUX-era instances (whose CLIPLoader enum
    // still contains 'flux'). Same pattern as the HunyuanVideo DualCLIPLoader
    // below.
    const useDualFluxClip = type === 'flux' && nodes.loaders.includes('DualCLIPLoader')

    let clip = ''
    let fluxPair: { t5: string; clipL: string } | null = null
    if (useDualFluxClip) {
      try {
        fluxPair = await findFluxCLIPPair()
      } catch (clipErr) {
        throw new WorkflowUnavailableError(
          clipErr instanceof Error ? clipErr.message : 'Required text encoder not found in ComfyUI.',
          strategy,
        )
      }
    } else {
      try {
        clip = await findMatchingCLIP(type, params.model)
      } catch (clipErr) {
        throw new WorkflowUnavailableError(
          clipErr instanceof Error ? clipErr.message : 'Required text encoder not found in ComfyUI.',
          strategy,
        )
      }
    }

    // VAE is only loaded for strategies with a separate VAELoader — LTX bakes it
    // into the pipeline, so a missing VAE there is fine. Validate (same
    // no-silent-fallback rule) only when it will actually be used.
    const needsVAELoader = strategy !== 'unet_ltx'
    let vae = ''
    if (needsVAELoader) {
      try {
        vae = await findMatchingVAE(type)
      } catch (vaeErr) {
        throw new WorkflowUnavailableError(
          vaeErr instanceof Error ? vaeErr.message : 'Required VAE not found in ComfyUI.',
          strategy,
        )
      }
    }

    addUnetLoader(workflow, unetId, params.model, allNodes)
    workflow[clipId] = useDualFluxClip && fluxPair
      ? {
          class_type: 'DualCLIPLoader',
          inputs: { clip_name1: fluxPair.t5, clip_name2: fluxPair.clipL, type: 'flux' },
        }
      : {
          class_type: 'CLIPLoader',
          inputs: { clip_name: clip, type: clipType, device: 'default' },
        }

    let vaeId: string
    if (needsVAELoader) {
      vaeId = String(n++)
      workflow[vaeId] = {
        class_type: 'VAELoader',
        inputs: { vae_name: vae },
      }
    } else {
      vaeId = unetId // fallback reference (won't be used for LTX)
    }

    modelNodeId = unetId
    clipSourceId = clipId
    clipOutputSlot = 0
    vaeSourceId = vaeId
    vaeOutputSlot = 0
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
  // LoRA chain (cinemazverev GH#4; multi-LoRA konata 2026-06-09): each
  // LoraLoader takes (model, clip) and outputs new (model, clip) — chaining
  // N loaders applies the LoRAs in order, exactly like stacking them in the
  // ComfyUI graph editor. We rewire both refs after every link so the rest
  // of the pipeline sees the fully-stacked versions. Names are resolved
  // against ComfyUI's real LoraLoader enum (fuzzy: extension/case optional)
  // and a miss throws an actionable error instead of ComfyUI's opaque
  // "Value not in list".
  //
  // VAE override (vanja-san GH#4): VAELoader replaces vaeSourceId. The
  // checkpoint's bundled VAE stays unused.
  //
  // Skip CLIP (vanja-san GH#4): CLIPSetLastLayer takes a negative
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
    const vaeId = String(n++)
    workflow[vaeId] = {
      class_type: 'VAELoader',
      inputs: { vae_name: params.vae },
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

  const posId = String(n++)
  const negId = String(n++)

  workflow[posId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: params.prompt, clip: [clipSourceId, clipOutputSlot] },
  }

  if (strategy === 'unet_ernie_image') {
    // ERNIE-Image uses ConditioningZeroOut for negative (NOT CLIPTextEncode)
    workflow[negId] = {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: [posId, 0] },
    }
  } else {
    workflow[negId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: params.negativePrompt || '',
        clip: [clipSourceId, clipOutputSlot],
      },
    }
  }

  // ─── Phase 3: Latent Initialization ───
  // Inpaint mode (local Edit): source + painted mask on the checkpoint path.
  // Takes precedence over plain I2I — a mask means "repaint THIS area", never
  // "repaint everything". Ported 1:1 from the web app's tested builder
  // (create-workflows.ts): same node classes, same defaults.
  const isInpaint = !isVideo && !!gp.inputImage && !!gp.maskImage && strategy === 'checkpoint'
  // I2I mode: LoadImage → VAEEncode instead of empty latent
  const isI2I = !isVideo && !isInpaint && params.inputImage && (params.denoise ?? 1.0) < 1.0

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

  // ─── I2V override (Animate — local lane restored, David 2026-07-17) ───
  // A video request carrying an inputImage swaps the empty latent for the
  // family's image-to-video conditioning node. Covers every family core
  // ComfyUI can animate on this main path (WAN i2v, Hunyuan i2v, LTX,
  // Cosmos); wan22/SVD/FramePack already handle the image in their dedicated
  // builders above. Wiring is schema-driven — we only feed inputs the live
  // node declares and map outputs by their declared types — so version drift
  // in these nodes degrades to a ComfyUI validation error, not a bad graph.
  const isI2V = isVideo && !!(params as GenerateParams).inputImage
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
      )
    }
    const loadId = String(n++)
    workflow[loadId] = { class_type: 'LoadImage', inputs: { image: (params as GenerateParams).inputImage } }
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
    if (decl.start_image) inputs.start_image = [loadId, 0]
    else if (decl.image) inputs.image = [loadId, 0]
    else if (decl.init_image) inputs.init_image = [loadId, 0]
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

  // ─── Phase 4: Sampling ───

  const samplerId = String(n++)

  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [samplerModelId, 0],
      positive: positiveRef,
      negative: negativeRef,
      latent_image: latentRef,
      seed,
      steps: params.steps,
      cfg: params.cfgScale,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: isInpaint ? (params.denoise ?? 0.85) : isI2I ? (params.denoise ?? 0.7) : 1.0,
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

  const saveId = String(n++)

  if (isVideo) {
    // Video output: prefer VHS > SaveAnimatedWEBP > SaveImage
    const vidPrefix = promptFilenamePrefix(params.prompt, true)
    if (nodes.videoSavers.includes('VHS_VideoCombine')) {
      workflow[saveId] = {
        class_type: 'VHS_VideoCombine',
        inputs: {
          images: [decodeId, 0],
          frame_rate: videoParams.fps,
          loop_count: 0,
          filename_prefix: vidPrefix,
          format: 'video/h264-mp4',
          pingpong: false,
          save_output: true,
        },
      }
    } else if (nodes.videoSavers.includes('SaveAnimatedWEBP')) {
      workflow[saveId] = {
        class_type: 'SaveAnimatedWEBP',
        inputs: {
          images: [decodeId, 0],
          filename_prefix: vidPrefix,
          fps: videoParams.fps,
          lossless: false,
          quality: 90,
          method: 'default',
        },
      }
    } else {
      workflow[saveId] = {
        class_type: 'SaveImage',
        inputs: {
          images: [decodeId, 0],
          filename_prefix: vidPrefix,
        },
      }
    }
  } else {
    workflow[saveId] = {
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
  const saveId = String(n++)
  const prefix = promptFilenamePrefix(prompt, true)
  if (nodes.videoSavers.includes('VHS_VideoCombine')) {
    workflow[saveId] = {
      class_type: 'VHS_VideoCombine',
      inputs: { images: [decodeId, 0], frame_rate: fps, loop_count: 0, filename_prefix: prefix, format: 'video/h264-mp4', pingpong: false, save_output: true },
    }
  } else if (nodes.videoSavers.includes('SaveAnimatedWEBP')) {
    workflow[saveId] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: { images: [decodeId, 0], filename_prefix: prefix, fps, lossless: false, quality: 90, method: 'default' },
    }
  } else {
    workflow[saveId] = {
      class_type: 'SaveImage',
      inputs: { images: [decodeId, 0], filename_prefix: prefix },
    }
  }
  return n
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
  // Aspect-fill the source into the SVD generation resolution (David 2026-06-11:
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
 * Wan 2.2 TI2V-5B — one model, both modes. `Wan22ImageToVideoLatent` takes an
 * OPTIONAL `start_image`: present → image-to-video (the clip opens on the source
 * still), absent → text-to-video. Uses the Wan 2.2 VAE (NOT the 2.1 VAE — the 2.2
 * VAE has 16× spatial / 4× temporal compression, a different latent shape) and the
 * shared UMT5-XXL text encoder. `ModelSamplingSD3` applies Wan's sampling shift.
 *
 * I2V faithfulness (David 2026-06-11): an `ImageScale(crop:center)` aspect-fills
 * the source into the generation size, so the first frame matches the still
 * instead of being squished — the same fix proven on the SVD path.
 */
function buildWan22Workflow(params: VideoParams, seed: number, nodes: CategorizedNodes, allNodes: NodePresence): ComfyApiGraph {
  const workflow: ComfyApiGraph = {}
  let n = 1

  // Wan 2.2 dims snap to 32 (VAE spatial grid); length to 4k+1 (temporal stride 4).
  const snap32 = (v: number | undefined, def: number) => Math.max(64, Math.round(((v && v > 0) ? v : def) / 32) * 32)
  const width = snap32(params.width, 1024)
  const height = snap32(params.height, 576)
  const length = snapWanLength(params.frames || 49)

  const unetId = String(n++)
  const clipId = String(n++)
  const vaeId = String(n++)
  const posId = String(n++)
  const negId = String(n++)

  addUnetLoader(workflow, unetId, params.model, allNodes)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } }
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } }
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  // Optional LoRA chain (D#80, game-master0): video LoRAs are model-only, so
  // patch the UNET with LoraLoaderModelOnly (no clip side) before the sampling
  // shift. Guarded on params.lora — a plain Wan 2.2 gen stays byte-identical.
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

  // Unified latent: a start_image is attached ONLY for an I2V request.
  const latentInputs: ComfyNodeInputs = { vae: [vaeId, 0], width, height, length, batch_size: 1 }
  if (params.inputImage) {
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
      model: [shiftId, 0], positive: [posId, 0], negative: [negId, 0], latent_image: [latentId, 0],
      seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
    },
  }
  const decodeId = String(n++)
  workflow[decodeId] = videoDecodeNode([samplerId, 0], [vaeId, 0], nodes.decoders.includes('VAEDecodeTiled'))

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
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

function requireNodes(allNodes: NodePresence, needed: string[], lane: string): void {
  const missing = needed.filter((n) => !allNodes[n])
  if (missing.length > 0) {
    throw new WorkflowUnavailableError(
      `${lane} needs ComfyUI nodes this install does not have yet (${missing.join(', ')}). ${UPDATE_COMFY_HINT}`,
      'unavailable',
    )
  }
}

/** UNET loader that understands GGUF quants: .gguf files load through the
 *  city96 GGUF pack's UnetLoaderGGUF, everything else through core UNETLoader. */
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
 * Music (ACE-Step). All-in-one checkpoint → ACE text encode (tags + lyrics) →
 * KSampler → VAEDecodeAudio → SaveAudioMP3. ACE-Step 1.5 checkpoints route
 * through the 1.5 encoder/latent pair (different node ids AND different latent
 * shape); everything else uses the v1 pair. Negative conditioning: v1 encodes
 * the negative prompt (cheap), 1.5 zero-outs the positive instead — its
 * encoder runs an LLM pass that would double the cost for no benefit.
 */
export function buildMusicWorkflow(params: LocalOpParams, seed: number, allNodes: NodePresence): ComfyApiGraph {
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
  // (measured: -43 dB mean output vs -18 dB at the turbo recipe, David's "quiet
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
 */
export function buildS2VWorkflow(params: LocalOpParams, seed: number, allNodes: NodePresence): ComfyApiGraph {
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

  const unetId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  const clipId = String(n++)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } }
  const vaeId = String(n++)
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } }
  const posId = String(n++)
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || 'a person talking naturally, natural expression', clip: [clipId, 0] } }
  const negId = String(n++)
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  const audioLoadId = String(n++)
  workflow[audioLoadId] = { class_type: 'LoadAudio', inputs: { audio: params.audioFile } }
  const audioEncLoadId = String(n++)
  workflow[audioEncLoadId] = { class_type: 'AudioEncoderLoader', inputs: { audio_encoder_name: 'wav2vec2_large_english_fp16.safetensors' } }
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
 */
export function buildMotionWorkflow(params: LocalOpParams, seed: number, allNodes: NodePresence): ComfyApiGraph {
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

  const unetId = String(n++)
  addUnetLoader(workflow, unetId, params.model, allNodes)
  const clipId = String(n++)
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } }
  const vaeId = String(n++)
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } }
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

/** Entry point for the specialized local lanes — fetches the live node
 *  catalogue once and dispatches to the lane's builder. */
export async function buildLocalOpWorkflow(params: LocalOpParams): Promise<ComfyApiGraph> {
  const allNodes = await getAllNodeInfo()
  const seed = resolveRunSeed(params.seed)
  switch (params.op) {
    case 'music': return buildMusicWorkflow(params, seed, allNodes)
    case 'lipsync': return buildS2VWorkflow(params, seed, allNodes)
    case 'motion': return buildMotionWorkflow(params, seed, allNodes)
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

  // VRAM-safe load (David 2026-06-11, live OOM on his RTX 3060 12GB):
  // `quantization:'disabled' + base_precision:'bf16' + load_device:'main_device'`
  // UPCAST the fp8 13B weights to bf16 (~26 GB) and put the whole transformer on
  // the GPU at once → torch.OutOfMemoryError in LoadFramePackModel before a single
  // step ran. The file is already fp8_e4m3fn, so keep it quantized and load to the
  // OFFLOAD (CPU) device — FramePack's section sampler streams it onto the GPU a
  // window at a time (gpu_memory_preservation governs the headroom). This is the
  // documented low-VRAM combo and is what makes FramePack actually run on 12 GB
  // (and down to ~6 GB) instead of OOMing on every consumer card.
  workflow[modelId] = { class_type: 'LoadFramePackModel', inputs: { model: params.model, base_precision: 'bf16', quantization: 'fp8_e4m3fn', load_device: 'offload_device' } }
  // DualCLIPLoader with type "hunyuan_video" — CLIPLoader type "wan" creates Llama2 with 128256 vocab
  // but llava_llama3 has 128320 tokens, causing state_dict size mismatch. DualCLIPLoader handles both correctly.
  workflow[clipId] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 'llava_llama3_fp8_scaled.safetensors', type: 'hunyuan_video' } }
  workflow[clipVisionId] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'sigclip_vision_patch14_384.safetensors' } }
  // FramePack is a HunyuanVideo 1.0 model. Its sampler allocates the history
  // buffer with 16 latent channels, and the HunyuanVideo 1.5 VAE encodes 32, so
  // pairing the two dies at the first section with "Expected size 32 but got
  // size 16" (bob80817, D#104). `6fb83d31` pinned this to the 1.5 file while
  // fixing unrelated filename typos, which broke every FramePack run since.
  //
  // Resolved against the disk rather than pinned again: the resolver refuses a
  // 1.5 VAE outright and names the file to fetch, so a customer whose bundle
  // predates this fix reads "download hunyuan_video_vae_bf16" instead of a raw
  // ComfyUI "value not in list" for a filename he never chose.
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: await findMatchingVAE('framepack') } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  // Scale the source to the resolved generation size before encoding (David
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
