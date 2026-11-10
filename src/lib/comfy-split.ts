/**
 * One picture or video model across two cards (3.1.0, C56).
 *
 * What it is for: a model that does not fit on the main card. Without this,
 * ComfyUI keeps the diffusion model, the text encoder and the VAE on one card
 * and moves what does not fit into system memory, which is slow. With two
 * cards the diffusion model keeps the main card to itself and the text
 * encoders and the VAE go to the second one.
 *
 * How, without any custom node: ComfyUI itself has "Select CLIP Device" and
 * "Select VAE Device" (comfy_extras/nodes_multigpu.py, core since 0.23, LU
 * pins 0.42.4). Each takes a CLIP or a VAE and a device (`gpu:N`) and hands
 * on a copy that loads onto that card. The Rust side starts ComfyUI with
 * both cards visible and the model card first (commands/gpu_roles.rs,
 * ComfySplit), so the model card is `gpu:0`, ComfyUI's default device, and
 * the helper card is `gpu:1`.
 *
 * This file is the pure part: put one such node behind every text encoder
 * and VAE LOADER of a graph and point every consumer at it. A node that takes
 * a CLIP and gives one back (a LoRA loader) is not a loader, it hands on the
 * copy it was given, so it gets no node of its own. A graph that already
 * places a CLIP or a VAE itself is left as it is.
 *
 * Safe in both directions by ComfyUI's own design: on a machine where
 * `gpu:1` does not exist, or behind a loader that cannot be reloaded on
 * another card (a GGUF loader without a reload factory), the node logs a line
 * and passes its input through unchanged.
 */

import type { ComfyApiGraph, ComfyApiNode, ComfyInputValue } from '../types/comfy-graph'

export const SELECT_CLIP_DEVICE = 'SelectCLIPDevice'
export const SELECT_VAE_DEVICE = 'SelectVAEDevice'

/** ComfyUI's name for the second visible card. */
export const SPLIT_HELPER_DEVICE = 'gpu:1'

/** The output types of a node class (`/object_info` `output`), or undefined
 *  when the class is unknown. */
export type OutputTypesOf = (classType: string) => readonly string[] | undefined

export interface SplitOptions {
  /** Put a node behind text encoder loaders. False when ComfyUI lacks it. */
  clip: boolean
  /** Put a node behind VAE loaders. False when ComfyUI lacks it. */
  vae: boolean
  device?: string
}

export interface SplitResult {
  graph: ComfyApiGraph
  /** One entry per node put in: `<loader class>:<slot> -> <select class>`. */
  inserted: string[]
}

const SELECT_FOR: Record<string, string> = { CLIP: SELECT_CLIP_DEVICE, VAE: SELECT_VAE_DEVICE }

function isLink(v: ComfyInputValue | undefined): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
}

function nextIds(graph: ComfyApiGraph): () => string {
  let max = 0
  for (const id of Object.keys(graph)) {
    const n = Number(id)
    if (Number.isInteger(n) && n > max) max = n
  }
  return () => String(++max)
}

/**
 * The graph with a Select CLIP/VAE Device node behind every text encoder and
 * VAE loader. Never mutates its input; a graph with nothing to do comes back
 * as the same object.
 */
export function splitAcrossCards(graph: ComfyApiGraph, outputsOf: OutputTypesOf, opts: SplitOptions): SplitResult {
  const device = opts.device ?? SPLIT_HELPER_DEVICE
  const wanted = new Set<string>()
  if (opts.clip) wanted.add('CLIP')
  if (opts.vae) wanted.add('VAE')
  if (wanted.size === 0) return { graph, inserted: [] }

  const typeOf = (id: string, slot: number): string | undefined => {
    const node = graph[id]
    return node ? outputsOf(node.class_type)?.[slot] : undefined
  }

  // Who reads which output.
  const consumers = new Map<string, Array<{ id: string; input: string }>>()
  for (const [id, node] of Object.entries(graph)) {
    for (const [input, v] of Object.entries(node.inputs ?? {})) {
      if (!isLink(v)) continue
      const key = `${v[0]}:${v[1]}`
      const list = consumers.get(key) ?? []
      list.push({ id, input })
      consumers.set(key, list)
    }
  }

  const placements: Array<{ id: string; slot: number; select: string }> = []
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === SELECT_CLIP_DEVICE || node.class_type === SELECT_VAE_DEVICE) continue
    const outputs = outputsOf(node.class_type)
    if (!outputs) continue
    outputs.forEach((type, slot) => {
      if (!wanted.has(type)) return
      // Not a loader: it takes this type in and hands it on.
      const takesSameType = Object.values(node.inputs ?? {}).some((v) => isLink(v) && typeOf(v[0], v[1]) === type)
      if (takesSameType) return
      const readers = consumers.get(`${id}:${slot}`) ?? []
      if (readers.length === 0) return
      // The graph places this one itself.
      if (readers.some((r) => graph[r.id]?.class_type === SELECT_FOR[type])) return
      placements.push({ id, slot, select: SELECT_FOR[type] })
    })
  }
  if (placements.length === 0) return { graph, inserted: [] }

  const out: ComfyApiGraph = {}
  for (const [id, node] of Object.entries(graph)) out[id] = { ...node, inputs: { ...node.inputs } }
  const newId = nextIds(graph)
  const inserted: string[] = []
  for (const p of placements) {
    const sid = newId()
    const inputName = p.select === SELECT_CLIP_DEVICE ? 'clip' : 'vae'
    const selectNode: ComfyApiNode = {
      class_type: p.select,
      inputs: { [inputName]: [p.id, p.slot], device },
      _meta: { title: `LU: ${inputName === 'clip' ? 'text encoder' : 'VAE'} on the second card` },
    }
    for (const r of consumers.get(`${p.id}:${p.slot}`) ?? []) {
      const target = out[r.id]
      target.inputs = { ...(target.inputs ?? {}), [r.input]: [sid, 0] }
    }
    out[sid] = selectNode
    inserted.push(`${graph[p.id].class_type}:${p.slot} -> ${p.select}`)
  }
  return { graph: out, inserted }
}

/** One `/system_stats` device entry, as far as this needs it. */
export interface StatsDevice {
  name?: unknown
  type?: unknown
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Whether the running ComfyUI sees the two cards in the order the split
 * needs: at least two GPU devices, the first one the model card and the
 * second one the helper card. ComfyUI names a device
 * `cuda:1 NVIDIA GeForce RTX 5080 : cudaMallocAsync`, so a card's name is
 * looked for inside it. A ComfyUI started before the setting was turned on
 * (one card visible), one LU did not start, or one that sees the cards the
 * other way round all answer false, and the workflow goes out unchanged.
 */
export function comfySeesSplit(devices: unknown, modelName: string, helperName: string): boolean {
  if (!Array.isArray(devices)) return false
  const gpus = (devices as StatsDevice[]).filter((d) => {
    const type = String(d?.type ?? '').toLowerCase()
    return type !== 'cpu' && !String(d?.name ?? '').toLowerCase().startsWith('cpu')
  })
  if (gpus.length < 2) return false
  const has = (d: StatsDevice, name: string) => !name.trim() || norm(String(d?.name ?? '')).includes(norm(name))
  return has(gpus[0], modelName) && has(gpus[1], helperName)
}
