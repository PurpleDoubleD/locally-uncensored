import { classifyModel, findMatchingVAE, findMatchingCLIP, type ModelType } from './comfyui'
import { getAllNodeInfo, categorizeNodes, type CategorizedNodes } from './comfyui-nodes'
import { COMPONENT_REGISTRY } from './discover'

// ─── Pre-Flight Validation ───
// Checks everything BEFORE generation so users get instant feedback on model readiness.

export interface PreflightWarning {
  type: 'unknown_model' | 'size_alignment' | 'high_vram'
  message: string
}

export interface PreflightError {
  type: 'missing_vae' | 'missing_clip' | 'missing_nodes' | 'no_model'
  message: string
  downloadUrl?: string
  downloadFilename?: string
  downloadSubfolder?: string
}

export interface PreflightResult {
  ready: boolean
  modelType: ModelType
  warnings: PreflightWarning[]
  errors: PreflightError[]
  resolvedVAE?: string
  resolvedCLIP?: string
}

export async function preflightCheck(
  modelName: string,
  mode: 'image' | 'video',
  width?: number,
  height?: number,
): Promise<PreflightResult> {
  const warnings: PreflightWarning[] = []
  const errors: PreflightError[] = []
  let resolvedVAE: string | undefined
  let resolvedCLIP: string | undefined

  if (!modelName) {
    return { ready: false, modelType: 'unknown', warnings, errors: [{ type: 'no_model', message: 'No model selected.' }] }
  }

  const modelType = classifyModel(modelName)
  const registry = COMPONENT_REGISTRY[modelType]

  // Warn on unknown model type
  if (modelType === 'unknown') {
    warnings.push({
      type: 'unknown_model',
      message: `Model type not recognized. Using SDXL defaults. Rename the file to include the model type (e.g. "sdxl", "flux", "sd15") for optimal settings.`,
    })
  }

  // Check required nodes
  let nodes: CategorizedNodes | null = null
  try {
    const allNodes = await getAllNodeInfo()
    nodes = categorizeNodes(allNodes)
  } catch {
    return { ready: false, modelType, warnings, errors: [{ type: 'missing_nodes', message: 'Cannot reach ComfyUI to verify nodes.' }] }
  }

  // Models with custom wrapper nodes (Kijai/community custom_nodes)
  const customNodeModels: Record<string, { nodes: string[]; installHint: string }> = {
    framepack: {
      nodes: ['LoadFramePackModel', 'FramePackSampler'],
      installHint: 'ComfyUI-FramePackWrapper custom nodes. Install via Discover > Video > FramePack bundle.',
    },
    cogvideo: {
      nodes: ['CogVideoXModelLoader', 'CogVideoXSampler'],
      installHint: 'ComfyUI-CogVideoXWrapper custom nodes. Install from Model Manager.',
    },
    pyramidflow: {
      nodes: ['PyramidFlowModelLoader', 'PyramidFlowSampler'],
      installHint: 'ComfyUI-PyramidFlowWrapper custom nodes. Install from Model Manager.',
    },
    allegro: {
      nodes: ['AllegroModelLoader', 'AllegroSampler'],
      installHint: 'ComfyUI-Allegro custom nodes. Install from Model Manager.',
    },
  }

  const customCheck = customNodeModels[modelType]
  if (customCheck) {
    const allNodeNames = [...nodes.loaders, ...nodes.samplers, ...nodes.conditioning, ...nodes.decoders]
    const missing = customCheck.nodes.filter(n => !allNodeNames.includes(n))
    if (missing.length > 0) {
      errors.push({
        type: 'missing_nodes',
        message: `Missing custom nodes: ${missing.join(', ')}. Install ${customCheck.installHint}`,
      })
    }
  }

  const needsUnet = modelType === 'flux' || modelType === 'flux2' || modelType === 'zimage' || modelType === 'ernie_image' || modelType === 'wan' || modelType === 'hunyuan'
    || modelType === 'ltx' || modelType === 'mochi' || modelType === 'cosmos'
    || modelType === 'framepack'
  if (needsUnet) {
    const hasUNET = nodes.loaders.includes('UNETLoader')
    const hasCLIPLoader = nodes.loaders.includes('CLIPLoader')
    const hasVAELoader = nodes.loaders.includes('VAELoader')
    if (!hasUNET || !hasCLIPLoader || !hasVAELoader) {
      const missing = [!hasUNET && 'UNETLoader', !hasCLIPLoader && 'CLIPLoader', !hasVAELoader && 'VAELoader'].filter(Boolean)
      errors.push({
        type: 'missing_nodes',
        message: `Missing required nodes: ${missing.join(', ')}. Update ComfyUI to the latest version.`,
      })
    }
  } else if (!customCheck) {
    if (!nodes.loaders.includes('CheckpointLoaderSimple')) {
      errors.push({
        type: 'missing_nodes',
        message: 'Missing CheckpointLoaderSimple node. Update ComfyUI.',
      })
    }
  }

  // Check VAE availability (models with separate VAE files)
  if (registry?.needsSeparateVAE) {
    try {
      resolvedVAE = await findMatchingVAE(modelType)
    } catch (err) {
      const vaeSpec = registry?.vae
      errors.push({
        type: 'missing_vae',
        message: err instanceof Error ? err.message : 'VAE not found.',
        downloadUrl: vaeSpec?.downloadUrl,
        downloadFilename: vaeSpec?.downloadName,
        downloadSubfolder: vaeSpec?.subfolder,
      })
    }
  }

  // Check CLIP/text encoder availability (models with separate CLIP files)
  if (registry?.needsSeparateCLIP) {
    try {
      resolvedCLIP = await findMatchingCLIP(modelType)
    } catch (err) {
      const clipSpec = registry?.clip
      errors.push({
        type: 'missing_clip',
        message: err instanceof Error ? err.message : 'Text encoder not found.',
        downloadUrl: clipSpec?.downloadUrl,
        downloadFilename: clipSpec?.downloadName,
        downloadSubfolder: clipSpec?.subfolder,
      })
    }
  }

  // Size alignment check for video
  if (mode === 'video' && width && height) {
    if (width % 16 !== 0 || height % 16 !== 0) {
      warnings.push({
        type: 'size_alignment',
        message: `Video dimensions must be multiples of 16. Current: ${width}x${height}.`,
      })
    }
  }

  return {
    ready: errors.length === 0,
    modelType,
    warnings,
    errors,
    resolvedVAE,
    resolvedCLIP,
  }
}
