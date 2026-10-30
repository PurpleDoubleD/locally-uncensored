// B35 (3.0.9, Discord 29.10.2026): a local ComfyUI edit made one picture
// whatever the batch size said. Generate puts batch_size into its empty
// latent; an edit starts from the encoded source, a latent of one. This
// repeats that latent for every sampler that starts from it (ComfyUI core
// node RepeatLatentBatch, which also repeats an inpaint mask and gives each
// copy its own noise), so one edit run yields `count` pictures, the same
// way a local Generate batch does.
import {
  apiNodes,
  isComfyLinkRef,
  linkTarget,
  type ComfyApiGraph,
  type ComfyLinkRef,
} from '../types/comfy-graph'

/** Highest count of one local edit run, the local batch limit. */
const EDIT_BATCH_MAX = 8

/** A starting latent that already is a batch of its own: an empty latent
 *  carries batch_size, a sampler's output (a second stage) is the batch of
 *  the stage before it. */
const BATCHED_ALREADY = /^Empty.*Latent|Sampler|^RepeatLatentBatch$/

export function applyEditBatch(source: ComfyApiGraph, count: number): ComfyApiGraph {
  const amount = Math.max(1, Math.min(EDIT_BATCH_MAX, Math.floor(count) || 1))
  if (amount === 1) return source
  const graph: ComfyApiGraph = structuredClone(source)
  const repeats = new Map<string, string>()
  let next = Math.max(0, ...Object.keys(graph).map((k) => Number(k)).filter(Number.isFinite)) + 1
  for (const [, node] of apiNodes(graph)) {
    const latent = node.inputs?.latent_image
    if (!isComfyLinkRef(latent)) continue
    const from = linkTarget(latent)
    const fromNode = from ? graph[from] : undefined
    if (!from || !fromNode || BATCHED_ALREADY.test(fromNode.class_type)) continue
    const key = `${from}:${latent[1]}`
    let repeatId = repeats.get(key)
    if (!repeatId) {
      repeatId = String(next++)
      graph[repeatId] = {
        class_type: 'RepeatLatentBatch',
        inputs: { samples: [from, latent[1]] as ComfyLinkRef, amount },
        _meta: { title: 'LU edit batch' },
      }
      repeats.set(key, repeatId)
    }
    node.inputs = { ...node.inputs, latent_image: [repeatId, 0] }
  }
  return graph
}
