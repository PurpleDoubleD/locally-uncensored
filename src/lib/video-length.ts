// Discord D4 (2026-10-05/07): MiniMax H3 can make clips far longer than the
// Frames slider allowed. The slider ran 1 to 120 for every local video model,
// while three families start above it (MiniMax H3 at 124, LTX 2.5 and Cosmos
// at 121), so their own default could not even be shown. Each family now gets
// its own range, on the grid its graph snaps to anyway (lib dynamic-workflow
// `snapMiniMaxH3Length`, `snapLtx25Length`), so what the slider says is what
// the run makes.
import type { ModelType } from '../api/comfyui'

export interface FrameRange {
  min: number
  max: number
  step: number
}

/** The families with a range of their own. Every other family has 1 to 121. */
const OWN_RANGE: Partial<Record<ModelType, FrameRange>> = {
  // 17 frames a step from 5, the length the encode node takes. 362 frames are
  // 15 seconds at 24 fps, the length asked for on Discord.
  minimaxh3: { min: 5, max: 362, step: 17 },
  // 8 frames a step from 9, as the official templates count.
  ltx25: { min: 9, max: 257, step: 8 },
}

/** 121, not 120: Cosmos starts at 121, and Wan's grid of four from 1 ends
 *  there too. The test checks every family default against this. */
const PLAIN: FrameRange = { min: 1, max: 121, step: 1 }

/** The longest clip any local family may ask for; the store clamps to it. */
export const MAX_LOCAL_FRAMES = Math.max(PLAIN.max, ...Object.values(OWN_RANGE).map((r) => r!.max))

/** The Frames slider of a local video model of this family. */
export function frameRangeFor(type: ModelType | string): FrameRange {
  return OWN_RANGE[type as ModelType] ?? PLAIN
}

/** A frame count moved onto the slider's grid and inside its range. */
export function framesOnRange(frames: number, range: FrameRange): number {
  const f = Number.isFinite(frames) ? frames : range.min
  const k = Math.round((f - range.min) / range.step)
  return Math.min(range.max, Math.max(range.min, range.min + k * range.step))
}

/** Wan 2.1 learned its clips at 81 frames. The slider goes on to 121, but
 *  past 81 the motion turns restless and repeats, so a longer clip is better
 *  made in steps with Extend Video. */
export const WAN_STEADY_FRAMES = 81

/** The line under the Frames slider when the length is past what the family
 *  holds steady, or null. */
export function lengthHint(type: ModelType | string, frames: number): string | null {
  if (type !== 'wan' || !(frames > WAN_STEADY_FRAMES)) return null
  return `Wan holds steady up to ${WAN_STEADY_FRAMES} frames. Longer clips tend to turn restless; for more, set Length in seconds below and LU makes it in sections.`
}
