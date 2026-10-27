// What a local video run will cost, said before it starts (B18, 3.0.9).
//
// An estimate, not a promise, and the line under the Create button says so.
// The time per step comes from runs on the owner's test box (RTX 3060 12 GB,
// 64 GB RAM, October 2026; see REFERENCE below for what each number is) and
// scales with the amount of picture a step has to look at. A step's cost
// grows a little faster than the number of latent tokens, because attention
// compares every token with every other one; 1.2 as the exponent matches the
// 480p versus 720p runs on the box within their own spread. Other cards are
// not modelled: the line names the card the numbers come from.
//
// Graphics memory: the largest weight file has to sit on the card while it
// samples (the A14B halves take turns), plus working memory that grows with
// the clip's latent. What does not fit is moved to system memory by ComfyUI
// (dynamic VRAM, async offload), which works but costs time, so the verdict
// says "moves X GB to system memory" instead of "does not fit".

import type { ModelType } from '../api/comfyui'
import { planLongVideo } from './long-video'

export interface VideoRunShape {
  type: ModelType | string
  model: string
  width: number
  height: number
  frames: number
  steps: number
  cfgScale: number
  /** Seconds the user asked for; more than one section when past native. */
  seconds?: number
  fps?: number
  /** The largest single weight file in GB, when known. */
  weightGb?: number | null
  /** The card in GB, when detected. */
  cardGb?: number | null
}

export interface VideoEstimate {
  /** Lower and upper end in minutes. */
  minutes: [number, number]
  sections: number
  /** Graphics memory the run wants in GB (weights + working memory). */
  vramGb: number
  /** How much of that ComfyUI has to keep in system memory, 0 when it fits. */
  offloadGb: number
  /** One line for under the button. */
  line: string
}

interface Reference {
  /** Seconds per sampling step at the reference picture, one model call. */
  secPerStep: number
  /** The reference picture: width × height × frames. */
  w: number; h: number; frames: number
  /** Spatial and temporal VAE compression, for the token count. */
  space: number; time: number
  /** Loading and decoding per section, in seconds. */
  overhead: number
  /** Working memory at the reference picture, GB. */
  workGb: number
}

/** Per family, measured or derived on the RTX 3060 12 GB box. Wan 14B: A14B
 *  Q4_K_S GGUF at 832×480×81 (B18 box run). Wan 2.2 5B: fp16 at 1280×704×121.
 *  LTX 2.5: the whole two pass graph counted as eleven steps at 1280×704×121. */
const REFERENCE: Partial<Record<string, Reference>> = {
  wan14b: { secPerStep: 42, w: 832, h: 480, frames: 81, space: 8, time: 4, overhead: 70, workGb: 2.5 },
  wan13b: { secPerStep: 7, w: 832, h: 480, frames: 81, space: 8, time: 4, overhead: 25, workGb: 1.5 },
  wan22: { secPerStep: 16, w: 1280, h: 704, frames: 121, space: 16, time: 4, overhead: 40, workGb: 3 },
  ltx25: { secPerStep: 22, w: 1280, h: 704, frames: 121, space: 32, time: 8, overhead: 60, workGb: 3 },
}

function referenceFor(type: string, model: string): Reference | null {
  if (type === 'wan') return /1[._-]?3b/i.test(model) ? REFERENCE.wan13b! : REFERENCE.wan14b!
  return REFERENCE[type] ?? null
}

const tokens = (w: number, h: number, frames: number, r: Reference) =>
  Math.max(1, Math.round(w / r.space) * Math.round(h / r.space) * (Math.floor((frames - 1) / r.time) + 1))

/** Minutes as a short range: "4–7 min", "under 1 min". */
export function minutesText([lo, hi]: [number, number]): string {
  if (hi < 1) return 'under 1 min'
  const r = (m: number) => (m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5)
  const a = r(lo)
  const b = Math.max(a, r(hi))
  return a === b ? `about ${a} min` : `${a}–${b} min`
}

/** The estimate, or null for a family without numbers (it shows nothing
 *  rather than a guess). */
export function estimateVideoRun(shape: VideoRunShape): VideoEstimate | null {
  const ref = referenceFor(String(shape.type), shape.model || '')
  if (!ref) return null
  const plan = shape.seconds && shape.fps ? planLongVideo(shape.type, shape.seconds, shape.fps) : null
  const sections = plan ? plan.sections : [shape.frames]
  const calls = shape.cfgScale > 1.01 ? 2 : 1
  const refTokens = tokens(ref.w, ref.h, ref.frames, ref)
  let seconds = 0
  let biggest = 0
  for (const frames of sections) {
    const scale = Math.pow(tokens(shape.width, shape.height, frames, ref) / refTokens, 1.2)
    biggest = Math.max(biggest, scale)
    seconds += ref.overhead + Math.max(1, shape.steps) * calls * ref.secPerStep * scale
  }
  const minutes: [number, number] = [(seconds * 0.7) / 60, (seconds * 1.5) / 60]
  const work = ref.workGb * Math.max(0.3, Math.pow(biggest, 1 / 1.2))
  const vramGb = Math.round(((shape.weightGb ?? 0) + work) * 10) / 10
  const card = shape.cardGb ?? null
  const offloadGb = card && vramGb > card - 0.5 ? Math.round((vramGb - (card - 0.5)) * 10) / 10 : 0
  const parts = [
    `≈ ${minutesText(minutes)}`,
    sections.length > 1 ? `${sections.length} sections` : null,
    card ? (offloadGb > 0 ? `${vramGb} GB on a ${card} GB card, ${offloadGb} GB in system memory` : `${vramGb} of ${card} GB`) : `${vramGb} GB graphics memory`,
  ].filter(Boolean)
  return { minutes, sections: sections.length, vramGb, offloadGb, line: `${parts.join(' · ')} (estimate, RTX 3060 numbers)` }
}
