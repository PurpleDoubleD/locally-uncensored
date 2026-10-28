// The run of a long local clip (B18, 3.0.9): section after section, each one
// continuing the clip so far (lib/long-video plans them, api/video-continue
// builds the graph). Kept apart from the Create hook so the order of uploads,
// runs and gallery entries can be tested without ComfyUI.
//
// Every section leaves the WHOLE clip so far as one video, so a run stopped
// after section 3 still has a playable result. Only the newest stays in the
// gallery: the hook's run adds each one, this removes the one before it.
// A clip the user brought (Extend Video) is never removed.
//
// After each section the new frames are matched to the first section when the
// backend can do it (a numpy step in ComfyUI's own Python, Rust command
// video_color_settle): the next section then starts from settled frames, so a
// drift cannot carry over and add up. Without it (a ComfyUI LU does not manage) the run goes on
// unsettled.

import type { ModelType } from '../api/comfyui'
import { MAX_LONG_SECONDS, planLongVideo, sectionSpec, type LongVideoPlan } from './long-video'

/** What the chain needs to know about a gallery entry. */
export interface ClipItem {
  id: string
  type: string
  filename?: string
  subfolder?: string
  comfyType?: string
}

export interface LongRunDeps {
  /** One render through the Create hook's normal path. */
  run: (override: Record<string, unknown>, opts: { stepLabel: string; continueFrom?: { video: string; overlap: number } }) => Promise<void>
  /** The gallery as it is now, newest first. */
  gallery: () => readonly ClipItem[]
  /** The error the last run left, or null. */
  error: () => string | null
  fetchBlob: (item: ClipItem) => Promise<Blob>
  /** Into ComfyUI's input folder; returns the name LoadVideo lists. */
  upload: (blob: Blob, name: string) => Promise<string>
  remove: (id: string) => void
  /** Match everything from the boundaries on to the anchor (frames
   *  0..anchorEnd, the first section), in place of the item; null when the
   *  backend cannot. */
  settle?: (item: ClipItem, boundaries: number[], anchorEnd: number) => Promise<ClipItem | null>
  aborted: () => boolean
}

export interface LongRunStart {
  /** The model of the first section (any T2V or I2V model of the family). */
  firstModel: string
  /** The model every later section runs: an image to video model. */
  continueModel: string
  /** A clip to continue (Extend Video); without it the first section is new. */
  clip?: Blob
  /** Its frame count, when known: the first seam for the colour settle. */
  clipFrames?: number
}

export class LongRunStopped extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LongRunStopped'
  }
}

/** The image to video sibling of a text to video file, from the installed
 *  list: the TI2V-5B and LTX 2.5 do both themselves; an A14B or Wan 2.1 T2V
 *  file has an I2V twin with the same name but "i2v". Null when none is
 *  installed. */
export function continueModelFor(model: string, type: ModelType | string, installed: readonly string[]): string | null {
  if (type === 'wan22' || type === 'ltx25') return model
  if (/(^|[^a-z])i2v([^a-z]|$)/i.test(model)) return model
  const want = model.replace(/t2v/i, (m) => (m === 'T2V' ? 'I2V' : 'i2v')).toLowerCase()
  const hit = installed.find((n) => n.toLowerCase() === want)
  if (hit) return hit
  // An A14B pair: the high noise half of the i2v pair, whatever the quant.
  const lower = model.toLowerCase()
  if (/wan[._-]?2[._-]?2/.test(lower)) {
    return installed.find((n) => /wan[._-]?2[._-]?2/i.test(n) && /i2v/i.test(n) && /high[._-]?noise/i.test(n)) ?? null
  }
  if (/wan[._-]?2[._-]?1/.test(lower)) {
    return installed.find((n) => /wan[._-]?2[._-]?1/i.test(n) && /i2v/i.test(n) && /14b/i.test(n)) ?? null
  }
  return null
}

/** The sections that add `seconds` to an existing clip: every one of them is
 *  a continuation, each repeating the overlap. */
export function planExtension(type: ModelType | string, seconds: number, fps?: number): LongVideoPlan | null {
  const spec = sectionSpec(type)
  if (!spec) return null
  const rate = fps && fps > 0 ? fps : spec.fps
  // Plan as if the clip so far were the first section, then drop it.
  const asWhole = planLongVideo(type, (spec.native + Math.round(seconds * rate)) / rate, rate)
  if (!asWhole || asWhole.sections.length < 2) return null
  const sections = asWhole.sections.slice(1)
  const added = sections.reduce((sum, f) => sum + f - spec.overlap, 0)
  return { sections, overlap: spec.overlap, totalFrames: added, seconds: added / rate, fps: rate }
}

function newestVideo(before: Set<string>, gallery: readonly ClipItem[]): ClipItem | null {
  return gallery.find((g) => !before.has(g.id) && g.type === 'video') ?? null
}

/**
 * Runs the plan. `plan.sections[0]` is the first section when there is no
 * clip; with a clip every section continues it. Returns the finished item.
 */
export async function runLongVideo(plan: LongVideoPlan, start: LongRunStart, deps: LongRunDeps): Promise<ClipItem | null> {
  const total = plan.sections.length
  let current: ClipItem | null = null
  let blob: Blob | null = start.clip ?? null
  let index = 0
  // Frames of the clip so far, for the seams the colour settle works on.
  let frames = 0
  const seams: number[] = []

  const runAndTake = async (override: Record<string, unknown>, opts: Parameters<LongRunDeps['run']>[1]): Promise<ClipItem> => {
    const before = new Set(deps.gallery().map((g) => g.id))
    await deps.run(override, opts)
    if (deps.aborted()) throw new LongRunStopped('Stopped.')
    const err = deps.error()
    if (err) throw new LongRunStopped(err)
    const made = newestVideo(before, deps.gallery())
    if (!made) throw new LongRunStopped(`Section ${index + 1} of ${total} did not come out, so the clip stops here.`)
    return made
  }

  if (!blob) {
    current = await runAndTake(
      { videoModel: start.firstModel, frames: plan.sections[0] },
      { stepLabel: `Section 1 of ${total}` },
    )
    frames = plan.sections[0]
    index = 1
  } else {
    // Without its frame count the seams of a brought clip are unknown, and
    // the colour settle is skipped rather than aimed at the wrong frames.
    frames = start.clipFrames && start.clipFrames > 0 ? start.clipFrames : -1
  }

  for (; index < total; index++) {
    if (deps.aborted()) throw new LongRunStopped('Stopped.')
    if (current) blob = await deps.fetchBlob(current)
    if (!blob) throw new LongRunStopped('The clip so far could not be read.')
    const name = await deps.upload(blob, `lu_long_${Date.now()}_${index + 1}.mp4`)
    const sectionFrames = plan.sections[index]
    const made = await runAndTake(
      { videoModel: start.continueModel, frames: sectionFrames, cloudOp: 'extend', mode: 'video' },
      { stepLabel: `Section ${index + 1} of ${total}`, continueFrom: { video: name, overlap: plan.overlap } },
    )
    // Only our own in-between clips are taken out of the gallery.
    if (current) deps.remove(current.id)
    current = made
    if (frames >= 0) {
      seams.push(frames)
      frames += sectionFrames - plan.overlap
    }
    // Only the newest section, matched to the first one (the anchor):
    // everything before it was settled in the step before, and this section
    // was made from those settled frames, so its drift is one step, never the
    // sum of all before it.
    if (deps.settle && seams.length > 0) {
      const settled = await deps.settle(current, seams.slice(-1), seams[0]).catch(() => null)
      if (settled) current = settled
    }
  }
  return current
}

/** What the Create button asks for, read off the store. */
export interface LongVideoAsk {
  mode: string
  intent: string
  /** The model the run would use (the lane's pick). */
  model: string
  type: ModelType | string
  installed: readonly string[]
  longVideoSeconds: number
  longVideoMode: 'sections' | 'one-pass'
  fps: number
  /** Frames of a single run as the slider stands. */
  frames: number
  extendClip: Blob | null
}

export type LongVideoRequest =
  | { kind: 'sections'; plan: LongVideoPlan; start: LongRunStart }
  | { kind: 'one-pass'; frames: number }
  | { kind: 'error'; message: string }

/**
 * Whether this Create press is a long clip and how to make it, or null for an
 * ordinary single run. A long clip is asked for by the Seconds control going
 * past the family's native length, or by Extend Video on a family that can
 * continue from frames (then the Seconds control says how much to add, and
 * without it one native section is added).
 */
export function longVideoRequest(ask: LongVideoAsk): LongVideoRequest | null {
  if (ask.mode !== 'video' || !['video', 'animate', 'extend'].includes(ask.intent)) return null
  const spec = sectionSpec(ask.type)
  if (!spec) return null
  const fps = ask.fps > 0 ? ask.fps : spec.fps
  // A value saved before the limit came down never asks for more than the
  // control offers now.
  const seconds = Math.min(MAX_LONG_SECONDS, ask.longVideoSeconds)
  const continueModel = continueModelFor(ask.model, ask.type, ask.installed)
  const noI2v = (): LongVideoRequest => ({
    kind: 'error',
    message: `Clips past ${Math.round(spec.native / spec.fps)} s continue from their last frames, which needs an image to video model of the same family. Install the image to video bundle of ${ask.model.replace(/\.[^.]+$/, '')}, or make the clip shorter.`,
  })
  if (ask.intent === 'extend') {
    if (!ask.extendClip) return null
    const add = seconds > 0 ? seconds : (spec.native - spec.overlap) / spec.fps
    const plan = planExtension(ask.type, add, fps)
    if (!plan) return null
    if (!continueModel) return noI2v()
    return { kind: 'sections', plan, start: { firstModel: continueModel, continueModel, clip: ask.extendClip } }
  }
  if (!(seconds > 0) || seconds * fps <= spec.native) return null
  const plan = planLongVideo(ask.type, seconds, fps)
  if (!plan || plan.sections.length < 2) return null
  if (ask.longVideoMode === 'one-pass') return { kind: 'one-pass', frames: plan.totalFrames }
  if (!continueModel) return noI2v()
  return { kind: 'sections', plan, start: { firstModel: ask.model, continueModel } }
}
