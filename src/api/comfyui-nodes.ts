import { comfyuiUrl, localFetch } from './backend'

// ─── Types ───

export interface NodeInputSpec {
  required: Record<string, any>
  optional?: Record<string, any>
}

export interface NodeMetadata {
  input: NodeInputSpec
  output: string[]
  output_tooltips?: string[]
  category?: string
  display_name?: string
  description?: string
}

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

// ─── Cache ───

let nodeInfoCache: Record<string, NodeMetadata> | null = null
let cacheTimestamp = 0
const CACHE_TTL = 300_000 // 5 minutes

// ─── Fetch all node info (cached) ───

export async function getAllNodeInfo(forceRefresh = false): Promise<Record<string, NodeMetadata>> {
  if (!forceRefresh && nodeInfoCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return nodeInfoCache
  }

  const res = await localFetch(comfyuiUrl('/object_info'))
  if (!res.ok) throw new Error(`Failed to fetch node info: ${res.status}`)
  const data = await res.json()

  nodeInfoCache = data
  cacheTimestamp = Date.now()
  console.log(`[comfyui-nodes] Loaded ${Object.keys(data).length} node types`)
  return data
}

export function clearNodeCache() {
  nodeInfoCache = null
  cacheTimestamp = 0
}

// ─── Node existence check (from cache) ───

export function hasNode(name: string): boolean {
  return nodeInfoCache ? name in nodeInfoCache : false
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
    // Conditioning
    ConditioningZeroOut: 'textEncoders',
    // Text encoding
    CLIPTextEncode: 'textEncoders',
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
  const extract = (nodeName: string, fieldName: string): string[] => {
    const spec = allNodes[nodeName]?.input?.required?.[fieldName]
    if (Array.isArray(spec) && Array.isArray(spec[0])) return spec[0]
    return []
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
  if (Array.isArray(spec) && Array.isArray(spec[0])) return spec[0]
  return ['euler']
}

export function getSchedulerOptions(allNodes: Record<string, NodeMetadata>): string[] {
  const spec = allNodes.KSampler?.input?.required?.scheduler
  if (Array.isArray(spec) && Array.isArray(spec[0])) return spec[0]
  return ['normal']
}
