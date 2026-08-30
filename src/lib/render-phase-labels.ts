/**
 * What the Create tab is allowed to say a local render is doing right now.
 *
 * The waiting area used to name its phases straight from ComfyUI's `executing`
 * events, and one of those names was wrong on the machine it was shown on.
 * R16 Befund 3, re-measured on the Windows box (2026-08-30, 12 GB GPU, 16 GB
 * RAM, z_image_bf16 at 11.46 GB): a still image showed "Decoding frames, the
 * last long stretch". There are no frames in a still image, and that stretch
 * was not long: it ran 2.5 s to 3.7 s and was the SHORTEST section of every
 * one of the five runs. Two claims, both false, in one line.
 *
 * This is text and phase policy, nothing else, so it lives here as plain
 * functions instead of inside useCreate's 300 line WS closure where the only
 * way to test it is to drive a whole render.
 */

import type { ProgressPhase } from '../stores/createStore'
import {
  LOADER_NODES, CLIP_LOADER_NODES, VAE_LOADER_NODES, SAMPLER_NODES, DECODE_NODES,
} from '../api/comfyui-ws'

/** Which of the two Create lanes a render belongs to. */
export type RenderMode = 'image' | 'video'

/** One settled statement about the render: the phase, the bar, the words. */
export interface RenderPhaseStep {
  phase: ProgressPhase
  pct: number
  label: string
}

/**
 * The phase a node ComfyUI just entered puts the render in, or null when the
 * node says nothing worth a label (a text encode, a save, a resize).
 */
export function phaseForExecutingNode(classType: string, mode: RenderMode): RenderPhaseStep | null {
  if (LOADER_NODES.has(classType)) {
    return { phase: 'loading-model', pct: 15, label: 'Loading model...' }
  }
  if (CLIP_LOADER_NODES.has(classType)) {
    return { phase: 'loading-clip', pct: 25, label: 'Loading text encoder...' }
  }
  if (VAE_LOADER_NODES.has(classType)) {
    return { phase: 'loading-vae', pct: 30, label: 'Loading VAE...' }
  }
  if (SAMPLER_NODES.has(classType)) {
    return { phase: 'sampling', pct: 35, label: 'Sampling...' }
  }
  if (DECODE_NODES.has(classType)) {
    // Befund 3. A still image has no frames, and nothing here is known to be
    // the longest stretch: on the box it was the shortest one measured. The
    // video wording keeps "frames" because a video decode does produce them,
    // and drops the superlative, which was never measured for video either.
    return {
      phase: 'decoding',
      pct: 90,
      label: mode === 'video' ? 'Decoding frames...' : 'Decoding image...',
    }
  }
  return null
}

/** The phase a reported sampling step puts the render in. */
export function phaseForProgressStep(
  value: number,
  max: number,
  current: ProgressPhase,
): RenderPhaseStep | null {
  void current
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null
  const pct = Math.round(35 + (value / max) * 55) // 35% to 90%
  return { phase: 'sampling', pct, label: `Sampling step ${value}/${max}...` }
}
