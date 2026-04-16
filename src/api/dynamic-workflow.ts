import { classifyModel, findMatchingVAE, findMatchingCLIP } from './comfyui'
import type { ModelType, GenerateParams, VideoParams } from './comfyui'
import {
  getAllNodeInfo,
  categorizeNodes,
  detectAvailableModels,
  type NodeMetadata,
  type CategorizedNodes,
  type AvailableModels,
} from './comfyui-nodes'

// ─── Strategy Detection ───

export type WorkflowStrategy =
  | 'unet_flux'       // FLUX 1: UNETLoader + CLIPLoader + VAELoader + EmptySD3LatentImage
  | 'unet_flux2'      // FLUX 2: UNETLoader + CLIPLoader + VAELoader + EmptyFlux2LatentImage
  | 'unet_zimage'     // Z-Image: UNETLoader + CLIPLoader(qwen_image) + VAELoader + EmptySD3LatentImage
  | 'unet_ernie_image' // ERNIE-Image: UNETLoader + CLIPLoader(flux2) + VAELoader + EmptyFlux2LatentImage + ConditioningZeroOut
  | 'unet_video'      // Wan/Hunyuan: UNETLoader + CLIPLoader + VAELoader + EmptyHunyuanLatentVideo
  | 'unet_ltx'        // LTX Video: UNETLoader + CLIPLoader + EmptyLTXVLatentVideo
  | 'unet_mochi'      // Mochi: UNETLoader + CLIPLoader + VAELoader + EmptyMochiLatentVideo
  | 'unet_cosmos'     // Cosmos: UNETLoader + CLIPLoader(oldt5) + VAELoader + EmptyCosmosLatentVideo
  | 'svd'             // SVD: ImageOnlyCheckpointLoader + SVD_img2vid_Conditioning
  | 'cogvideo'        // CogVideoX: Kijai wrapper nodes
  | 'framepack'       // FramePack: Kijai wrapper + image input
  | 'pyramidflow'     // Pyramid Flow: Kijai wrapper nodes
  | 'allegro'         // Allegro: Community wrapper nodes
  | 'checkpoint'      // SDXL/SD1.5: CheckpointLoaderSimple + EmptyLatentImage
  | 'animatediff'     // AnimateDiff: CheckpointLoaderSimple + ADE_* nodes
  | 'unavailable'

interface StrategyResult {
  strategy: WorkflowStrategy
  reason: string
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

  // CogVideoX → Kijai wrapper nodes
  if (modelType === 'cogvideo') {
    const hasCogNodes = nodes.samplers.includes('CogVideoXSampler')
    if (hasCogNodes) {
      return { strategy: 'cogvideo', reason: 'CogVideoX → Kijai wrapper pipeline' }
    }
    return { strategy: 'unavailable', reason: 'CogVideoX requires ComfyUI-CogVideoXWrapper custom nodes. Install them from the Model Manager.' }
  }

  // FramePack → Kijai wrapper nodes (I2V)
  if (modelType === 'framepack') {
    const hasFPNodes = nodes.samplers.includes('FramePackSampler')
    if (hasFPNodes) {
      return { strategy: 'framepack', reason: 'FramePack → Kijai wrapper pipeline (I2V)' }
    }
    return { strategy: 'unavailable', reason: 'FramePack requires ComfyUI-FramePackWrapper custom nodes. Install them from the Model Manager.' }
  }

  // Pyramid Flow → Kijai wrapper nodes
  if (modelType === 'pyramidflow') {
    const hasPFNodes = nodes.samplers.includes('PyramidFlowSampler')
    if (hasPFNodes) {
      return { strategy: 'pyramidflow', reason: 'Pyramid Flow → Kijai wrapper pipeline' }
    }
    return { strategy: 'unavailable', reason: 'Pyramid Flow requires ComfyUI-PyramidFlowWrapper custom nodes. Install them from the Model Manager.' }
  }

  // Allegro → Community wrapper nodes
  if (modelType === 'allegro') {
    const hasAllegroNodes = nodes.samplers.includes('AllegroSampler')
    if (hasAllegroNodes) {
      return { strategy: 'allegro', reason: 'Allegro → Community wrapper pipeline' }
    }
    return { strategy: 'unavailable', reason: 'Allegro requires ComfyUI-Allegro custom nodes. Install them from the Model Manager.' }
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

export async function buildDynamicWorkflow(
  params: GenerateParams | VideoParams,
  modelType?: ModelType,
): Promise<Record<string, any>> {
  const type = modelType || classifyModel(params.model)
  const isVideo = 'frames' in params
  const videoParams = params as VideoParams

  // Fetch node info (cached)
  const allNodes = await getAllNodeInfo()
  const nodes = categorizeNodes(allNodes)
  const models = detectAvailableModels(allNodes)

  const { strategy, reason } = determineStrategy(type, isVideo, nodes, models)
  console.log(`[dynamic-workflow] Strategy: ${strategy} (${reason})`)

  if (strategy === 'unavailable') {
    throw new Error(reason)
  }

  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed

  // ─── Wrapper Strategies (custom node pipelines — completely different node chains) ───

  if (strategy === 'cogvideo') {
    return buildCogVideoWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'svd') {
    return buildSVDWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'framepack') {
    return buildFramePackWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'pyramidflow') {
    return buildPyramidFlowWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'allegro') {
    return buildAllegroWorkflow(params as VideoParams, seed, nodes)
  }

  // ─── Standard Strategies (UNET/Checkpoint → CLIP → Latent → KSampler → VAEDecode) ───

  const workflow: Record<string, any> = {}
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

    let vae: string, clip: string
    try { vae = await findMatchingVAE(type) } catch { vae = models.vaes[0] || '' }
    // Pass the active UNet filename so the resolver can prefer the matching
    // quantisation tier (fp4 model → fp4 encoder; fp8/bf16 model → full-
    // precision encoder). See findMatchingCLIP's flux2 branch.
    try { clip = await findMatchingCLIP(type, params.model) } catch { clip = models.clips[0] || '' }

    workflow[unetId] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: params.model, weight_dtype: 'default' },
    }
    workflow[clipId] = {
      class_type: 'CLIPLoader',
      inputs: { clip_name: clip, type: clipType, device: 'default' },
    }

    // LTX doesn't need a separate VAE loader — VAE is built into the pipeline
    const needsVAELoader = strategy !== 'unet_ltx'
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
  // I2I mode: LoadImage → VAEEncode instead of empty latent
  const isI2I = !isVideo && params.inputImage && (params.denoise ?? 1.0) < 1.0

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

  // I2I override: replace empty latent with LoadImage → VAEEncode
  let latentSourceId = latentId
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
    latentSourceId = vaeEncodeId
    // Remove the empty latent node since we're using the encoded image
    delete workflow[latentId]
  }

  // ─── Phase 4: Sampling ───

  const samplerId = String(n++)

  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [samplerModelId, 0],
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [latentSourceId, 0],
      seed,
      steps: params.steps,
      cfg: params.cfgScale,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: isI2I ? (params.denoise ?? 0.7) : 1.0,
    },
  }

  // ─── Phase 5: Decode ───

  const decodeId = String(n++)

  workflow[decodeId] = {
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
    if (nodes.videoSavers.includes('VHS_VideoCombine')) {
      workflow[saveId] = {
        class_type: 'VHS_VideoCombine',
        inputs: {
          images: [decodeId, 0],
          frame_rate: videoParams.fps,
          loop_count: 0,
          filename_prefix: 'locally_uncensored_vid',
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
          filename_prefix: 'locally_uncensored_vid',
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
          filename_prefix: 'locally_uncensored_vid',
        },
      }
    }
  } else {
    workflow[saveId] = {
      class_type: 'SaveImage',
      inputs: {
        images: [decodeId, 0],
        filename_prefix: 'locally_uncensored',
      },
    }
  }

  console.log(`[dynamic-workflow] Built ${Object.keys(workflow).length} nodes:`,
    Object.entries(workflow).map(([id, node]) => `${id}:${node.class_type}`).join(' → ')
  )

  return workflow
}

// ─── Wrapper Workflow Builders ───

function addVideoOutput(workflow: Record<string, any>, n: number, decodeId: string, fps: number, nodes: CategorizedNodes): number {
  const saveId = String(n++)
  if (nodes.videoSavers.includes('VHS_VideoCombine')) {
    workflow[saveId] = {
      class_type: 'VHS_VideoCombine',
      inputs: { images: [decodeId, 0], frame_rate: fps, loop_count: 0, filename_prefix: 'locally_uncensored_vid', format: 'video/h264-mp4', pingpong: false, save_output: true },
    }
  } else if (nodes.videoSavers.includes('SaveAnimatedWEBP')) {
    workflow[saveId] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: { images: [decodeId, 0], filename_prefix: 'locally_uncensored_vid', fps, lossless: false, quality: 90, method: 'default' },
    }
  } else {
    workflow[saveId] = {
      class_type: 'SaveImage',
      inputs: { images: [decodeId, 0], filename_prefix: 'locally_uncensored_vid' },
    }
  }
  return n
}

function buildCogVideoWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const clipId = String(n++)
  const posId = String(n++)
  const negId = String(n++)
  const latentId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'CogVideoXModelLoader', inputs: { model: params.model } }
  workflow[clipId] = { class_type: 'CogVideoXCLIPLoader', inputs: { clip_name: 't5xxl_fp16.safetensors' } }
  workflow[posId] = { class_type: 'CogVideoXTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  workflow[negId] = { class_type: 'CogVideoXTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }
  workflow[latentId] = { class_type: 'CogVideoXEmptyLatents', inputs: { width: params.width, height: params.height, frames: params.frames, batch_size: 1 } }
  workflow[samplerId] = {
    class_type: 'CogVideoXSampler',
    inputs: { model: [modelId, 0], positive: [posId, 0], negative: [negId, 0], latents: [latentId, 0], seed, steps: params.steps, cfg: params.cfgScale },
  }
  workflow[decodeId] = { class_type: 'CogVideoXVAEDecode', inputs: { samples: [samplerId, 0], vae: [modelId, 1] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes)
  return workflow
}

function buildSVDWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const loaderId = String(n++)
  const imageId = String(n++)
  const condId = String(n++)
  const guidanceId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[loaderId] = { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: params.model } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  workflow[condId] = {
    class_type: 'SVD_img2vid_Conditioning',
    inputs: {
      clip_vision: [loaderId, 1], init_image: [imageId, 0], vae: [loaderId, 2],
      augmentation_level: 0.0, width: params.width, height: params.height,
      video_frames: params.frames, motion_bucket_id: 127, fps: params.fps,
    },
  }
  workflow[guidanceId] = { class_type: 'VideoLinearCFGGuidance', inputs: { model: [loaderId, 0], min_cfg: 1.0 } }
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: { model: [guidanceId, 0], positive: [condId, 0], negative: [condId, 1], latent_image: [condId, 2], seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 },
  }
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: [loaderId, 2] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes)
  return workflow
}

function buildFramePackWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const clipId = String(n++)
  const clipVisionId = String(n++)
  const vaeId = String(n++)
  const imageId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'LoadFramePackModel', inputs: { model: params.model, base_precision: 'bf16', quantization: 'disabled', load_device: 'main_device' } }
  // DualCLIPLoader with type "hunyuan_video" — CLIPLoader type "wan" creates Llama2 with 128256 vocab
  // but llava_llama3 has 128320 tokens, causing state_dict size mismatch. DualCLIPLoader handles both correctly.
  workflow[clipId] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 'llava_llama3_fp8_scaled.safetensors', type: 'hunyuan_video' } }
  workflow[clipVisionId] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'sigclip_vision_patch14_384.safetensors' } }
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: 'hunyuanvideo15_vae_fp16.safetensors' } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  // Encode image for CLIP vision embeddings (FramePackSampler image_embeds input)
  const clipVisionEncodeId = String(n++)
  workflow[clipVisionEncodeId] = { class_type: 'CLIPVisionEncode', inputs: { crop: 'center', clip_vision: [clipVisionId, 0], image: [imageId, 0] } }
  // Encode image to latent (FramePackSampler needs LATENT, not IMAGE)
  const vaeEncodeId = String(n++)
  workflow[vaeEncodeId] = { class_type: 'VAEEncode', inputs: { pixels: [imageId, 0], vae: [vaeId, 0] } }
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
      total_second_length: (params.numFrames || 49) / (params.fps || 16),
      gpu_memory_preservation: 6.0, sampler: 'unipc_bh2',
      use_teacache: true, teacache_rel_l1_thresh: 0.15,
    },
  }
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: [vaeId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes)
  return workflow
}

function buildPyramidFlowWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const vaeId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'PyramidFlowModelLoader', inputs: { model: params.model } }
  workflow[vaeId] = { class_type: 'PyramidFlowVAELoader', inputs: { vae: 'pyramid_flow_vae_bf16.safetensors' } }
  workflow[posId] = { class_type: 'PyramidFlowTextEncode', inputs: { text: params.prompt } }
  workflow[samplerId] = {
    class_type: 'PyramidFlowSampler',
    inputs: { model: [modelId, 0], vae: [vaeId, 0], text: [posId, 0], seed, steps: params.steps, cfg: params.cfgScale, width: params.width, height: params.height, frames: params.frames },
  }
  workflow[decodeId] = { class_type: 'PyramidFlowDecode', inputs: { samples: [samplerId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes)
  return workflow
}

function buildAllegroWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'AllegroModelLoader', inputs: { model: params.model } }
  workflow[posId] = { class_type: 'AllegroTextEncode', inputs: { text: params.prompt } }
  workflow[samplerId] = {
    class_type: 'AllegroSampler',
    inputs: { model: [modelId, 0], text: [posId, 0], seed, steps: params.steps, cfg: params.cfgScale, width: params.width, height: params.height, frames: params.frames },
  }
  workflow[decodeId] = { class_type: 'AllegroDecoder', inputs: { samples: [samplerId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes)
  return workflow
}
