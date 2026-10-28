/**
 * What LU reads out of the graph of an imported workflow beyond fixed node
 * types (GitHub #196, the LTX 2.5 image-to-video template of Comfy-Org):
 *
 *  - Which text box is the positive prompt and which the negative one. A
 *    workflow without a KSampler (LTXVConditioning into a guider, as the LTX
 *    templates do) used to fall back to "the first CLIPTextEncode is the
 *    positive one", and in that template the first one is the negative. The
 *    roles are read from the wires instead: from the `positive` and
 *    `negative` inputs of a sampler or guider back to the text encoders.
 *  - The ResolutionSelector of ComfyUI (aspect ratio plus megapixels), which
 *    sets the size where no width and height input exists to write.
 *
 * Pure, and only reads types, so workflows.ts and workflow-params.ts can both
 * use it without an import cycle.
 */
import type { ParameterMap, ParameterMapping } from '../types/workflows'
import type { ComfyApiGraph, ComfyApiNode } from '../types/comfy-graph'
import { apiNodes, isComfyLinkRef } from '../types/comfy-graph'

// ── Prompts ─────────────────────────────────────────────────────

export interface DetectedPrompts {
  positive?: ParameterMapping
  negative?: ParameterMapping
}

/** Inputs a plain text box keeps its text in, in the order they are tried. */
const TEXT_BOX_KEYS = ['value', 'text', 'string', 'prompt'] as const
const MAX_HOPS = 32

type LinkRef = [string, number]

function linkOf(v: unknown): LinkRef | undefined {
  return isComfyLinkRef(v) ? [String(v[0]), Number(v[1])] : undefined
}

function linkedInputs(node: ComfyApiNode): LinkRef[] {
  return Object.values(node.inputs ?? {}).map(linkOf).filter((l): l is LinkRef => l !== undefined)
}

/** Samplers first, then guiders, then any other node fed both roles. */
function consumerRank(classType: string): number {
  if (classType === 'KSampler' || classType === 'KSamplerAdvanced') return 0
  if (/guider/i.test(classType)) return 1
  return 2
}

/**
 * From a conditioning wire back to the node that encodes the text. Nodes
 * that pass both roles on (LTXVConditioning, WanImageToVideo, ControlNet
 * apply) put positive on output 0 and negative on output 1, a node with one
 * `conditioning` input (ConditioningZeroOut) passes that one on.
 */
function traceEncoder(wf: ComfyApiGraph, start: unknown, role: 'positive' | 'negative'): string | undefined {
  let ref = linkOf(start)
  for (let hop = 0; ref && hop < MAX_HOPS; hop++) {
    const [id, slot] = ref
    const node = wf[id]
    if (!node?.inputs) return undefined
    const inputs = node.inputs
    if ('text' in inputs) return id
    if (linkOf(inputs.positive) && linkOf(inputs.negative)) {
      ref = linkOf(slot === 0 ? inputs.positive : slot === 1 ? inputs.negative : inputs[role])
      continue
    }
    ref = linkOf(inputs.conditioning)
  }
  return undefined
}

/**
 * Where the text of an encoder can be written. Its own `text` when that holds
 * the text; when the text arrives over a wire (a prompt box, maybe through a
 * prompt enhancer and a switch), the nearest text box upstream, so the wire
 * and whatever sits on it keep working.
 */
function textTarget(wf: ComfyApiGraph, encoderId: string): ParameterMapping | undefined {
  const text = wf[encoderId]?.inputs?.text
  if (typeof text === 'string') return { nodeId: encoderId, inputKey: 'text' }
  const queue: string[] = []
  const first = linkOf(text)
  if (first) queue.push(first[0])
  const seen = new Set<string>([encoderId])
  while (queue.length > 0 && seen.size < 256) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    const node = wf[id]
    if (!node?.inputs) continue
    const key = TEXT_BOX_KEYS.find((k) => typeof node.inputs?.[k] === 'string')
    if (key) return { nodeId: id, inputKey: key }
    for (const [next] of linkedInputs(node)) queue.push(next)
  }
  return undefined
}

/**
 * The prompt boxes, read from the wires. `null` when no node in the graph
 * takes both a positive and a negative input that lead to a text encoder;
 * the caller then falls back to its own guess.
 */
export function detectPrompts(wf: ComfyApiGraph): DetectedPrompts | null {
  const consumers = apiNodes(wf)
    .filter(([, n]) => linkOf(n.inputs?.positive) && linkOf(n.inputs?.negative))
    .map((entry, order) => ({ entry, order, rank: consumerRank(entry[1].class_type) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
  for (const { entry: [, node] } of consumers) {
    const pos = traceEncoder(wf, node.inputs?.positive, 'positive')
    if (!pos) continue
    const neg = traceEncoder(wf, node.inputs?.negative, 'negative')
    const out: DetectedPrompts = {}
    const positive = textTarget(wf, pos)
    if (positive) out.positive = positive
    // A negative made from the positive (ConditioningZeroOut) has no box of its own.
    const negative = neg && neg !== pos ? textTarget(wf, neg) : undefined
    if (negative && (negative.nodeId !== positive?.nodeId || negative.inputKey !== positive?.inputKey)) {
      out.negative = negative
    }
    return out
  }
  return null
}

/**
 * The stored map with its prompt boxes read again from the graph. The map is
 * saved at import, so a workflow imported before the wires were read (3.0.8
 * and older) may still name the negative box as the positive one. The map is
 * only ever written by autoDetectParameterMap, never by hand, so reading the
 * roles again on every run loses nothing and mends those imports in place.
 */
export function withDetectedPrompts(wf: ComfyApiGraph, map: ParameterMap): ParameterMap {
  const found = detectPrompts(wf)
  if (!found) return map
  const out: ParameterMap = { ...map }
  if (found.positive) out.positivePrompt = found.positive
  else delete out.positivePrompt
  if (found.negative) out.negativePrompt = found.negative
  else delete out.negativePrompt
  return out
}

// ── Aspect ratio ────────────────────────────────────────────────

/**
 * The options of ResolutionSelector.aspect_ratio in ComfyUI v0.42.4
 * (comfy_extras/nodes_resolution.py, AspectRatio). A label starts with its
 * ratio, so a newer ComfyUI with more options still reads.
 */
export const RESOLUTION_SELECTOR_ASPECTS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
] as const

function ratioOf(label: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(label)
  if (!m) return undefined
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? w / h : undefined
}

/** The option whose ratio comes closest to width by height, or undefined. */
export function closestAspectRatio(
  width: number,
  height: number,
  options: readonly string[] = RESOLUTION_SELECTOR_ASPECTS,
): string | undefined {
  if (!(width > 0) || !(height > 0)) return undefined
  const target = Math.log(width / height)
  let best: string | undefined
  let bestDistance = Infinity
  for (const option of options) {
    const r = ratioOf(option)
    if (r === undefined) continue
    const distance = Math.abs(Math.log(r) - target)
    if (distance < bestDistance) { best = option; bestDistance = distance }
  }
  return best
}

/** The ResolutionSelector nodes whose aspect ratio is a value, not a wire. */
export function resolutionSelectorIds(wf: ComfyApiGraph): string[] {
  return apiNodes(wf)
    .filter(([, n]) => n.class_type === 'ResolutionSelector' && typeof n.inputs?.aspect_ratio === 'string')
    .map(([id]) => id)
}
