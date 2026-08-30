/**
 * What the Create tab is allowed to say a local render is doing right now.
 *
 * The waiting area used to name its phases straight from ComfyUI's `executing`
 * events, and two of those names were wrong on the machine they were shown on.
 * R16 re-measure on the Windows box (2026-08-30, 12 GB GPU, 16 GB RAM,
 * z_image_bf16 at 11.46 GB):
 *
 *   - Befund 3: a still image showed "Decoding frames, the last long stretch".
 *     There are no frames in a still image, and that stretch was not long: it
 *     ran 2.5 s to 3.7 s and was the SHORTEST section of every one of the five
 *     runs. Two claims, both false, in one line.
 *
 *   - Befund 4: "Sampling..." appeared at +34 s while the first real sampling
 *     step arrived at +74 s. Forty seconds of a lie, because the label was
 *     hung on ComfyUI ENTERING the sampler node, not on the sampler doing
 *     anything. Entering a KSampler is where ComfyUI moves the weights into
 *     memory (measured on the box: RAM climbing from 672 MB to 7.68 GB in that
 *     window), so the honest name for it is a load, and sampling may only be
 *     claimed once a step has actually been reported.
 *
 * Both fixes are text and phase policy, nothing else, so they live here as
 * plain functions instead of inside useCreate's 300 line WS closure where the
 * only way to test them is to drive a whole render.
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
 *
 * `executing` fires BEFORE the node runs, which is the whole reason the
 * sampler branch below does not say sampling: at that moment the sampler has
 * not sampled anything. It reads as a load because that is what ComfyUI does
 * there, and the first `progress` event is what proves sampling started.
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
    // Befund 4. The sampler is loaded, not sampling. Same words and same
    // phase as the loader nodes above, because to the user it is one
    // uninterrupted load, and it lets the waiting area's load line explain a
    // wait that the box measured at 40 s.
    return { phase: 'loading-model', pct: 32, label: 'Loading model...' }
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

/**
 * The phase a reported step puts the render in, or null to leave the label
 * alone.
 *
 * Null during decoding on purpose: a tiled VAE decode reports steps too, and
 * letting those repaint the label would walk a finished render backwards into
 * "Sampling step 3/8" while it is writing the picture out.
 */
export function phaseForProgressStep(
  value: number,
  max: number,
  current: ProgressPhase,
): RenderPhaseStep | null {
  if (current === 'decoding') return null
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null
  const pct = Math.round(35 + (value / max) * 55) // 35% to 90%
  return { phase: 'sampling', pct, label: `Sampling step ${value}/${max}...` }
}
