import type { ModelType } from './comfyui'
import type { GenerateParams, VideoParams } from './comfyui'
import { findMatchingVAE, findMatchingCLIP, getVAEModels, getCLIPModels } from './comfyui'
import { log } from '../lib/logger'
import { resolveRunSeed } from '../lib/run-seed'
import { applyParamOverrides, type WorkflowParamOverrides } from './workflow-params'
import {
  closestAspectRatio, detectPrompts, resolutionSelectorIds, withDetectedPrompts,
} from './workflow-graph-detect'
import type {
  WorkflowTemplate,
  WorkflowSource,
  ParameterMap,
  ParameterMapping,
} from '../types/workflows'
import type {
  ComfyApiGraph, ComfyInputValue, ComfyNodeInputs,
} from '../types/comfy-graph'
import {
  apiNodes, isComfyApiGraph,
  inputNumber,
} from '../types/comfy-graph'

// ─── Validation ───
//
// The JSON walked here arrives from a file the user picked or a download, so
// no field is guaranteed. The shapes and the guards live in
// types/comfy-graph.ts; nothing below reads a field it has not narrowed first.

/**
 * Accepts ONLY the ComfyUI API graph format ({ "1": { class_type, inputs }, ... }).
 *
 * R2-32: this used to accept the Web/UI export format too ({ nodes: [...],
 * links: [...] }), but every caller downstream (parameterMap detection,
 * parameter injection, apiNodes) reads `class_type`/`inputs`, fields the
 * Web/UI format does not carry. A Web/UI export therefore passed validation
 * and then failed silently later, with the modal's own advice ("Export it
 * from ComfyUI using Save (API Format)") never shown because validation had
 * already said yes. Narrowed to the one shape every caller actually needs.
 *
 * The Web/UI format is importable again (GitHub Discussion #124), but not
 * here: workflow-import.ts converts it to this API format first, through the
 * node definitions of the running ComfyUI (comfy-ui-format.ts).
 */
export function validateWorkflowJson(json: unknown): json is ComfyApiGraph {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  // API format: { "1": { class_type: "...", inputs: {...} }, ... }
  return isComfyApiGraph(json)
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

export function autoDetectParameterMap(workflow: ComfyApiGraph): ParameterMap {
  const map: ParameterMap = {}

  for (const [nodeId, node] of apiNodes(workflow)) {
    const ct = node.class_type
    if (ct === 'KSampler' || ct === 'KSamplerAdvanced') {
      map.seed = { nodeId, inputKey: 'seed' }
      map.steps = { nodeId, inputKey: 'steps' }
      map.cfgScale = { nodeId, inputKey: 'cfg' }
      map.sampler = { nodeId, inputKey: 'sampler_name' }
      map.scheduler = { nodeId, inputKey: 'scheduler' }
      break
    }
  }

  // The prompt boxes, from the positive and negative inputs of the sampler
  // or guider back to the text encoders (GitHub #196). Only a graph where
  // no such wire leads to an encoder falls back to the order of the
  // CLIPTextEncode nodes further down.
  const prompts = detectPrompts(workflow)
  if (prompts?.positive) map.positivePrompt = prompts.positive
  if (prompts?.negative) map.negativePrompt = prompts.negative

  for (const [nodeId, node] of apiNodes(workflow)) {
    const ct = node.class_type

    switch (ct) {
      case 'CheckpointLoaderSimple':
        map.model = { nodeId, inputKey: 'ckpt_name', loaderType: 'checkpoint' }
        break
      case 'UNETLoader':
        map.model = { nodeId, inputKey: 'unet_name', loaderType: 'unet' }
        break
      // A GGUF quant runs through the ComfyUI-GGUF loader, which names its
      // model input the same way. The Wan 2.2 Animate example workflow of
      // QuantStack is built on it (Discord, 15.10.2026).
      case 'UnetLoaderGGUF':
        if (!map.model) map.model = { nodeId, inputKey: 'unet_name', loaderType: 'unet' }
        break
      // The driving clip of a Motion Control workflow: ComfyUI's own loader
      // or the one of Video Helper Suite. The first one wins, like LoadImage.
      case 'LoadVideo':
        if (!map.inputVideo) map.inputVideo = { nodeId, inputKey: 'file' }
        break
      case 'VHS_LoadVideo':
        if (!map.inputVideo) map.inputVideo = { nodeId, inputKey: 'video' }
        break
      case 'LoadImage':
        // A custom I2I/I2V workflow may contain more than one image
        // loader. Use the first one as its primary LU source image.
        if (!map.inputImage) {
          map.inputImage = {
            nodeId,
            inputKey: 'image',
          }
        }
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
      case 'ImageResizeKJv2':
        if (!map.width && inputNumber(node, 'width') !== undefined) {
          map.width = {
            nodeId,
            inputKey: 'width',
          }
        }

        if (!map.height && inputNumber(node, 'height') !== undefined) {
          map.height = {
            nodeId,
            inputKey: 'height',
          }
        }
        break
      case 'SaveAnimatedWEBP':
        map.fps = { nodeId, inputKey: 'fps' }
        break
      case 'VHS_VideoCombine':
        map.fps = { nodeId, inputKey: 'frame_rate' }
        break
    }
  }

  if (!prompts) {
    const clipNodes = apiNodes(workflow).filter(
      ([, n]) => n.class_type === 'CLIPTextEncode'
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
  workflow: ComfyApiGraph,
  storedMap: ParameterMap,
  params: GenerateParams | VideoParams,
  modelType: ModelType,
  /** The values the user changed under "Workflow parameters" (workflow-params.ts). */
  overrides?: WorkflowParamOverrides,
): Promise<ComfyApiGraph> {
  // Deep clone: the caller's template must not be mutated. A JSON round-trip
  // of a ComfyApiGraph is a ComfyApiGraph by construction.
  const wf: ComfyApiGraph = JSON.parse(JSON.stringify(workflow))

  const inject = (
    mapping: { nodeId: string; inputKey: string } | undefined,
    value: ComfyInputValue | undefined,
  ) => {
    if (!mapping) return
    const node = wf[mapping.nodeId]
    if (node?.inputs) {
      // Assigning undefined is deliberate and load-bearing: JSON.stringify
      // drops the key, so the node falls back to ComfyUI's own default rather
      // than keeping the template's value.
      const inputs: ComfyNodeInputs = node.inputs
      inputs[mapping.inputKey] = value
    }
  }

  // The prompt boxes are read again from the graph: a map saved by an older
  // LU may name the negative box as the positive one (GitHub #196).
  const paramMap = withDetectedPrompts(wf, storedMap)

  inject(paramMap.model, params.model)
  inject(paramMap.positivePrompt, params.prompt)
  inject(paramMap.negativePrompt, params.negativePrompt || '')
  inject(paramMap.seed, resolveRunSeed(params.seed))
  inject(paramMap.steps, params.steps)
  inject(paramMap.cfgScale, params.cfgScale)
  let widthMapping = paramMap.width
  let heightMapping = paramMap.height

  // Older installed custom I2V workflows may predate resize-node
  // detection. Locate their source resize node at generation time so
  // users do not have to remove and re-import the workflow.
  if (!widthMapping || !heightMapping) {
    const resizeEntry = apiNodes(wf).find(
      ([, node]) =>
        node.class_type === 'ImageResizeKJv2' &&
        inputNumber(node, 'width') !== undefined &&
        inputNumber(node, 'height') !== undefined,
    )

    if (resizeEntry) {
      if (!widthMapping) {
        widthMapping = {
          nodeId: resizeEntry[0],
          inputKey: 'width',
        }
      }

      if (!heightMapping) {
        heightMapping = {
          nodeId: resizeEntry[0],
          inputKey: 'height',
        }
      }
    }
  }

  inject(widthMapping, params.width)
  inject(heightMapping, params.height)

  // No width and height to write, but a ResolutionSelector (aspect ratio
  // plus megapixels, as in the LTX 2.5 templates): pick the aspect ratio
  // closest to LU's size and keep the workflow's megapixels (GitHub #196).
  if (!widthMapping && !heightMapping) {
    const aspect = closestAspectRatio(params.width, params.height)
    if (aspect) {
      for (const id of resolutionSelectorIds(wf)) {
        const node = wf[id]
        if (node.inputs) node.inputs.aspect_ratio = aspect
      }
    }
  }
  inject(paramMap.batchSize, params.batchSize)
  inject(paramMap.sampler, params.sampler)
  inject(paramMap.scheduler, params.scheduler)

  const inputImage =
    'inputImage' in params &&
    typeof params.inputImage === 'string'
      ? params.inputImage
      : undefined

  if (inputImage) {
    let inputImageMapping = paramMap.inputImage

    // Workflows installed before inputImage mapping existed have an older
    // persisted parameterMap. Detect their LoadImage node at generation time
    // so users do not have to remove and re-import those workflows.
    if (!inputImageMapping) {
      const loadImageEntry = apiNodes(wf).find(
        ([, node]) => node.class_type === 'LoadImage',
      )

      if (loadImageEntry) {
        inputImageMapping = {
          nodeId: loadImageEntry[0],
          inputKey: 'image',
        }
      }
    }

    inject(inputImageMapping, inputImage)
  }

  if ('frames' in params) {
    inject(paramMap.frames, (params as VideoParams).frames)
    inject(paramMap.fps, (params as VideoParams).fps)

    forceSavedOutput(wf)
  }

  log.info('[workflows] Injected workflow nodes', { nodes: apiNodes(wf).map(([id, n]) =>
    `${id}: ${n.class_type} (${Object.keys(n.inputs || {}).join(', ')})`
  ).join(' | ') })

  // VAE and CLIP loaders: the file the workflow names stays when ComfyUI
  // has it. A workflow with more than one of them (LTX 2.5: a video and an
  // audio VAE, a text encoder and a prompt enhancer) needs each one as it
  // is; one pick for all of them breaks it (GitHub #196). Only a file this
  // ComfyUI lacks is replaced by a matching one.
  let vaeFiles: Set<string> | undefined
  let clipFiles: Set<string> | undefined
  const installed = async (read: () => Promise<string[]>): Promise<Set<string>> => {
    try { return new Set(await read()) } catch { return new Set() }
  }
  for (const [, node] of apiNodes(wf)) {
    const ct = node.class_type
    try {
      if (ct === 'VAELoader' && node.inputs) {
        const named = node.inputs.vae_name
        if (typeof named === 'string') {
          vaeFiles ??= await installed(getVAEModels)
          if (vaeFiles.has(named)) continue
        }
        const vae = await findMatchingVAE(modelType)
        node.inputs.vae_name = vae
      }
      if (ct === 'CLIPLoader' && node.inputs) {
        const named = node.inputs.clip_name
        if (typeof named === 'string') {
          clipFiles ??= await installed(getCLIPModels)
          // The workflow's encoder stays, and with it the type it was saved with.
          if (clipFiles.has(named)) continue
        }
        const clip = await findMatchingCLIP(modelType)
        node.inputs.clip_name = clip
        // Also set the CLIP type based on model type
        if (modelType === 'flux') node.inputs.type = 'flux'
        else if (modelType === 'flux2') node.inputs.type = 'flux2'
        else if (modelType === 'wan' || modelType === 'hunyuan') node.inputs.type = 'wan'
      }
    } catch (err) {
      log.warn(`[workflows] Failed to resolve ${ct} for ${modelType}`, { err })
    }
  }

  // Last, so a VAE or text encoder the user picked replaces LU's own pick.
  return applyParamOverrides(wf, paramMap, overrides)
}

/**
 * A VHS_VideoCombine left on save_output:false writes the clip to ComfyUI's
 * temp folder, where the gallery cannot play it back. Every run of a video
 * workflow of the user's own turns it on: the normal run and the Motion
 * Control run. (SaveVideo and SaveAnimatedWEBP always write to output.)
 */
export function forceSavedOutput(wf: ComfyApiGraph): void {
  for (const [, node] of apiNodes(wf)) {
    if (node.class_type === 'VHS_VideoCombine' && node.inputs) {
      node.inputs.save_output = true
    }
  }
}

// ─── Lane injection (Motion Control) ───

export interface LaneWorkflowInputs {
  model: string
  seed: number
  /** The character picture, as uploaded to ComfyUI. */
  refImage?: string
  /** The driving clip, as uploaded to ComfyUI. */
  drivingVideo?: string
}

/**
 * Fill a user's own Motion Control workflow with what the Motion Control tab
 * holds: the model, the seed, the character picture and the driving clip.
 * Nothing else is touched. The tab has no prompt field, so the workflow keeps
 * its own prompts (the store's prompt and negative prompt belong to other
 * tabs and would steer the run unseen); they are edited in its list. Such a workflow is tuned as a whole
 * (the Wan 2.2 Animate example runs 6 steps at CFG 1 with a speed LoRA and
 * crops the face to 512 by 512), and the sliders of the tab would undo that.
 * A field the workflow has no node for is left as it was saved.
 */
export function injectLaneParameters(
  workflow: ComfyApiGraph,
  paramMap: ParameterMap,
  inputs: LaneWorkflowInputs,
  overrides?: WorkflowParamOverrides,
): ComfyApiGraph {
  const wf: ComfyApiGraph = JSON.parse(JSON.stringify(workflow))
  const set = (mapping: ParameterMapping | undefined, value: ComfyInputValue | undefined) => {
    if (!mapping || value === undefined || value === '') return
    const node = wf[mapping.nodeId]
    if (node?.inputs) node.inputs[mapping.inputKey] = value
  }
  set(paramMap.model, inputs.model)
  set(paramMap.seed, resolveRunSeed(inputs.seed))
  set(paramMap.inputImage, inputs.refImage)
  set(paramMap.inputVideo, inputs.drivingVideo)
  // The result goes to the gallery, not to ComfyUI's temp folder.
  forceSavedOutput(wf)
  // Values the user changed for this workflow in Advanced settings. Only the
  // fields set above are LU's here (LANE_SET_FIELDS): steps, CFG, sampler,
  // size and the rest are the workflow's, and a value changed in the list
  // for them arrives.
  return applyParamOverrides(wf, paramMap, overrides, 'lane')
}

// ─── Detect workflow mode ───

/** The conditioner node that tells a Wan lane workflow apart. A workflow
 *  built around one of them runs that lane's model and nothing else. */
const LANE_CONDITIONERS: Array<[string, ModelType]> = [
  ['WanAnimateToVideo', 'wananimate'],
  ['WanVaceToVideo', 'wanvace'],
  ['WanSoundImageToVideo', 'wans2v'],
]

function detectWorkflowMode(workflow: ComfyApiGraph): 'image' | 'video' | 'both' {
  const classTypes = apiNodes(workflow).map(([, n]) => n.class_type)

  const hasVideo = classTypes.some((ct) =>
    ['EmptyHunyuanLatentVideo', 'ADE_LoadAnimateDiffModel', 'VHS_VideoCombine', 'SaveAnimatedWEBP',
      'SaveVideo', 'CreateVideo', ...LANE_CONDITIONERS.map(([node]) => node)].includes(ct)
  )
  const hasImage = classTypes.some((ct) =>
    ['EmptyLatentImage', 'EmptySD3LatentImage', 'SaveImage'].includes(ct)
  )

  if (hasVideo && hasImage) return 'both'
  if (hasVideo) return 'video'
  return 'image'
}

// ─── Detect compatible model types from workflow ───

function detectModelTypes(workflow: ComfyApiGraph): ModelType[] {
  const classTypes = apiNodes(workflow).map(([, n]) => n.class_type)

  const lane = LANE_CONDITIONERS.filter(([node]) => classTypes.includes(node)).map(([, type]) => type)
  if (lane.length > 0) return lane

  const types: ModelType[] = []

  if (classTypes.includes('UNETLoader') || classTypes.includes('UnetLoaderGGUF')) {
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

// ─── Parse imported workflow into a template ───

export function parseImportedWorkflow(
  name: string,
  workflow: ComfyApiGraph,
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
