// Graph pieces for long local videos (B18, 3.0.9). Core ComfyUI nodes only;
// every class used here ships with ComfyUI itself (checked against
// comfy_extras/nodes_video.py, nodes_images.py, nodes_post_processing.py,
// nodes_audio.py and nodes_context_windows.py on master, 27.10.2026).
//
//   continue  LoadVideo → GetVideoComponents gives the clip so far as frames
//             (and its sound). ImageFromBatch at index -overlap takes its last
//             frames for the I2V node, index 0 its very first frame for Wan's
//             ref_pad_image ("SVI-style anti-drift padding": the empty frames
//             of the conditioning are filled with the first picture instead of
//             grey, which keeps faces and colours where they started).
//   stitch    The new section repeats the overlap frames it was given. They
//             are cut off (ImageFromBatch from index `overlap`) and the rest
//             goes behind the clip so far (BatchImagesNode, or the older
//             ImageBatch on a core without it). The output is the whole clip,
//             so every step of a long run leaves one playable video.
//   windows   One pass with sliding context windows instead of sections.
//
// The lib side (lib/long-video.ts) says how many sections and how long.

import type { ComfyApiGraph, ComfyInputValue, ComfyNodeInputs } from '../types/comfy-graph'
import { readComboOptions } from './comfyui-enum'
import { contextWindowFor } from '../lib/long-video'

type Ref = [string, number]
type NodeTable = Record<string, unknown>

/** Where a section continues from: the clip so far, as ComfyUI's input
 *  folder names it after the upload, and how many of its last frames the new
 *  section repeats. */
export interface ContinueFrom {
  video: string
  overlap: number
}

/** The thrown text when the core is too old for these nodes. */
export const CONTINUE_NEEDS_UPDATE =
  'Continuing a video needs ComfyUI\'s video nodes (LoadVideo, GetVideoComponents). Update ComfyUI, then try again.'

/** Inputs of a node from its live schema: the given values, plus the declared
 *  default (or a combo's first option) for every other REQUIRED input, so a
 *  newer core that adds a required widget still validates. Optional inputs
 *  are only sent when given. */
export function inputsFromSchema(allNodes: NodeTable, classType: string, given: ComfyNodeInputs): ComfyNodeInputs {
  const meta = allNodes[classType] as { input?: { required?: Record<string, ComfyInputValue> } } | undefined
  const required = meta?.input?.required ?? {}
  const inputs: ComfyNodeInputs = { ...given }
  for (const [key, spec] of Object.entries(required)) {
    if (inputs[key] !== undefined) continue
    const cfg = Array.isArray(spec) && spec[1] && typeof spec[1] === 'object' && !Array.isArray(spec[1])
      ? (spec[1] as { default?: ComfyInputValue })
      : undefined
    if (cfg?.default !== undefined) { inputs[key] = cfg.default; continue }
    const combo = readComboOptions(spec)
    if (combo && combo.length) inputs[key] = combo[0]
  }
  return inputs
}

/** True when the node declares this input (required or optional). */
export function declaresInput(allNodes: NodeTable, classType: string, input: string): boolean {
  const meta = allNodes[classType] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
  return !!(meta?.input?.required?.[input] ?? meta?.input?.optional?.[input])
}

export interface ContinueSource {
  n: number
  /** Every frame of the clip so far. */
  frames: Ref
  /** Its sound (GetVideoComponents' AUDIO output, empty for a silent clip). */
  audio: Ref
  /** The last `overlap` frames. */
  tail: Ref
  /** The clip's very first frame. */
  first: Ref
}

/** LoadVideo → GetVideoComponents → the tail and the first frame. */
export function addContinueSource(workflow: ComfyApiGraph, n: number, from: ContinueFrom, allNodes: NodeTable): ContinueSource {
  const missing = ['LoadVideo', 'GetVideoComponents', 'ImageFromBatch'].filter((c) => !allNodes[c])
  if (missing.length) throw new Error(CONTINUE_NEEDS_UPDATE)
  const loadId = String(n++)
  workflow[loadId] = { class_type: 'LoadVideo', inputs: { file: from.video }, _meta: { title: 'Clip so far' } }
  const partsId = String(n++)
  workflow[partsId] = { class_type: 'GetVideoComponents', inputs: { video: [loadId, 0] } }
  const tailId = String(n++)
  workflow[tailId] = {
    class_type: 'ImageFromBatch',
    inputs: { image: [partsId, 0], batch_index: -Math.max(1, from.overlap), length: Math.max(1, from.overlap) },
    _meta: { title: 'Last frames' },
  }
  const firstId = String(n++)
  workflow[firstId] = { class_type: 'ImageFromBatch', inputs: { image: [partsId, 0], batch_index: 0, length: 1 }, _meta: { title: 'First frame' } }
  return { n, frames: [partsId, 0], audio: [partsId, 1], tail: [tailId, 0], first: [firstId, 0] }
}

/** The new section without its repeated frames, behind the clip so far.
 *  Returns the joined frames. */
export function addStitch(workflow: ComfyApiGraph, n: number, before: Ref, section: Ref, overlap: number, allNodes: NodeTable): { n: number; images: Ref } {
  const restId = String(n++)
  workflow[restId] = {
    class_type: 'ImageFromBatch',
    inputs: { image: section, batch_index: Math.max(0, overlap), length: 4096 },
    _meta: { title: 'New frames' },
  }
  const joinId = String(n++)
  workflow[joinId] = allNodes['BatchImagesNode']
    ? { class_type: 'BatchImagesNode', inputs: { 'images.image0': before, 'images.image1': [restId, 0] }, _meta: { title: 'Whole clip' } }
    : { class_type: 'ImageBatch', inputs: { image1: before, image2: [restId, 0] }, _meta: { title: 'Whole clip' } }
  return { n, images: [joinId, 0] }
}

/** The sound of a section without its repeated overlap, behind the sound so
 *  far (LTX 2.5 makes picture and sound together). */
export function addAudioStitch(workflow: ComfyApiGraph, n: number, before: Ref, section: Ref, overlapSeconds: number, allNodes: NodeTable): { n: number; audio: Ref } | null {
  if (!allNodes['TrimAudioDuration'] || !allNodes['AudioConcat']) return null
  const trimId = String(n++)
  workflow[trimId] = { class_type: 'TrimAudioDuration', inputs: { audio: section, start_index: Math.max(0, overlapSeconds), duration: 3600 } }
  const joinId = String(n++)
  workflow[joinId] = { class_type: 'AudioConcat', inputs: { audio1: before, audio2: [trimId, 0], direction: 'after' } }
  return { n, audio: [joinId, 0] }
}

/** Context windows on a model, when the clip is longer than one window and
 *  the core has the family's node. Returns the patched model, or the given
 *  one untouched. */
export function addContextWindows(
  workflow: ComfyApiGraph, n: number, model: Ref, type: string, frames: number, allNodes: NodeTable,
): { n: number; model: Ref } {
  const win = contextWindowFor(type)
  if (!win || frames <= win.length || !allNodes[win.node]) return { n, model }
  const id = String(n++)
  workflow[id] = {
    class_type: win.node,
    inputs: inputsFromSchema(allNodes, win.node, {
      model, context_length: win.length, context_overlap: win.overlap,
    }),
    _meta: { title: 'Context windows' },
  }
  return { n, model: [id, 0] }
}
