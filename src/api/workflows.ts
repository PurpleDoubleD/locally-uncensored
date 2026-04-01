import JSZip from 'jszip'
import type { ModelType } from './comfyui'
import type { GenerateParams, VideoParams } from './comfyui'
import { findMatchingVAE, findMatchingCLIP } from './comfyui'
import { fetchExternal, fetchExternalBytes } from './backend'
import type {
  WorkflowTemplate,
  WorkflowSearchResult,
  WorkflowSource,
  ParameterMap,
} from '../types/workflows'

// ─── Validation ───

export function validateWorkflowJson(json: unknown): json is Record<string, any> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  const obj = json as Record<string, any>
  // API format: { "1": { class_type: "...", inputs: {...} }, ... }
  if (Object.values(obj).some(
    (node) => node && typeof node === 'object' && typeof node.class_type === 'string'
  )) return true
  // Web/UI format: { nodes: [...], links: [...] }
  if (Array.isArray(obj.nodes) && obj.nodes.some((n: any) => n && typeof n.type === 'string')) return true
  return false
}

// Convert ComfyUI web/UI format to API format
function convertWebToApiFormat(webWorkflow: Record<string, any>): Record<string, any> {
  const nodes: any[] = webWorkflow.nodes
  const links: any[] = webWorkflow.links || []
  const apiWorkflow: Record<string, any> = {}

  // Build link lookup: linkId -> { sourceNodeId, sourceSlot }
  const linkMap: Record<number, { sourceNodeId: number; sourceSlot: number }> = {}
  for (const link of links) {
    // link format: [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
    if (Array.isArray(link) && link.length >= 4) {
      linkMap[link[0]] = { sourceNodeId: link[1], sourceSlot: link[2] }
    }
  }

  for (const node of nodes) {
    if (!node || !node.type || typeof node.id !== 'number') continue
    const inputs: Record<string, any> = {}

    // Process connected inputs (from links - these are reliable)
    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (input.link != null && linkMap[input.link]) {
          const { sourceNodeId, sourceSlot } = linkMap[input.link]
          inputs[input.name] = [String(sourceNodeId), sourceSlot]
        }
      }
    }

    // Map widget_values using ComfyUI's object_info-based approach:
    // We map ONLY for node types we understand well. For unknown nodes,
    // we skip widget values and let injectParameters handle the important ones.
    const ct = node.type as string
    const widgetValues = node.widgets_values || []
    mapWidgetValues(ct, widgetValues, inputs, node)

    apiWorkflow[String(node.id)] = {
      class_type: ct,
      inputs,
    }
  }

  return apiWorkflow
}

// Map widget_values to named inputs. Conservative: only map what we're sure about.
// injectParameters will override model/prompt/seed/steps/cfg/etc. anyway.
function mapWidgetValues(classType: string, values: any[], inputs: Record<string, any>, node?: any) {
  if (!values || values.length === 0) return

  // For nodes where widget order is well-known and stable:
  switch (classType) {
    case 'CheckpointLoaderSimple':
      if (values[0] != null) inputs.ckpt_name = values[0]
      break
    case 'UNETLoader':
      if (values[0] != null) inputs.unet_name = values[0]
      if (values[1] != null) inputs.weight_dtype = values[1]
      break
    case 'CLIPLoader':
      if (values[0] != null) inputs.clip_name = values[0]
      if (values[1] != null) inputs.type = values[1]
      if (values[2] != null) inputs.device = values[2]
      break
    case 'VAELoader':
      if (values[0] != null) inputs.vae_name = values[0]
      break
    case 'CLIPTextEncode':
      if (values[0] != null) inputs.text = values[0]
      break
    case 'KSampler':
      // Widget order: seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise
      if (values[0] != null) inputs.seed = values[0]
      // values[1] = control_after_generate (skip - not an API input)
      if (values[2] != null) inputs.steps = values[2]
      if (values[3] != null) inputs.cfg = values[3]
      if (values[4] != null) inputs.sampler_name = values[4]
      if (values[5] != null) inputs.scheduler = values[5]
      if (values[6] != null) inputs.denoise = values[6]
      break
    case 'KSamplerAdvanced':
      // add_noise, noise_seed, control_after_generate, steps, cfg, sampler_name, scheduler, start_at_step, end_at_step, return_with_leftover_noise
      if (values[0] != null) inputs.add_noise = values[0]
      if (values[1] != null) inputs.noise_seed = values[1]
      if (values[3] != null) inputs.steps = values[3]
      if (values[4] != null) inputs.cfg = values[4]
      if (values[5] != null) inputs.sampler_name = values[5]
      if (values[6] != null) inputs.scheduler = values[6]
      if (values[7] != null) inputs.start_at_step = values[7]
      if (values[8] != null) inputs.end_at_step = values[8]
      if (values[9] != null) inputs.return_with_leftover_noise = values[9]
      break
    case 'EmptyLatentImage':
    case 'EmptySD3LatentImage':
      if (values[0] != null) inputs.width = values[0]
      if (values[1] != null) inputs.height = values[1]
      if (values[2] != null) inputs.batch_size = values[2]
      break
    case 'EmptyHunyuanLatentVideo':
      if (values[0] != null) inputs.width = values[0]
      if (values[1] != null) inputs.height = values[1]
      if (values[2] != null) inputs.length = values[2]
      if (values[3] != null) inputs.batch_size = values[3]
      break
    case 'SaveImage':
      if (values[0] != null) inputs.filename_prefix = values[0]
      break
    case 'SaveAnimatedWEBP':
      if (values[0] != null) inputs.filename_prefix = values[0]
      if (values[1] != null) inputs.fps = values[1]
      if (values[2] != null) inputs.lossless = values[2]
      if (values[3] != null) inputs.quality = values[3]
      if (values[4] != null) inputs.method = values[4]
      break
    case 'VHS_VideoCombine':
      if (values[0] != null) inputs.frame_rate = values[0]
      if (values[1] != null) inputs.loop_count = values[1]
      if (values[2] != null) inputs.filename_prefix = values[2]
      if (values[3] != null) inputs.format = values[3]
      break
    default:
      // For unknown node types: try to use node.widgets if available
      // to map by name, otherwise skip widget values entirely.
      // injectParameters handles the critical params.
      if (node?.widgets) {
        for (let i = 0; i < Math.min(values.length, node.widgets.length); i++) {
          const widgetName = node.widgets[i]?.name
          if (widgetName && values[i] != null) {
            inputs[widgetName] = values[i]
          }
        }
      }
      break
  }
}

// ─── Smart Search Terms ───

export function extractSearchTerms(modelName: string, modelType: ModelType): string {
  // Map model types to good search terms
  const typeTerms: Record<string, string> = {
    flux: 'flux',
    flux2: 'flux 2',
    sdxl: 'sdxl',
    sd15: 'sd 1.5',
    wan: 'wan',
    hunyuan: 'hunyuan',
  }

  if (modelType !== 'unknown' && typeTerms[modelType]) {
    return `${typeTerms[modelType]} comfyui workflow`
  }

  // Strip extension
  let name = modelName.replace(/\.[^.]+$/, '')
  // Strip common noise words
  name = name.replace(/[-_](fp8|fp16|fp32|bf16|4bit|8bit|4b|8b|base|klein|large|medium|small|q4|q5|q8|gguf|safetensors)/gi, ' ')
  // Replace separators with spaces
  name = name.replace(/[-_]+/g, ' ')
  // Collapse whitespace
  name = name.replace(/\s+/g, ' ').trim()
  // Keep only first 3 meaningful words to avoid overly specific queries
  const words = name.split(' ').filter(w => w.length > 1).slice(0, 3)
  return words.length > 0 ? `${words.join(' ')} comfyui workflow` : 'comfyui workflow'
}

// ─── Parameter Auto-Detection ───

export function autoDetectParameterMap(workflow: Record<string, any>): ParameterMap {
  const map: ParameterMap = {}

  let ksamplerNode: any = null

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const ct = node.class_type as string
    if (ct === 'KSampler' || ct === 'KSamplerAdvanced') {
      ksamplerNode = node
      map.seed = { nodeId, inputKey: 'seed' }
      map.steps = { nodeId, inputKey: 'steps' }
      map.cfgScale = { nodeId, inputKey: 'cfg' }
      map.sampler = { nodeId, inputKey: 'sampler_name' }
      map.scheduler = { nodeId, inputKey: 'scheduler' }
      break
    }
  }

  if (ksamplerNode?.inputs) {
    const posConn = ksamplerNode.inputs.positive
    const negConn = ksamplerNode.inputs.negative
    if (Array.isArray(posConn)) {
      const posNodeId = String(posConn[0])
      const posNode = workflow[posNodeId]
      if (posNode?.class_type === 'CLIPTextEncode') {
        map.positivePrompt = { nodeId: posNodeId, inputKey: 'text' }
      }
    }
    if (Array.isArray(negConn)) {
      const negNodeId = String(negConn[0])
      const negNode = workflow[negNodeId]
      if (negNode?.class_type === 'CLIPTextEncode') {
        map.negativePrompt = { nodeId: negNodeId, inputKey: 'text' }
      }
    }
  }

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue
    const ct = node.class_type as string

    switch (ct) {
      case 'CheckpointLoaderSimple':
        map.model = { nodeId, inputKey: 'ckpt_name', loaderType: 'checkpoint' }
        break
      case 'UNETLoader':
        map.model = { nodeId, inputKey: 'unet_name', loaderType: 'unet' }
        break
      case 'EmptyLatentImage':
      case 'EmptySD3LatentImage':
        map.width = { nodeId, inputKey: 'width' }
        map.height = { nodeId, inputKey: 'height' }
        map.batchSize = { nodeId, inputKey: 'batch_size' }
        break
      case 'EmptyHunyuanLatentVideo':
        map.width = { nodeId, inputKey: 'width' }
        map.height = { nodeId, inputKey: 'height' }
        map.frames = { nodeId, inputKey: 'length' }
        break
      case 'SaveAnimatedWEBP':
        map.fps = { nodeId, inputKey: 'fps' }
        break
      case 'VHS_VideoCombine':
        map.fps = { nodeId, inputKey: 'frame_rate' }
        break
    }
  }

  if (!map.positivePrompt) {
    const clipNodes = Object.entries(workflow).filter(
      ([, n]) => n?.class_type === 'CLIPTextEncode'
    )
    if (clipNodes.length >= 1) {
      map.positivePrompt = { nodeId: clipNodes[0][0], inputKey: 'text' }
    }
    if (clipNodes.length >= 2 && !map.negativePrompt) {
      map.negativePrompt = { nodeId: clipNodes[1][0], inputKey: 'text' }
    }
  }

  return map
}

// ─── Parameter Injection ───

export async function injectParameters(
  workflow: Record<string, any>,
  paramMap: ParameterMap,
  params: GenerateParams | VideoParams,
  modelType: ModelType
): Promise<Record<string, any>> {
  const wf = JSON.parse(JSON.stringify(workflow))

  const inject = (mapping: { nodeId: string; inputKey: string } | undefined, value: any) => {
    if (!mapping) return
    const node = wf[mapping.nodeId]
    if (node?.inputs) {
      node.inputs[mapping.inputKey] = value
    }
  }

  inject(paramMap.model, params.model)
  inject(paramMap.positivePrompt, params.prompt)
  inject(paramMap.negativePrompt, params.negativePrompt || '')
  inject(paramMap.seed, params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed)
  inject(paramMap.steps, params.steps)
  inject(paramMap.cfgScale, params.cfgScale)
  inject(paramMap.width, params.width)
  inject(paramMap.height, params.height)
  inject(paramMap.batchSize, params.batchSize)
  inject(paramMap.sampler, params.sampler)
  inject(paramMap.scheduler, params.scheduler)

  if ('frames' in params) {
    inject(paramMap.frames, (params as VideoParams).frames)
    inject(paramMap.fps, (params as VideoParams).fps)
  }

  console.log('[workflows] Injected workflow nodes:', Object.entries(wf).map(([id, n]: [string, any]) =>
    `${id}: ${n.class_type} (${Object.keys(n.inputs || {}).join(', ')})`
  ).join(' | '))

  // Auto-resolve VAE and CLIP loaders with real model files
  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== 'object') continue
    const ct = node.class_type as string
    try {
      if (ct === 'VAELoader' && node.inputs) {
        const vae = await findMatchingVAE(modelType)
        node.inputs.vae_name = vae
      }
      if (ct === 'CLIPLoader' && node.inputs) {
        const clip = await findMatchingCLIP(modelType)
        node.inputs.clip_name = clip
        // Also set the CLIP type based on model type
        if (modelType === 'flux') node.inputs.type = 'flux'
        else if (modelType === 'flux2') node.inputs.type = 'flux2'
        else if (modelType === 'wan' || modelType === 'hunyuan') node.inputs.type = 'wan'
      }
    } catch (err) {
      console.warn(`[workflows] Failed to resolve ${ct} for ${modelType}:`, err)
    }
  }

  return wf
}

// ─── Detect workflow mode ───

function detectWorkflowMode(workflow: Record<string, any>): 'image' | 'video' | 'both' {
  const classTypes = Object.values(workflow)
    .filter((n) => n && typeof n === 'object')
    .map((n) => n.class_type as string)

  const hasVideo = classTypes.some((ct) =>
    ['EmptyHunyuanLatentVideo', 'ADE_LoadAnimateDiffModel', 'VHS_VideoCombine', 'SaveAnimatedWEBP'].includes(ct)
  )
  const hasImage = classTypes.some((ct) =>
    ['EmptyLatentImage', 'EmptySD3LatentImage', 'SaveImage'].includes(ct)
  )

  if (hasVideo && hasImage) return 'both'
  if (hasVideo) return 'video'
  return 'image'
}

// ─── Detect compatible model types from workflow ───

function detectModelTypes(workflow: Record<string, any>): ModelType[] {
  const classTypes = Object.values(workflow)
    .filter((n) => n && typeof n === 'object')
    .map((n) => n.class_type as string)

  const types: ModelType[] = []

  if (classTypes.includes('UNETLoader')) {
    if (classTypes.includes('EmptyHunyuanLatentVideo')) {
      types.push('wan', 'hunyuan')
    } else if (classTypes.includes('EmptySD3LatentImage')) {
      types.push('flux', 'flux2')
    } else {
      types.push('flux', 'flux2', 'wan', 'hunyuan')
    }
  }

  if (classTypes.includes('CheckpointLoaderSimple')) {
    types.push('sdxl', 'sd15')
  }

  if (classTypes.includes('ADE_LoadAnimateDiffModel')) {
    types.push('sdxl', 'sd15')
  }

  return types.length > 0 ? types : ['unknown']
}

// ─── Fetch workflow from URL (supports JSON and ZIP) ───

export async function fetchWorkflowFromUrl(url: string, apiKey?: string): Promise<Record<string, any>> {
  // Append CivitAI API key if provided and URL is from CivitAI
  let finalUrl = url
  if (apiKey && url.includes('civitai.com')) {
    const sep = url.includes('?') ? '&' : '?'
    finalUrl = `${url}${sep}token=${apiKey}`
  }
  // Route through backend proxy (works in both Tauri and dev mode)
  let buffer: ArrayBuffer
  try {
    buffer = await fetchExternalBytes(finalUrl)
  } catch (err) {
    throw new Error(`Failed to fetch workflow: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Detect content type from URL or try parsing
  const isLikelyZip = url.endsWith('.zip') || finalUrl.includes('/download/')

  // Handle ZIP archives (CivitAI downloads workflows as .zip)
  if (isLikelyZip) {
    try {
      const zip = await JSZip.loadAsync(buffer)
      // Try all files in the ZIP that could contain workflow JSON
      const jsonFiles = Object.entries(zip.files).filter(([name, f]) => !f.dir && (name.endsWith('.json') || name.endsWith('.txt')))
      // Sort: prefer .json files first
      jsonFiles.sort(([a], [b]) => (a.endsWith('.json') ? -1 : 1) - (b.endsWith('.json') ? -1 : 1))

      for (const [, file] of jsonFiles) {
        try {
          const text = await file.async('text')
          const json = JSON.parse(text)
          const resolved = resolveWorkflowJson(json)
          if (resolved) return resolved
        } catch { /* skip unparseable files */ }
      }
      // List files in ZIP for debugging
      const fileList = Object.keys(zip.files).join(', ')
      throw new Error(`No valid workflow found in ZIP. Files: ${fileList}`)
    } catch (err) {
      if (err instanceof Error && err.message.includes('No valid workflow')) throw err
      // Not actually a ZIP — try parsing as JSON
      const text = new TextDecoder().decode(buffer)
      try {
        const json = JSON.parse(text)
        const resolved = resolveWorkflowJson(json)
        if (resolved) return resolved
      } catch { /* not JSON either */ }
      throw new Error('Could not parse downloaded file as workflow.')
    }
  }

  // Try parsing as JSON
  try {
    const text = new TextDecoder().decode(buffer)
    const json = JSON.parse(text)
    const resolved = resolveWorkflowJson(json)
    if (resolved) return resolved
  } catch { /* not JSON */ }

  throw new Error('Invalid workflow format. Expected ComfyUI API or web format.')
}

// Try to extract a valid API-format workflow from various JSON structures
function resolveWorkflowJson(json: any): Record<string, any> | null {
  if (!json || typeof json !== 'object') return null

  // Direct API format
  if (isApiFormat(json)) return json

  // Web/UI format → convert
  if (isWebFormat(json)) return convertWebToApiFormat(json)

  // Wrapped in "prompt" or "workflow" key
  for (const key of ['prompt', 'workflow', 'output']) {
    if (json[key]) {
      if (isApiFormat(json[key])) return json[key]
      if (isWebFormat(json[key])) return convertWebToApiFormat(json[key])
    }
  }

  // Extra wrapper from ComfyUI export: { "extra": {...}, "prompt": {...} }
  if (json.extra && json.prompt && isApiFormat(json.prompt)) return json.prompt

  return null
}

function isApiFormat(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  return Object.values(obj).some(
    (node: any) => node && typeof node === 'object' && typeof node.class_type === 'string'
  )
}

function isWebFormat(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false
  return Array.isArray(obj.nodes) && obj.nodes.some((n: any) => n && typeof n.type === 'string')
}

// ─── Parse imported workflow into a template ───

export function parseImportedWorkflow(
  name: string,
  workflow: Record<string, any>,
  source: WorkflowSource = 'manual',
  sourceUrl?: string,
  description?: string,
): Omit<WorkflowTemplate, 'id' | 'installedAt'> {
  const parameterMap = autoDetectParameterMap(workflow)
  const mode = detectWorkflowMode(workflow)
  const modelTypes = detectModelTypes(workflow)

  return {
    name,
    description: description || `Imported from ${source}`,
    source,
    sourceUrl,
    modelTypes,
    mode,
    workflow,
    parameterMap,
  }
}

// ─── Built-in Templates ───

export function getBuiltinTemplates(): WorkflowSearchResult[] {
  return [
    {
      name: 'SDXL / SD 1.5 (Checkpoint)',
      description: 'Standard workflow for SDXL and SD 1.5 models. Uses CheckpointLoaderSimple with KSampler, VAEDecode and SaveImage.',
      source: 'manual',
      sourceUrl: '',
      modelTypes: ['sdxl', 'sd15'],
      mode: 'image',
      rawWorkflow: {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0 } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored' } },
      },
    },
    {
      name: 'FLUX / FLUX 2 (UNET + CLIP + VAE)',
      description: 'Workflow for FLUX and FLUX 2 models. Uses separate UNETLoader, CLIPLoader and VAELoader for modular architecture.',
      source: 'manual',
      sourceUrl: '',
      modelTypes: ['flux', 'flux2'],
      mode: 'image',
      rawWorkflow: {
        '1': { class_type: 'UNETLoader', inputs: { unet_name: 'model.safetensors', weight_dtype: 'default' } },
        '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'flux', device: 'default' } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
        '5': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '6': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['5', 0], seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0 } },
        '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
        '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'locally_uncensored' } },
      },
    },
    {
      name: 'Wan / Hunyuan Video',
      description: 'Video workflow for Wan 2.1/2.2 and Hunyuan models. Uses EmptyHunyuanLatentVideo for temporal latent space.',
      source: 'manual',
      sourceUrl: '',
      modelTypes: ['wan', 'hunyuan'],
      mode: 'video',
      rawWorkflow: {
        '1': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'wan', device: 'default' } },
        '2': { class_type: 'UNETLoader', inputs: { unet_name: 'model.safetensors', weight_dtype: 'default' } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } },
        '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } },
        '6': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 848, height: 480, length: 24, batch_size: 1 } },
        '7': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0 } },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
        '9': { class_type: 'SaveAnimatedWEBP', inputs: { images: ['8', 0], filename_prefix: 'locally_uncensored_vid', fps: 8, lossless: false, quality: 90, method: 'default' } },
      },
    },
  ]
}

// ─── CivitAI Search ───

interface CivitAIModel {
  id: number
  name: string
  description?: string
  type: string
  stats?: { downloadCount?: number; thumbsUpCount?: number; thumbsDownCount?: number }
  creator?: { username?: string }
  tags?: string[]
  modelVersions?: Array<{
    id: number
    name: string
    description?: string
    downloadUrl?: string
    images?: Array<{ url: string }>
    files?: Array<{ name: string; downloadUrl: string; type: string }>
  }>
}

export async function searchCivitai(query: string): Promise<WorkflowSearchResult[]> {
  try {
    const params = new URLSearchParams({
      query,
      types: 'Workflows',
      limit: '20',
      sort: 'Most Downloaded',
    })
    const text = await fetchExternal(`https://civitai.com/api/v1/models?${params}`)
    const data = JSON.parse(text)
    if (!data.items) {
      console.warn('[workflows] CivitAI returned no items')
      return []
    }
    const items: CivitAIModel[] = data.items ?? []

    return items.map((item) => {
      const version = item.modelVersions?.[0]
      const thumb = version?.images?.[0]?.url
      // Prefer the version downloadUrl, fall back to first file
      const downloadUrl = version?.downloadUrl ?? version?.files?.[0]?.downloadUrl

      // Build description with stats
      const descParts: string[] = []
      const rawDesc = (item.description ?? '').replace(/<[^>]*>/g, '').trim()
      if (rawDesc) descParts.push(rawDesc.slice(0, 150))
      if (item.stats) {
        const stats: string[] = []
        if (item.stats.downloadCount) stats.push(`${item.stats.downloadCount.toLocaleString()} Downloads`)
        if (item.stats.thumbsUpCount) stats.push(`${item.stats.thumbsUpCount.toLocaleString()} Likes`)
        if (stats.length > 0) descParts.push(stats.join(' | '))
      }
      if (item.creator?.username) descParts.push(`by ${item.creator.username}`)

      return {
        name: item.name || `CivitAI #${item.id}`,
        description: descParts.join(' — '),
        source: 'civitai' as const,
        sourceUrl: `https://civitai.com/models/${item.id}`,
        thumbnailUrl: thumb,
        modelTypes: ['unknown'] as ModelType[],
        mode: 'image' as const,
        downloadUrl,
      }
    })
  } catch (err) {
    console.warn('[workflows] CivitAI search failed:', err)
    return []
  }
}

// ─── Unified Search ───

export async function searchWorkflows(
  query: string,
  source: 'civitai' | 'templates'
): Promise<WorkflowSearchResult[]> {
  if (source === 'templates') {
    const templates = getBuiltinTemplates()
    if (!query.trim()) return templates
    const lower = query.toLowerCase()
    return templates.filter(t =>
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower) ||
      t.modelTypes.some(mt => mt.includes(lower))
    )
  }
  return searchCivitai(query)
}
