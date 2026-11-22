// Swap Character on this computer (3.1.3): Wan 2.2 Animate in ComfyUI, mode
// replace (api/dynamic-workflow.ts buildSwapWorkflow). What the run takes and
// checks, pure, so the panel, the button and the run say the same.
//
// Mac: no ComfyUI and no MLX way to replace a person in a video, so Swap stays
// a cloud action there ("Runs on LU Cloud", intents.ts runsOnMlx).

import type { ClassifiedModel } from '../../api/comfyui'
import type { SwapFigure, SwapFrame } from '../../stores/createStore'
import { SWAP_CONSENT_MISSING } from '../render/swap'
import { checkPeople, peopleElsewhere, swapCan, SWAP_LOCAL_MODEL } from './people-rule'

/** The local models Swap can run: the Wan 2.2 Animate files of the motion
 *  list. VACE follows a pose, it cannot keep the scene around a person. */
export function swapLocalModels(list: readonly ClassifiedModel[]): ClassifiedModel[] {
  return list.filter((m) => m.type === 'wananimate' && !m.mlxVideo)
}

export const SWAP_LOCAL_NO_MODEL =
  'Swap on this computer needs Wan 2.2 Animate. Download it in the Model Manager (Video, Wan 2.2 Animate), then try again.'

/** Why the local swap cannot start, or null. The order of the panel. */
export function swapLocalProblem(s: {
  videoInput: unknown | null
  swapFigures: readonly SwapFigure[]
  swapConsent: boolean
}): string | null {
  if (!s.videoInput) return 'Add the original video first.'
  const figures = s.swapFigures
  if (!figures.length || !figures[0].image) return 'Pick a character or a photo for the person you replace.'
  const people = checkPeople(SWAP_LOCAL_MODEL, figures, [SWAP_LOCAL_MODEL])
  if (people.blocker) {
    const elsewhere = peopleElsewhere(figures, true, [SWAP_LOCAL_MODEL])
    return elsewhere ? `${people.blocker} ${elsewhere}` : people.blocker
  }
  if (!s.swapConsent) return SWAP_CONSENT_MISSING
  return null
}

/** How many frames the run makes: Wan's grid of 4n + 1, as much of the clip as
 *  fits in the local limit and never longer than the clip. A clip whose length
 *  could not be read counts as long enough. */
export function swapLocalFrames(
  clipSeconds: number | undefined,
  fps: number,
  maxSeconds = swapCan(SWAP_LOCAL_MODEL).maxSeconds,
): number {
  const rate = fps > 0 ? fps : 16
  const longest = maxSeconds * rate + 1
  const wanted = clipSeconds && clipSeconds > 0 ? Math.min(clipSeconds * rate, longest) : longest
  return Math.max(1, Math.floor((wanted - 1) / 4)) * 4 + 1
}

/** The size of the run: the lane's size, turned to the video (a portrait
 *  clip runs portrait). Both sides on the grid of 16. */
export function swapLocalSize(width: number, height: number, frame: Pick<SwapFrame, 'width' | 'height'> | null): { width: number; height: number } {
  const w = width > 0 ? width : 832
  const h = height > 0 ? height : 480
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  if (!frame || !(frame.width > 0) || !(frame.height > 0)) return { width: w, height: h }
  return frame.height > frame.width ? { width: short, height: long } : { width: long, height: short }
}
