// Long local videos (B18, 3.0.9): a clip up to 30 seconds, made of sections.
//
// No open video model holds 30 seconds in one run. Wan learned 81 frames
// (5 s at 16 fps), the TI2V-5B 121 at 24 fps, LTX 2.5 about 10 s. Past that
// the motion turns restless and starts over. So a long clip is made the way
// the model learned: a first section at the native length, then sections
// that each start on the last frames of what is already there.
//
// Each later section takes the last OVERLAP frames of the clip so far as its
// own first frames. The I2V conditioning holds them fixed (WanImageToVideo
// and Wan22ImageToVideoLatent mask the latent frames they cover, LTX pins
// them with LTXVImgToVideoInplace at strength 1), so the section continues
// the motion instead of restarting from one still. Those frames come out of
// the section a second time; the graph drops them before it appends the rest
// (api/video-continue.ts). Five frames for Wan are two latent frames (the
// VAE packs 1 + 4); seventeen for LTX are three (1 + 8 + 8).
//
// The other way to a long clip, one run with sliding context windows
// (ComfyUI's WanContextWindowsManual / LTXVContextWindows), keeps a scene
// even but tends to repeat itself and takes one prompt for everything. It is
// the "one pass" switch; sections are the default.

import type { ModelType } from '../api/comfyui'

/** The longest clip the Seconds control offers. */
export const MAX_LONG_SECONDS = 30

export interface SectionSpec {
  /** Frames of one section at the model's native length. */
  native: number
  /** Frames each later section repeats from the clip so far. */
  overlap: number
  /** Frames of a section snap to `grid * n + 1`. */
  grid: number
  /** The rate the family is made at. */
  fps: number
}

/** The families that can continue a clip, and how. A family missing here
 *  (Hunyuan, FramePack, MiniMax H3, Mochi, SVD …) keeps its single run. */
const SECTIONS: Partial<Record<ModelType, SectionSpec>> = {
  wan: { native: 81, overlap: 5, grid: 4, fps: 16 },
  wan22: { native: 121, overlap: 5, grid: 4, fps: 24 },
  ltx25: { native: 241, overlap: 17, grid: 8, fps: 24 },
}

export function sectionSpec(type: ModelType | string): SectionSpec | null {
  return SECTIONS[type as ModelType] ?? null
}

/** True when the family can make a clip longer than one run. */
export function canMakeLongVideo(type: ModelType | string): boolean {
  return sectionSpec(type) !== null
}

const snapUp = (frames: number, grid: number) => Math.ceil((Math.max(1, frames) - 1) / grid) * grid + 1

export interface LongVideoPlan {
  /** Frames of each section as rendered, overlap included. */
  sections: number[]
  overlap: number
  /** Frames of the finished clip. */
  totalFrames: number
  /** Its length at `fps`. */
  seconds: number
  fps: number
}

/**
 * The sections for a clip of `seconds` at `fps`. The first section runs at
 * the native length (or shorter for a short clip), each later one adds up to
 * `native - overlap` new frames, and the last one is cut to what is left,
 * on the family's grid and never shorter than its overlap plus one grid step.
 * The clip never comes out shorter than asked; it may run up to one grid step
 * longer.
 */
export function planLongVideo(type: ModelType | string, seconds: number, fps?: number): LongVideoPlan | null {
  const spec = sectionSpec(type)
  if (!spec) return null
  const rate = fps && fps > 0 ? fps : spec.fps
  const want = snapUp(Math.round(Math.min(MAX_LONG_SECONDS, Math.max(1, seconds)) * rate), spec.grid)
  const first = Math.min(spec.native, want)
  const sections = [first]
  let total = first
  const step = spec.native - spec.overlap
  while (total < want) {
    const add = Math.min(step, want - total)
    const frames = Math.max(spec.overlap + spec.grid, snapUp(spec.overlap + add, spec.grid))
    sections.push(frames)
    total += frames - spec.overlap
  }
  return { sections, overlap: spec.overlap, totalFrames: total, seconds: total / rate, fps: rate }
}

/** Frames for a single run of `seconds`, on the family's grid. */
export function framesForSeconds(type: ModelType | string, seconds: number, fps: number): number {
  const grid = sectionSpec(type)?.grid ?? 4
  return snapUp(Math.round(Math.max(0.1, seconds) * Math.max(1, fps)), grid)
}

/** Seconds a frame count plays at `fps`, one decimal. */
export function secondsOf(frames: number, fps: number): number {
  if (!(frames > 0) || !(fps > 0)) return 0
  return Math.round((frames / fps) * 10) / 10
}

/** How a long clip is made. */
export type LongVideoMode = 'sections' | 'one-pass'

/** One pass with context windows: the window and its overlap per family,
 *  ComfyUI's own defaults for WanContextWindowsManual (81 / 30) and
 *  LTXVContextWindows (145 / 40). */
export function contextWindowFor(type: ModelType | string): { length: number; overlap: number; node: string } | null {
  if (type === 'wan' || type === 'wan22') return { length: 81, overlap: 30, node: 'WanContextWindowsManual' }
  if (type === 'ltx25') return { length: 145, overlap: 40, node: 'LTXVContextWindows' }
  return null
}
