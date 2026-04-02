import { comfyuiUrl, localFetch } from "./backend"

// ─── Types ───

export interface GenerateParams {
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
}

export interface VideoParams extends GenerateParams {
  frames: number
  fps: number
}

export interface ComfyUIOutput {
  filename: string
  subfolder: string
  type: string
}

export type ModelType = 'flux' | 'flux2' | 'sdxl' | 'sd15' | 'wan' | 'hunyuan' | 'unknown'
export type VideoBackend = 'wan' | 'animatediff' | 'none'

export interface ClassifiedModel {
  name: string
  type: ModelType
  source: 'checkpoint' | 'diffusion_model'
}

// ─── Model Classification ───

// Known community models → pre-classified for reliability
const KNOWN_MODELS: Record<string, ModelType> = {
  juggernaut: 'sdxl',
  realvis: 'sdxl',
  animagine: 'sdxl',
  pony: 'sdxl',
  illustrious: 'sdxl',
  noobai: 'sdxl',
  proteus: 'sdxl',
  copax: 'sdxl',
  zavychroma: 'sdxl',
  epicrealism: 'sdxl',
  realisticvision: 'sd15',
  deliberate: 'sd15',
  revanimated: 'sd15',
  dreamshaper: 'sd15', // dreamshaper XL handled by 'xl' check first
  absolutereality: 'sd15',
}

export function classifyModel(name: string): ModelType {
  const lower = name.toLowerCase()

  // Video models — most specific first
  if (lower.includes('wan')) return 'wan'
  if (lower.includes('hunyuan')) return 'hunyuan'

  // FLUX variants
  if (lower.includes('flux-2') || lower.includes('flux2')) return 'flux2'
  if (lower.includes('flux')) return 'flux'

  // Explicit architecture tags
  if (lower.includes('sdxl') || lower.includes('sd_xl')) return 'sdxl'
  if (lower.includes('sd15') || lower.includes('sd_1') || lower.includes('v1-5') || lower.includes('sd1.5')) return 'sd15'

  // "xl" suffix/tag (but not "xxl" which is a text encoder)
  if (/[_\-.]xl[_\-.]|[_\-.]xl$|_xl_/i.test(name)) return 'sdxl'

  // Known community model names
  for (const [keyword, type] of Object.entries(KNOWN_MODELS)) {
    if (lower.includes(keyword)) return type
  }

  // SD 1.5 patterns
  if (lower.includes('1.5') || lower.includes('v1_5')) return 'sd15'

  return 'unknown'
}

function isImageModelType(type: ModelType): boolean {
  return type === 'flux' || type === 'flux2' || type === 'sdxl' || type === 'sd15' || type === 'unknown'
}

function isVideoModelType(type: ModelType): boolean {
  return type === 'wan' || type === 'hunyuan'
}

// ─── Connection & Info ───

export async function checkComfyConnection(): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'))
    return res.ok
  } catch {
    return false
  }
}

// ─── System VRAM Detection ───

let cachedVRAM: number | null = null

export async function getSystemVRAM(): Promise<number | null> {
  if (cachedVRAM !== null) return cachedVRAM
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'))
    if (!res.ok) return null
    const data = await res.json()
    // ComfyUI returns devices[].vram_total in bytes
    const devices = data?.system?.devices ?? data?.devices ?? []
    if (devices.length > 0) {
      const vramBytes = devices[0]?.vram_total ?? 0
      cachedVRAM = Math.round(vramBytes / (1024 * 1024 * 1024)) // bytes → GB
      return cachedVRAM
    }
  } catch { /* ComfyUI not running */ }
  return null
}

// Check if a specific node exists in ComfyUI (lightweight, single node check)
async function nodeExists(nodeName: string): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl(`/object_info/${nodeName}`))
    if (!res.ok) return false
    const data = await res.json()
    return !!(data && data[nodeName])
  } catch {
    return false
  }
}

export async function getCheckpoints(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/CheckpointLoaderSimple'))
    if (!res.ok) return []
    const data = await res.json()
    return data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
  } catch (err) {
    console.warn('[ComfyUI] Failed to fetch checkpoints:', err)
    return []
  }
}

export async function getDiffusionModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/UNETLoader'))
    if (!res.ok) return []
    const data = await res.json()
    return data?.UNETLoader?.input?.required?.unet_name?.[0] ?? []
  } catch (err) {
    console.warn('[ComfyUI] Failed to fetch diffusion models:', err)
    return []
  }
}

export async function getVAEModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/VAELoader'))
    if (!res.ok) return []
    const data = await res.json()
    return data?.VAELoader?.input?.required?.vae_name?.[0] ?? []
  } catch (err) {
    console.warn('[ComfyUI] Failed to fetch VAE models:', err)
    return []
  }
}

export async function getCLIPModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/CLIPLoader'))
    if (!res.ok) return []
    const data = await res.json()
    return data?.CLIPLoader?.input?.required?.clip_name?.[0] ?? []
  } catch (err) {
    console.warn('[ComfyUI] Failed to fetch CLIP models:', err)
    return []
  }
}

export async function getSamplers(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/KSampler'))
    if (!res.ok) throw new Error('Failed')
    const data = await res.json()
    return data?.KSampler?.input?.required?.sampler_name?.[0] ?? []
  } catch {
    return ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'uni_pc', 'ddim']
  }
}

export async function getSchedulers(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/KSampler'))
    if (!res.ok) throw new Error('Failed')
    const data = await res.json()
    return data?.KSampler?.input?.required?.scheduler?.[0] ?? []
  } catch {
    return ['normal', 'karras', 'simple', 'exponential', 'sgm_uniform']
  }
}

export async function getAnimateDiffModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/ADE_LoadAnimateDiffModel'))
    if (!res.ok) return []
    const data = await res.json()
    return data?.ADE_LoadAnimateDiffModel?.input?.required?.model_name?.[0] ?? []
  } catch {
    return []
  }
}

// ─── Classified Model Lists ───

export async function getImageModels(): Promise<ClassifiedModel[]> {
  const [checkpoints, diffModels] = await Promise.all([getCheckpoints(), getDiffusionModels()])
  const result: ClassifiedModel[] = []

  for (const name of checkpoints) {
    const type = classifyModel(name)
    result.push({ name, type: isImageModelType(type) ? type : 'sdxl', source: 'checkpoint' })
  }

  for (const name of diffModels) {
    const type = classifyModel(name)
    if (isImageModelType(type)) {
      result.push({ name, type, source: 'diffusion_model' })
    }
  }

  return result
}

export async function getVideoModels(): Promise<ClassifiedModel[]> {
  const diffModels = await getDiffusionModels()
  const result: ClassifiedModel[] = []

  for (const name of diffModels) {
    const type = classifyModel(name)
    if (isVideoModelType(type)) {
      result.push({ name, type, source: 'diffusion_model' })
    }
  }

  return result
}

// ─── Detect Video Backend (checks individual nodes + models — no full object_info fetch) ───

export async function detectVideoBackend(): Promise<VideoBackend> {
  try {
    // Check Wan/Hunyuan: need specific nodes AND actual video models
    const [hasWanLatent, hasUNET, hasCLIP, hasVAE, videoModels] = await Promise.all([
      nodeExists('EmptyHunyuanLatentVideo'),
      nodeExists('UNETLoader'),
      nodeExists('CLIPLoader'),
      nodeExists('VAELoader'),
      getVideoModels(),
    ])

    if (hasWanLatent && hasUNET && hasCLIP && hasVAE && videoModels.length > 0) {
      return 'wan'
    }

    // Check AnimateDiff: need custom extension nodes
    const [hasADELoad, hasADESampling] = await Promise.all([
      nodeExists('ADE_LoadAnimateDiffModel'),
      nodeExists('ADE_UseEvolvedSampling'),
    ])
    if (hasADELoad && hasADESampling) return 'animatediff'
  } catch (err) {
    console.warn('[ComfyUI] Failed to detect video backend:', err)
  }
  return 'none'
}

// ─── Auto-find matching VAE/CLIP for a model ───

export async function findMatchingVAE(modelType: ModelType): Promise<string> {
  const vaes = await getVAEModels()
  if (vaes.length === 0) throw new Error('No VAE models found. Download a VAE for your model type from the Model Manager.')
  const lower = (s: string) => s.toLowerCase()

  if (modelType === 'flux' || modelType === 'flux2') {
    const match = vaes.find(v => lower(v).includes('flux') || lower(v).includes('ae'))
    if (match) return match
    throw new Error(`No FLUX VAE found. Download "ae.safetensors" from the Model Manager (FLUX bundles include it).`)
  }
  if (modelType === 'hunyuan') {
    // HunyuanVideo has its own VAE — prefer it, fall back to Wan VAE
    const match = vaes.find(v => lower(v).includes('hunyuanvideo'))
      || vaes.find(v => lower(v).includes('hunyuan'))
      || vaes.find(v => lower(v).includes('wan'))
    if (match) return match
    throw new Error(`No HunyuanVideo VAE found. Download "hunyuanvideo15_vae_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan') {
    const match = vaes.find(v => lower(v).includes('wan'))
      || vaes.find(v => lower(v).includes('hunyuan'))
    if (match) return match
    throw new Error(`No Wan VAE found. Download "wan_2.1_vae.safetensors" from the Model Manager.`)
  }
  // SDXL/SD1.5 checkpoints include VAE — any VAE works as fallback
  return vaes[0]
}

export async function findMatchingCLIP(modelType: ModelType): Promise<string> {
  const clips = await getCLIPModels()
  if (clips.length === 0) throw new Error('No text encoder models found. Download a CLIP/T5 model for your model type from the Model Manager.')
  const lower = (s: string) => s.toLowerCase()

  if (modelType === 'flux' || modelType === 'flux2') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5'))
      || clips.find(c => lower(c).includes('clip_l'))
    if (match) return match
    throw new Error(`No FLUX text encoder (T5) found. Download "t5xxl_fp8_e4m3fn.safetensors" from the Model Manager.`)
  }
  if (modelType === 'hunyuan') {
    // HunyuanVideo 1.5 uses Qwen 2.5 VL, older versions use llava_llama3
    const match = clips.find(c => lower(c).includes('qwen'))
      || clips.find(c => lower(c).includes('llava'))
      || clips.find(c => lower(c).includes('umt5'))
    if (match) return match
    throw new Error(`No HunyuanVideo text encoder found. Download "qwen_2.5_vl_7b_fp8_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan') {
    const match = clips.find(c => lower(c).includes('umt5') || lower(c).includes('wan'))
      || clips.find(c => lower(c).includes('t5'))
    if (match) return match
    throw new Error(`No Wan text encoder found. Download "umt5_xxl_fp8_e4m3fn_scaled.safetensors" from the Model Manager.`)
  }
  // SDXL/SD1.5 checkpoints include CLIP — any works
  return clips[0]
}

async function findAnimateDiffModel(): Promise<string> {
  const models = await getAnimateDiffModels()
  if (models.length === 0) throw new Error('No AnimateDiff motion models found. Install them via ComfyUI Manager.')
  return models[0]
}

// ─── Workflow Submission ───

export async function submitWorkflow(workflow: Record<string, any>): Promise<string> {
  const res = await localFetch(comfyuiUrl('/prompt'), {
    method: 'POST',
    body: JSON.stringify({ prompt: workflow }),
  })
  if (!res.ok) {
    const rawText = await res.text().catch(() => '')
    let errMsg = `HTTP ${res.status}`
    try {
      const errData = JSON.parse(rawText)
      const parts: string[] = []
      if (errData.error?.message) parts.push(errData.error.message)
      if (errData.node_errors) {
        for (const [nodeId, data] of Object.entries(errData.node_errors) as [string, any][]) {
          const errs = data.errors?.map((e: any) => e.message || e.details).join(', ') || 'unknown'
          parts.push(`Node ${nodeId} (${data.class_type || '?'}): ${errs}`)
        }
      }
      if (parts.length > 0) errMsg = parts.join(' | ')
    } catch {
      if (rawText) errMsg = rawText.slice(0, 500)
    }
    console.error('[ComfyUI] Workflow rejected:', errMsg)
    console.error('[ComfyUI] Submitted workflow:', JSON.stringify(workflow).slice(0, 2000))
    throw new Error(`ComfyUI rejected workflow: ${errMsg}`)
  }
  const data = await res.json()
  return data.prompt_id
}

export async function cancelGeneration(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/interrupt'), { method: 'POST' })
  } catch { /* best effort */ }
}

export async function freeMemory(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/free'), {
      method: 'POST',
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    })
  } catch { /* best effort */ }
}

export async function getHistory(promptId: string): Promise<any> {
  try {
    const res = await localFetch(comfyuiUrl(`/history/${promptId}`))
    if (!res.ok) return null
    const data = await res.json()
    return data[promptId] ?? null
  } catch {
    return null
  }
}

export function getImageUrl(filename: string, subfolder: string = '', type: string = 'output'): string {
  return comfyuiUrl(`/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}&t=${Date.now()}`)
}

// ─── Validate params ───

function validateParams(params: GenerateParams) {
  if (!params.prompt.trim()) throw new Error('Prompt is empty')
  if (!params.model) throw new Error('No model selected')
  if (params.width < 64 || params.width > 4096) throw new Error('Width must be 64-4096')
  if (params.height < 64 || params.height > 4096) throw new Error('Height must be 64-4096')
  if (params.steps < 1 || params.steps > 200) throw new Error('Steps must be 1-200')
}

function validateVideoParams(params: VideoParams) {
  validateParams(params)
  if (params.frames < 1 || params.frames > 256) throw new Error('Frames must be 1-256')
  if (params.fps < 1 || params.fps > 60) throw new Error('FPS must be 1-60')
  // Wan requires width/height to be multiples of 16
  if (params.width % 16 !== 0) throw new Error(`Width must be a multiple of 16 (current: ${params.width})`)
  if (params.height % 16 !== 0) throw new Error(`Height must be a multiple of 16 (current: ${params.height})`)
}

function getSeed(seed: number): number {
  return seed === -1 ? Math.floor(Math.random() * 2147483647) : Math.floor(seed)
}

// ─── Snap video dimensions to valid values ───

export function snapToVideoGrid(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(width / 16) * 16,
    height: Math.round(height / 16) * 16,
  }
}

// ─── Image Workflow: SDXL/SD (CheckpointLoaderSimple) ───

export function buildSDXLImgWorkflow(params: GenerateParams): Record<string, any> {
  validateParams(params)
  const seed = getSeed(params.seed)
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: params.width, height: params.height, batch_size: params.batchSize } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored' } },
  }
}

// ─── Image Workflow: FLUX (UNETLoader + CLIPLoader + VAELoader) ───

export async function buildFluxImgWorkflow(params: GenerateParams): Promise<Record<string, any>> {
  validateParams(params)
  const seed = getSeed(params.seed)
  const modelType = classifyModel(params.model)
  const vae = await findMatchingVAE(modelType)
  const clip = await findMatchingCLIP(modelType)
  const clipType = modelType === 'flux2' ? 'flux2' : 'flux'

  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: params.model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType, device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'EmptySD3LatentImage', inputs: { width: params.width, height: params.height, batch_size: params.batchSize } },
    '6': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['5', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'locally_uncensored' } },
  }
}

// ─── Auto-select Image Workflow ───

export async function buildTxt2ImgWorkflow(params: GenerateParams, modelType: ModelType): Promise<Record<string, any>> {
  if (modelType === 'flux' || modelType === 'flux2') return buildFluxImgWorkflow(params)
  return buildSDXLImgWorkflow(params)
}

// ─── Video Workflow: Wan 2.1/2.2 (Hunyuan latent space) ───

export async function buildWanVideoWorkflow(params: VideoParams): Promise<Record<string, any>> {
  validateVideoParams(params)
  const seed = getSeed(params.seed)

  // Pre-check required nodes
  const hasLatent = await nodeExists('EmptyHunyuanLatentVideo')
  if (!hasLatent) throw new Error('EmptyHunyuanLatentVideo node not found. Update ComfyUI to latest version.')
  const hasSaveWEBP = await nodeExists('SaveAnimatedWEBP')

  const vae = await findMatchingVAE('wan')
  const clip = await findMatchingCLIP('wan')

  const workflow: Record<string, any> = {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan', device: 'default' } },
    '2': { class_type: 'UNETLoader', inputs: { unet_name: params.model, weight_dtype: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || 'static, blurred, low quality, worst quality, deformed', clip: ['1', 0] } },
    '6': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: params.width, height: params.height, length: params.frames, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  }

  // Use SaveAnimatedWEBP if available, otherwise fall back to SaveImage (frame sequence)
  if (hasSaveWEBP) {
    workflow['9'] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: { images: ['8', 0], filename_prefix: 'locally_uncensored_vid', fps: params.fps, lossless: false, quality: 90, method: 'default' },
    }
  } else {
    workflow['9'] = {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: 'locally_uncensored_vid' },
    }
  }

  return workflow
}

// ─── Video Workflow: AnimateDiff ───

export async function buildAnimateDiffWorkflow(params: VideoParams): Promise<Record<string, any>> {
  validateVideoParams(params)
  const seed = getSeed(params.seed)
  const motionModel = await findAnimateDiffModel()

  // AnimateDiff: batch_size=1, motion model handles temporal dimension
  const hasVHS = await nodeExists('VHS_VideoCombine')

  const workflow: Record<string, any> = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } },
    '2': { class_type: 'ADE_LoadAnimateDiffModel', inputs: { model_name: motionModel } },
    '3': { class_type: 'ADE_ApplyAnimateDiffModelSimple', inputs: { motion_model: ['2', 0] } },
    '4': { class_type: 'ADE_UseEvolvedSampling', inputs: { model: ['1', 0], m_models: ['3', 0], beta_schedule: 'autoselect' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || 'low quality, blurry, static', clip: ['1', 1] } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: params.width, height: params.height, batch_size: params.frames } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } },
  }

  // Use VHS_VideoCombine if available (produces MP4), otherwise SaveAnimatedWEBP, otherwise SaveImage
  if (hasVHS) {
    workflow['10'] = {
      class_type: 'VHS_VideoCombine',
      inputs: { images: ['9', 0], frame_rate: params.fps, loop_count: 0, filename_prefix: 'locally_uncensored_vid', format: 'video/h264-mp4', pingpong: false, save_output: true },
    }
  } else {
    const hasSaveWEBP = await nodeExists('SaveAnimatedWEBP')
    if (hasSaveWEBP) {
      workflow['10'] = {
        class_type: 'SaveAnimatedWEBP',
        inputs: { images: ['9', 0], filename_prefix: 'locally_uncensored_vid', fps: params.fps, lossless: false, quality: 90, method: 'default' },
      }
    } else {
      workflow['10'] = {
        class_type: 'SaveImage',
        inputs: { images: ['9', 0], filename_prefix: 'locally_uncensored_vid' },
      }
    }
  }

  return workflow
}

// ─── Auto-select Video Workflow ───

export async function buildTxt2VidWorkflow(params: VideoParams, backend: VideoBackend): Promise<Record<string, any>> {
  switch (backend) {
    case 'wan': return buildWanVideoWorkflow(params)
    case 'animatediff': return buildAnimateDiffWorkflow(params)
    default: throw new Error('No video backend available. Install Wan 2.1 models or AnimateDiff nodes in ComfyUI.')
  }
}
