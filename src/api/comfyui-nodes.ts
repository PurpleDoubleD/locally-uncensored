import { log } from '../lib/logger'
import { readComboOptions } from './comfyui-enum'
// Audit W-T2: classifyModel/MODEL_TYPE_DEFAULTS kamen hier per `await import()`
// mitten in getModelCapabilities() herein, „so this module never forms a runtime
// import cycle". Den Kreis gab es (comfyui → dynamic-workflow → comfyui-nodes →
// comfyui), aber er lief über eine Kante, die comfyui.ts gar nicht haben durfte
// — die ist weg (siehe comfyui-graph.ts). comfyui.ts importiert dieses Modul
// nicht, also ist ein ganz normaler statischer Import hier die ehrliche Form.
import { classifyModel, MODEL_TYPE_DEFAULTS } from './comfyui'
import type { ModelType } from './comfyui'
// The /object_info cache lives in comfyui-node-info.ts (3.1.0), so comfy-split.ts
// can read it without the cycle comfyui -> comfy-split -> comfyui-nodes -> comfyui.
import { getAllNodeInfo, resetNodeInfo, cachedNodeInfoHas, CACHE_TTL, type NodeMetadata } from './comfyui-node-info'
export { getAllNodeInfo, type NodeInputSpec, type NodeMetadata } from './comfyui-node-info'

// ─── Types ───

/**
 * One node's declared inputs, straight from ComfyUI's `/object_info`.
 *
 * Each value is an input SPEC, not a value, and its shape depends on the node
 * and on the ComfyUI version: `["INT", { default: 20 }]`, `[["euler","dpmpp_2m"]]`
 * (legacy combo) or `["COMBO", { options: [...] }]` (current). Nothing here may
 * assume which — `readComboOptions` (comfyui-enum.ts) is the one reader that
 * knows all three shapes, and it takes `unknown` for exactly that reason.
 */

export interface CategorizedNodes {
  loaders: string[]
  samplers: string[]
  latentInit: string[]
  textEncoders: string[]
  decoders: string[]
  savers: string[]
  videoSavers: string[]
  motion: string[]
}

export interface AvailableModels {
  checkpoints: string[]
  unets: string[]
  vaes: string[]
  clips: string[]
  motionModels: string[]
}


export function clearNodeCache() {
  resetNodeInfo()
  clearCapabilityCache()
}

// ─── Node existence check (from cache) ───

export function hasNode(name: string): boolean {
  return cachedNodeInfoHas(name)
}

// ─── Categorize available nodes ───

export function categorizeNodes(allNodes: Record<string, NodeMetadata>): CategorizedNodes {
  const result: CategorizedNodes = {
    loaders: [],
    samplers: [],
    latentInit: [],
    textEncoders: [],
    decoders: [],
    savers: [],
    videoSavers: [],
    motion: [],
  }

  const known: Record<string, keyof CategorizedNodes> = {
    // Loaders
    CheckpointLoaderSimple: 'loaders',
    UNETLoader: 'loaders',
    VAELoader: 'loaders',
    CLIPLoader: 'loaders',
    DualCLIPLoader: 'loaders',
    TripleCLIPLoader: 'loaders',
    ImageOnlyCheckpointLoader: 'loaders',
    CLIPVisionLoader: 'loaders',
    LoadImage: 'loaders',
    // Samplers
    KSampler: 'samplers',
    KSamplerAdvanced: 'samplers',
    SamplerCustom: 'samplers',
    // LTX 2.5's guider for a joint picture-and-sound latent. New in ComfyUI
    // 0.32.0, the same release as the LTX 2.5 model patch, so determineStrategy
    // reads its presence as "this ComfyUI can run LTX 2.5".
    LTXVDualCFGGuider: 'samplers',
    // Wrapper samplers (custom nodes)
    CogVideoXSampler: 'samplers',
    FramePackSampler: 'samplers',
    PyramidFlowSampler: 'samplers',
    AllegroSampler: 'samplers',
    // Latent init
    EmptyLatentImage: 'latentInit',
    EmptySD3LatentImage: 'latentInit',
    EmptyFlux2LatentImage: 'latentInit',
    EmptyHunyuanLatentVideo: 'latentInit',
    EmptyLTXVLatentVideo: 'latentInit',
    EmptyMochiLatentVideo: 'latentInit',
    EmptyCosmosLatentVideo: 'latentInit',
    CogVideoXEmptyLatents: 'latentInit',
    // Wan 2.2 TI2V-5B unified latent (optional start_image → I2V, absent → T2V)
    Wan22ImageToVideoLatent: 'latentInit',
    // MiniMax H3: the encode node also builds the joint picture-and-sound
    // latent, so it stands in for the empty latent (ComfyUI PR #15224).
    MiniMaxH3ImageToVideo: 'latentInit',
    // MiniMax H3 Image (ComfyUI 0.45.0): prompt, reference pictures and the
    // empty image latent in one node.
    MiniMaxH3ImageConditioning: 'latentInit',
    // Conditioning
    ConditioningZeroOut: 'textEncoders',
    // Text encoding
    CLIPTextEncode: 'textEncoders',
    // Qwen-Image 2.1's single encode node: prompt AND negative prompt, the
    // reference images, and the matching empty latent. Ships with ComfyUI
    // 0.37.0 and newer; determineStrategy gates the lane on it.
    TextEncodeQwenImage21: 'textEncoders',
    CLIPTextEncodeSDXL: 'textEncoders',
    CogVideoXTextEncode: 'textEncoders',
    PyramidFlowTextEncode: 'textEncoders',
    AllegroTextEncode: 'textEncoders',
    // Decoders
    VAEDecode: 'decoders',
    VAEDecodeTiled: 'decoders',
    CogVideoXVAEDecode: 'decoders',
    PyramidFlowDecode: 'decoders',
    AllegroDecoder: 'decoders',
    // Image savers
    SaveImage: 'savers',
    PreviewImage: 'savers',
    // Video savers
    SaveAnimatedWEBP: 'videoSavers',
    VHS_VideoCombine: 'videoSavers',
    // Core mp4 pair (A19): CreateVideo muxes the frames, SaveVideo writes them
    CreateVideo: 'videoSavers',
    SaveVideo: 'videoSavers',
    // AnimateDiff / Motion
    ADE_LoadAnimateDiffModel: 'motion',
    ADE_ApplyAnimateDiffModelSimple: 'motion',
    ADE_UseEvolvedSampling: 'motion',
    // SVD-specific
    SVD_img2vid_Conditioning: 'motion',
    VideoLinearCFGGuidance: 'motion',
    // Wrapper loaders (custom nodes)
    CogVideoXModelLoader: 'loaders',
    CogVideoXCLIPLoader: 'loaders',
    LoadFramePackModel: 'loaders',
    DownloadAndLoadFramePackModel: 'loaders',
    PyramidFlowModelLoader: 'loaders',
    PyramidFlowVAELoader: 'loaders',
    AllegroModelLoader: 'loaders',
  }

  for (const nodeName of Object.keys(allNodes)) {
    const category = known[nodeName]
    if (category) {
      result[category].push(nodeName)
    }
  }

  return result
}

// ─── Extract available models from node info ───

export function detectAvailableModels(allNodes: Record<string, NodeMetadata>): AvailableModels {
  // Shared reader, both schemas. Hand-reading slot 0 here meant motionModels
  // came back empty on any box where AnimateDiff-Evolved answers in the newer
  // COMBO schema, which is what a real ComfyUI does (see comfyui-enum.ts).
  const extract = (nodeName: string, fieldName: string): string[] => {
    const spec = allNodes[nodeName]?.input?.required?.[fieldName]
    return readComboOptions(spec) ?? []
  }

  return {
    checkpoints: extract('CheckpointLoaderSimple', 'ckpt_name'),
    unets: extract('UNETLoader', 'unet_name'),
    vaes: extract('VAELoader', 'vae_name'),
    clips: extract('CLIPLoader', 'clip_name'),
    motionModels: extract('ADE_LoadAnimateDiffModel', 'model_name'),
  }
}

// ─── Extract sampler/scheduler options ───

export function getSamplerOptions(allNodes: Record<string, NodeMetadata>): string[] {
  const spec = allNodes.KSampler?.input?.required?.sampler_name
  const options = readComboOptions(spec)
  return options && options.length > 0 ? options : ['euler']
}

export function getSchedulerOptions(allNodes: Record<string, NodeMetadata>): string[] {
  const spec = allNodes.KSampler?.input?.required?.scheduler
  const options = readComboOptions(spec)
  return options && options.length > 0 ? options : ['normal']
}

// ─── Model capability discovery (v2.5.0 — "every model fully chat-controllable") ───
//
// Single source of truth for "what can THIS model actually do". Reads the real
// per-field limits/enums from ComfyUI's /object_info instead of hardcoded
// per-model magic numbers. The chat-agent generation path (vram-handoff) calls
// this to (a) thread the user's settings through and (b) REJECT-AND-REPORT a
// request that exceeds the model's real capability with the actual limit, so the
// user/LLM can retry lower (decision 2). Soft-fails to documented fallbacks so a
// missing node/field never breaks generation — worst case we skip a check.

export interface ModelCapabilities {
  modelType: ModelType
  /** Max generatable frames — video models only; undefined for image models. */
  frameRange?: { min: number; max: number }
  /** Max clip length in seconds — for duration-driven models (FramePack) whose node
   *  exposes total_second_length instead of a discrete frame count. */
  maxSeconds?: number
  availableSamplers?: string[]
  availableSchedulers?: string[]
  stepsRange?: { min: number; max: number; default?: number }
  cfgRange?: { min: number; max: number; default?: number }
  widthRange?: { min: number; max: number; step?: number }
  heightRange?: { min: number; max: number; step?: number }
  /**
   * false for wrapper samplers (FramePack) that expose no sampler_name/scheduler
   * enum → callers skip enum validation for them.
   */
  usesKSampler: boolean
  discoveryErrors?: string[]
}

// Per-entry timestamp (not a single shared one) so one model's refresh never
// extends another stale entry's TTL.
let capabilityCache = new Map<string, { caps: ModelCapabilities | null; ts: number }>()

/** Test/refresh hook — also called from clearNodeCache() so a node refresh invalidates caps. */
export function clearCapabilityCache() {
  capabilityCache = new Map()
}

/**
 * Which ComfyUI sampler node carries a family's tunable params, and whether it's
 * a real KSampler (exposes sampler_name/scheduler enums). SVD + AnimateDiff run
 * through KSampler too; FramePackSampler hardcodes its own sampler ('unipc_bh2')
 * and has no scheduler enum, so it is treated as a non-KSampler wrapper.
 */
function getSamplerNodeForCaps(type: ModelType): { node: string; usesKSampler: boolean } {
  switch (type) {
    // cogvideo / pyramidflow / allegro dropped 2026-07-24 with their lanes: the
    // names here were part of the same invention (CogVideoXSampler is not a real
    // class), and those model types can no longer reach a builder anyway.
    case 'framepack': return { node: 'FramePackSampler', usesKSampler: false }
    default: return { node: 'KSampler', usesKSampler: true }
  }
}

export async function getModelCapabilities(model: string): Promise<ModelCapabilities | null> {
  if (!model) return null
  const cached = capabilityCache.get(model)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.caps
  }

  let allNodes: Record<string, NodeMetadata>
  try {
    allNodes = await getAllNodeInfo()
  } catch (e) {
    // /object_info unreachable — caller treats null as "no validation, proceed with defaults".
    log.warn('comfyui_nodes.caps_objectinfo_failed', { err: String(e) })
    return null
  }

  const type = classifyModel(model)
  const caps: ModelCapabilities = { modelType: type, usesKSampler: true, discoveryErrors: [] }

  const numRange = (node: string, field: string): { min: number; max: number; default?: number } | undefined => {
    const spec = allNodes[node]?.input?.required?.[field] ?? allNodes[node]?.input?.optional?.[field]
    if (Array.isArray(spec) && typeof spec[0] === 'string' && spec[1] && typeof spec[1] === 'object') {
      const o = spec[1] as { min?: number; max?: number; default?: number }
      return {
        min: typeof o.min === 'number' ? o.min : 0,
        max: typeof o.max === 'number' ? o.max : 10000,
        default: typeof o.default === 'number' ? o.default : undefined,
      }
    }
    return undefined
  }
  const enumOpts = (node: string, field: string): string[] | undefined => {
    const spec = allNodes[node]?.input?.required?.[field] ?? allNodes[node]?.input?.optional?.[field]
    const options = readComboOptions(spec)
    return options && options.length > 0 ? options : undefined
  }
  const frameFrom = (node: string, field: string, fbMin: number, fbMax: number): { min: number; max: number } => {
    const r = numRange(node, field)
    return r && r.max > 0 ? { min: r.min || 1, max: r.max } : { min: fbMin, max: fbMax }
  }

  // ── Sampler-node params (steps/cfg always; sampler/scheduler only on real KSampler) ──
  const sn = getSamplerNodeForCaps(type)
  caps.usesKSampler = sn.usesKSampler
  if (!allNodes[sn.node]) caps.discoveryErrors!.push(`sampler node ${sn.node} not in /object_info`)
  caps.availableSamplers = enumOpts(sn.node, 'sampler_name')
  caps.availableSchedulers = enumOpts(sn.node, 'scheduler')
  caps.stepsRange = numRange(sn.node, 'steps')
  caps.cfgRange = numRange(sn.node, 'cfg')

  // ── Frame range (video families only; image families leave it undefined) ──
  switch (type) {
    case 'svd':
      caps.frameRange = frameFrom('SVD_img2vid_Conditioning', 'video_frames', 1, 25)
      break
    case 'framepack': {
      // FramePack is DURATION-driven: FramePackSampler exposes total_second_length
      // (seconds), not a discrete frame count. Read the real max (≈120s) from
      // /object_info instead of guessing a frame ceiling — honors "ComfyUI is truth".
      const tsl = numRange('FramePackSampler', 'total_second_length')
      const maxSec = tsl && tsl.max > 0 ? tsl.max : 120
      caps.maxSeconds = maxSec
      // resolveClip works in frames; derive a frame ceiling from the real duration
      // limit (× the 16-fps default) so its frame math stays bounded.
      caps.frameRange = { min: 1, max: Math.max(1, Math.round(maxSec * 16)) }
      if (!tsl) caps.discoveryErrors!.push('framepack total_second_length absent, using 120s fallback')
      break
    }
    case 'wan':
    case 'hunyuan':
    case 'ltx':
    case 'ltx25':
    case 'mochi':
    case 'cosmos': {
      // The latent node types `length` as a generic INT (max ~10000) — meaningless
      // per-model. Derive a sane ceiling from the family defaults (heuristic).
      const d = MODEL_TYPE_DEFAULTS[type] ?? MODEL_TYPE_DEFAULTS.wan
      caps.frameRange = { min: 1, max: Math.max(d.frames * 2, 161) }
      caps.discoveryErrors!.push(`${type} frame cap is a heuristic (defaults×2), not /object_info-derived`)
      break
    }
    default:
      break
  }

  capabilityCache.set(model, { caps, ts: Date.now() })
  return caps
}
