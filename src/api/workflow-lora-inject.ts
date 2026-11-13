// C72 (3.1.0): the LoRA stack picked in Create reaches a workflow of the
// user's own.
//
// injectParameters filled in model, prompts, seed, steps, CFG, size and
// sampler, and the LoRA stack was dropped without a word: a workflow imported
// from ComfyUI rendered as if no LoRA had been picked (Discord, help-chat,
// 10.11.2026). LU's own builder chains a LoraLoader per LoRA behind the model
// loader (dynamic-workflow.ts, Phase 1b). The same is done here in a graph
// LU did not build: the chain goes in right behind each model loader, and
// everything that read the loader's MODEL (and the text encoder's CLIP) reads
// the end of the chain instead. A LoRA the workflow already loads itself is
// not loaded a second time.

import type { ComfyApiGraph, ComfyInputValue } from '../types/comfy-graph'
import { apiNodes } from '../types/comfy-graph'
import type { ParameterMap } from '../types/workflows'
import { normalizeLoraStrengths, resolveLoraNames } from './dynamic-workflow'

/** Loaders whose first output is the diffusion model. */
const MODEL_LOADERS = new Set([
  'CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader', 'UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced',
])
/** Loaders whose first output is the text encoder of a UNET workflow. */
const CLIP_LOADERS = new Set([
  'CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'QuadrupleCLIPLoader', 'CLIPLoaderGGUF', 'DualCLIPLoaderGGUF',
])
const LORA_LOADERS = new Set(['LoraLoader', 'LoraLoaderModelOnly'])

export interface LoraInjection {
  /** The LoRAs that went in, as ComfyUI names them. */
  added: string[]
  /** LoRAs the workflow loads itself, left as they are. */
  alreadyThere: string[]
}

const isRef = (v: ComfyInputValue | undefined): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'

/** Point every input that reads `[from, slot]` at `[to, toSlot]`, except in `skip`. */
function rewire(wf: ComfyApiGraph, from: string, slot: number, to: string, toSlot: number, skip: Set<string>): void {
  for (const [id, node] of apiNodes(wf)) {
    if (skip.has(id) || !node.inputs) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      if (isRef(value) && value[0] === from && value[1] === slot) node.inputs[key] = [to, toSlot]
    }
  }
}

/** A node id the graph does not use yet. */
function freshIds(wf: ComfyApiGraph): () => string {
  let next = Object.keys(wf).reduce((max, id) => {
    const n = Number(id)
    return Number.isInteger(n) && n > max ? n : max
  }, 0)
  return () => {
    do next += 1
    while (String(next) in wf)
    return String(next)
  }
}

/**
 * Put the LoRA stack into `wf` (in place). `installed` is ComfyUI's LoraLoader
 * list; a name it does not have throws the same sentence LU's own builder
 * says. A graph with no model loader LU knows is left as it is, and nothing
 * is added: `added` is empty then.
 */
export function injectLoraStack(
  wf: ComfyApiGraph,
  paramMap: ParameterMap,
  names: string[],
  strengths: number | number[] | undefined,
  installed: string[],
): LoraInjection {
  const result: LoraInjection = { added: [], alreadyThere: [] }
  if (names.length === 0) return result
  const perLora = normalizeLoraStrengths(strengths, names.length)
  const resolved = resolveLoraNames(names, installed)

  // What the workflow loads itself stays its own, at its own strength.
  const own = new Set(
    apiNodes(wf)
      .filter(([, n]) => LORA_LOADERS.has(n.class_type) && typeof n.inputs?.lora_name === 'string')
      .map(([, n]) => String(n.inputs?.lora_name).toLowerCase()),
  )
  const stack = resolved
    .map((name, i) => ({ name, strength: perLora[i] }))
    .filter((l) => {
      if (!own.has(l.name.toLowerCase())) return true
      result.alreadyThere.push(l.name)
      return false
    })
  if (stack.length === 0) return result

  // The mapped model loader first, then any other (Wan 2.2: high and low noise).
  const mapped = paramMap.model?.nodeId
  const loaders = apiNodes(wf)
    .filter(([, n]) => MODEL_LOADERS.has(n.class_type))
    .map(([id]) => id)
    .sort((a, b) => (a === mapped ? -1 : b === mapped ? 1 : 0))
  if (loaders.length === 0) return result

  // The CLIP the prompts are encoded with: the checkpoint's own, or the one
  // text-encoder loader of a UNET workflow. With none or several, the LoRA
  // patches the model alone, as LoraLoaderModelOnly does.
  const first = wf[loaders[0]]
  let clip: [string, number] | null = null
  if (first.class_type.startsWith('Checkpoint')) clip = [loaders[0], 1]
  else {
    const clipLoaders = apiNodes(wf).filter(([, n]) => CLIP_LOADERS.has(n.class_type)).map(([id]) => id)
    if (clipLoaders.length === 1) clip = [clipLoaders[0], 0]
  }

  const nextId = freshIds(wf)
  const added = new Set<string>()
  loaders.forEach((loaderId, index) => {
    const withClip = index === 0 && clip !== null
    let model: [string, number] = [loaderId, 0]
    let clipRef = withClip ? clip : null
    const chain: string[] = []
    for (const lora of stack) {
      const id = nextId()
      chain.push(id)
      wf[id] = clipRef
        ? {
            class_type: 'LoraLoader',
            inputs: { lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength, model, clip: clipRef },
            _meta: { title: `LoRA (LU): ${lora.name}` },
          }
        : {
            class_type: 'LoraLoaderModelOnly',
            inputs: { lora_name: lora.name, strength_model: lora.strength, model },
            _meta: { title: `LoRA (LU): ${lora.name}` },
          }
      model = [id, 0]
      if (clipRef) clipRef = [id, 1]
    }
    const skip = new Set(chain)
    rewire(wf, loaderId, 0, model[0], 0, skip)
    if (withClip && clip && clipRef) rewire(wf, clip[0], clip[1], clipRef[0], 1, skip)
    for (const l of stack) added.add(l.name)
  })
  result.added = [...added]
  return result
}
