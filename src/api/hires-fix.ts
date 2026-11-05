import {
  apiNodes,
  isComfyApiNode,
  isComfyLinkRef,
  nodeInput,
  type ComfyApiGraph,
  type ComfyApiNode,
  type ComfyInputValue,
  type ComfyNodeInputs,
} from '../types/comfy-graph'
import { propPath } from '../types/json-guards'

export type HiresUpscaleMethod =
  | 'nearest-exact'
  | 'bilinear'
  | 'area'
  | 'bicubic'
  | 'bislerp'

export interface NativeHiresFixOptions {
  baseWidth: number
  baseHeight: number
  scale: number
  denoise: number
  steps: number
  upscaleMethod: HiresUpscaleMethod
  /**
   * How many pixels one latent cell of this model covers (`latentDownscale`).
   * It only names the result and keeps the 4096 limit: the node scales the
   * latent the first pass made by `scale`, whatever its grid.
   */
  latentDownscale?: number
}

/**
 * A node this transform WRITES: ComfyUI's own `_meta.title` plus LU's re-entry
 * marker. The marker is declared here and not in types/comfy-graph.ts because
 * nothing outside this file writes or reads `luNativeHiresFix`; a HiresNode is
 * still a ComfyApiNode everywhere else.
 */
interface HiresNode extends Omit<ComfyApiNode, '_meta'> {
  _meta?: { title?: string; luNativeHiresFix?: boolean }
}

export interface NativeHiresFixResult {
  workflow: ComfyApiGraph
  width: number
  height: number
  upscaleNodeId: string
  samplerNodeId: string
}

export class NativeHiresFixError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeHiresFixError'
  }
}

const IMAGE_OUTPUT_NODES = new Set(['SaveImage', 'PreviewImage'])
const IMAGE_DECODE_NODES = new Set(['VAEDecode', 'VAEDecodeTiled'])
// A latent that carries a painted mask. A second pass over a larger copy of it
// would refine only the masked part and leave the rest as a stretched latent,
// and InpaintModelConditioning's concat image stays at the old size, so the
// pass is refused for these instead of making a worse picture.
const MASKED_LATENT_NODES = new Set(['VAEEncodeForInpaint', 'InpaintModelConditioning', 'SetLatentNoiseMask'])
const UPSCALE_METHODS: ReadonlySet<HiresUpscaleMethod> = new Set([
  'nearest-exact',
  'bilinear',
  'area',
  'bicubic',
  'bislerp',
])

function cloneWorkflow(workflow: ComfyApiGraph): ComfyApiGraph {
  if (typeof structuredClone === 'function') return structuredClone(workflow)
  // Fallback for a runtime without structuredClone. The round-trip preserves
  // the shape that just type-checked on the way in, so this re-states the
  // input's type rather than claiming a new one — it narrows JSON.parse's
  // `any` back to what was handed in, it does not widen anything.
  return JSON.parse(JSON.stringify(workflow)) as ComfyApiGraph
}

/** One node of the graph, or undefined when that key holds something else. */
function nodeAt(workflow: ComfyApiGraph, id: string): ComfyApiNode | undefined {
  const node: unknown = workflow[id]
  return isComfyApiNode(node) ? node : undefined
}

function nextNodeId(workflow: ComfyApiGraph): string {
  let candidate = Object.keys(workflow).reduce((max, id) => {
    const parsed = Number(id)
    return Number.isInteger(parsed) && parsed >= 0 ? Math.max(max, parsed) : max
  }, 0) + 1

  while (String(candidate) in workflow) candidate++
  return String(candidate)
}

/**
 * Pixels per latent cell, per model family: `spacial_downscale_ratio` of the
 * latent format ComfyUI 0.38.0 gives each model (comfy/latent_formats.py and
 * supported_models.py, read on the box 22.10.2026). Qwen-Image 2.1 (and Noct
 * Q, its finetune), FLUX 2 and ERNIE-Image compress 16x, Wan 2.2 TI2V-5B too.
 * Every other family LU draws pictures with is 8x: SDXL, SD 1.5, FLUX 1 and
 * Krea 1, Krea 2 and Qwen-Image 1 (Wan 2.1 VAE), Chroma, HiDream, SD 3.5,
 * Lumina 2, Z-Image and Wan 2.1/2.2 14B.
 */
export function latentDownscale(modelType: string | undefined): number {
  return modelType === 'qwenimage' || modelType === 'flux2' || modelType === 'ernie_image' || modelType === 'wan22' ? 16 : 8
}

/** Python's round(): halves go to the even neighbour (LatentUpscaleBy). */
function roundHalfEven(value: number): number {
  const down = Math.floor(value)
  if (value - down !== 0.5) return Math.round(value)
  return down % 2 === 0 ? down : down + 1
}

/** One side after the pass: the first pass's latent side times the factor,
 *  rounded as LatentUpscaleBy rounds it, back in pixels. */
function upscaledSide(base: number, scale: number, grid: number): number {
  return Math.max(1, roundHalfEven(Math.floor(base / grid) * scale)) * grid
}

export function nativeHiresFinalSize(
  baseWidth: number,
  baseHeight: number,
  scale: number,
  latentGrid = 8,
): { width: number; height: number } {
  if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth < 64 || baseHeight < 64) {
    throw new NativeHiresFixError('Native HiRes needs a valid base width and height of at least 64 px.')
  }
  if (!Number.isFinite(scale) || scale <= 1 || scale > 3) {
    throw new NativeHiresFixError('Native HiRes scale must be greater than 1.0 and no more than 3.0.')
  }

  const grid = Number.isInteger(latentGrid) && latentGrid > 0 ? latentGrid : 8
  const width = upscaledSide(baseWidth, scale, grid)
  const height = upscaledSide(baseHeight, scale, grid)

  if (width > 4096 || height > 4096) {
    throw new NativeHiresFixError(
      `Native HiRes would produce ${width}×${height}. Lower the base resolution or upscale factor so both sides stay at or below 4096 px.`,
    )
  }

  return { width, height }
}

/**
 * The KSampler a SamplerCustomAdvanced stands for, when it is fed by a
 * CFGGuider, a RandomNoise and a KSamplerSelect (the Qwen-Image 2.1 Turbo
 * chain). Its own sigmas cover a full run from noise, so the refinement pass
 * takes the simple scheduler at the pass's own steps and denoise. Undefined
 * for any other feed, which keeps the refusal below.
 */
function customAsKSampler(workflow: ComfyApiGraph, custom: ComfyApiNode): ComfyApiNode | undefined {
  const fed = (key: string, type: string): ComfyApiNode | undefined => {
    const ref = nodeInput(custom, key)
    const node = isComfyLinkRef(ref) ? nodeAt(workflow, String(ref[0])) : undefined
    return node?.class_type === type ? node : undefined
  }
  const guider = fed('guider', 'CFGGuider')
  const noise = fed('noise', 'RandomNoise')
  const sampler = fed('sampler', 'KSamplerSelect')
  if (!guider || !noise || !sampler) return undefined
  const read: Record<string, ComfyInputValue | undefined> = {
    model: nodeInput(guider, 'model'),
    positive: nodeInput(guider, 'positive'),
    negative: nodeInput(guider, 'negative'),
    latent_image: nodeInput(custom, 'latent_image'),
    seed: nodeInput(noise, 'noise_seed'),
    steps: 1,
    cfg: nodeInput(guider, 'cfg'),
    sampler_name: nodeInput(sampler, 'sampler_name'),
    scheduler: 'simple',
    denoise: 1,
  }
  // A missing input stays out, so the check for the four links below names it.
  const inputs: ComfyNodeInputs = {}
  for (const [key, value] of Object.entries(read)) if (value !== undefined) inputs[key] = value
  return { class_type: 'KSampler', inputs }
}

/**
 * Adds a native latent-upscale refinement pass to a simple image workflow:
 *
 *   KSampler → LatentUpscaleBy → KSampler (low denoise) → VAEDecode → SaveImage
 *
 * The latent is scaled BY the factor, never TO a pixel size. ComfyUI's
 * LatentUpscale divides the pixel size by 8 whatever the model, so on a
 * model whose latent covers 16 pixels a cell it made the latent twice the
 * asked size on each side, and the picture came out at four times the base
 * (Discord #bug-reports 22.10.2026, Qwen-Image 2.1 and Noct Q: 768×1360 at
 * 2x gave 3072×5440 with doubled faces). LatentUpscaleBy reads the latent it
 * gets, so the same graph is right on every grid, Create and Edit alike (an
 * edit's canvas follows the source, lib/edit-hires).
 *
 * The transform deliberately targets the terminal image decode rather than
 * assuming fixed node IDs, so it works with LU's dynamic/legacy image builders
 * and compatible imported workflows. Workflows whose final image is not fed by
 * a core KSampler are rejected with an actionable message instead of being
 * silently changed incorrectly.
 */
export function applyNativeHiresFix(
  sourceWorkflow: ComfyApiGraph,
  options: NativeHiresFixOptions,
): NativeHiresFixResult {
  // ComfyApiGraph is a claim about a file the user may have downloaded, not a
  // guarantee (see its doc comment), so the runtime check stays and every walk
  // below goes through the comfy-graph guards.
  if (!sourceWorkflow || typeof sourceWorkflow !== 'object') {
    throw new NativeHiresFixError('Native HiRes received an invalid ComfyUI workflow.')
  }
  if (!Number.isFinite(options.denoise) || options.denoise <= 0 || options.denoise > 1) {
    throw new NativeHiresFixError('Native HiRes denoise must be greater than 0 and no more than 1.')
  }
  if (!Number.isFinite(options.steps) || options.steps < 1 || options.steps > 200) {
    throw new NativeHiresFixError('Native HiRes steps must be between 1 and 200.')
  }
  if (!UPSCALE_METHODS.has(options.upscaleMethod)) {
    throw new NativeHiresFixError(`Unsupported Native HiRes upscale method: ${options.upscaleMethod}`)
  }

  const { width, height } = nativeHiresFinalSize(
    options.baseWidth,
    options.baseHeight,
    options.scale,
    options.latentDownscale,
  )
  const workflow = cloneWorkflow(sourceWorkflow)

  // Scans every VALUE, not just the valid nodes: the marker check has to see a
  // half-written LU node too, or a second pass would append to the first.
  if (Object.values(workflow).some((node) => propPath(node, '_meta', 'luNativeHiresFix') === true)) {
    throw new NativeHiresFixError('This workflow already contains LU Native HiRes nodes.')
  }

  const terminalDecodeIds = new Set<string>()
  for (const [, node] of apiNodes(workflow)) {
    if (!IMAGE_OUTPUT_NODES.has(node.class_type)) continue
    const imageRef = nodeInput(node, 'images')
    if (!isComfyLinkRef(imageRef)) continue
    const decodeId = String(imageRef[0])
    const decode = nodeAt(workflow, decodeId)
    if (decode && IMAGE_DECODE_NODES.has(decode.class_type)) terminalDecodeIds.add(decodeId)
  }

  if (terminalDecodeIds.size !== 1) {
    throw new NativeHiresFixError(
      terminalDecodeIds.size === 0
        ? 'Native HiRes could not find a final VAEDecode → SaveImage path. Use Auto or a compatible image workflow.'
        : 'Native HiRes found multiple final image decode paths. Use Auto or a workflow with one final image output.',
    )
  }

  const decodeId = [...terminalDecodeIds][0]
  // Guaranteed by the scan above — it only records ids that resolved to a
  // decode node — but read back through the guard so nothing here asserts it.
  const decode = nodeAt(workflow, decodeId)
  const samplesRef = nodeInput(decode, 'samples')
  if (!isComfyLinkRef(samplesRef) || !decode) {
    throw new NativeHiresFixError('Native HiRes could not find the sampler feeding the final image decode.')
  }

  const firstSamplerId = String(samplesRef[0])
  const found = nodeAt(workflow, firstSamplerId)
  // Qwen-Image 2.1 Turbo's chain (lib/render/qwen21-turbo) ends in a
  // SamplerCustomAdvanced; its pass reads the same model, prompt, CFG, seed
  // and sampler off the CFGGuider, RandomNoise and KSamplerSelect.
  const firstSampler = found?.class_type === 'SamplerCustomAdvanced' ? customAsKSampler(workflow, found) : found
  if (!firstSampler || firstSampler.class_type !== 'KSampler') {
    throw new NativeHiresFixError(
      `Native HiRes currently requires a core KSampler before the final decode; this workflow uses ${found?.class_type ?? 'an unknown node'}.`,
    )
  }

  const requiredInputs = ['model', 'positive', 'negative', 'latent_image']
  const missing = requiredInputs.filter((key) => nodeInput(firstSampler, key) === undefined)
  if (missing.length > 0) {
    throw new NativeHiresFixError(`The final KSampler is missing required inputs: ${missing.join(', ')}.`)
  }

  const latentRef = nodeInput(firstSampler, 'latent_image')
  let latentSource = isComfyLinkRef(latentRef) ? nodeAt(workflow, String(latentRef[0])) : undefined
  // An edit batch (api/edit-batch) repeats the source latent; the mask is
  // the one of the latent it repeats.
  if (latentSource?.class_type === 'RepeatLatentBatch') {
    const repeated = nodeInput(latentSource, 'samples')
    latentSource = isComfyLinkRef(repeated) ? nodeAt(workflow, String(repeated[0])) : undefined
  }
  if (latentSource && MASKED_LATENT_NODES.has(latentSource.class_type)) {
    throw new NativeHiresFixError(
      'Native HiRes runs on edits of the whole picture. Clear the mask, or turn Native HiRes off for this edit.',
    )
  }

  const upscaleNodeId = nextNodeId(workflow)
  const upscaleNode: HiresNode = {
    class_type: 'LatentUpscaleBy',
    inputs: {
      samples: [firstSamplerId, samplesRef[1]],
      upscale_method: options.upscaleMethod,
      scale_by: options.scale,
    },
    _meta: {
      title: 'LU Native HiRes — latent upscale',
      luNativeHiresFix: true,
    },
  }
  workflow[upscaleNodeId] = upscaleNode

  const samplerNodeId = nextNodeId(workflow)
  const refinementNode: HiresNode = {
    class_type: 'KSampler',
    inputs: {
      ...firstSampler.inputs,
      latent_image: [upscaleNodeId, 0],
      steps: Math.floor(options.steps),
      denoise: options.denoise,
    },
    _meta: {
      title: 'LU Native HiRes — refinement pass',
      luNativeHiresFix: true,
    },
  }
  workflow[samplerNodeId] = refinementNode

  decode.inputs = {
    ...decode.inputs,
    samples: [samplerNodeId, 0],
  }

  return {
    workflow,
    width,
    height,
    upscaleNodeId,
    samplerNodeId,
  }
}
