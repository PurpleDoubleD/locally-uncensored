// Enhance Image on the local ComfyUI backend (Windows and Linux).
//
// Discord, 02.08. and 14.09.2026: people asked for upscaling without the
// cloud. ComfyUI ships everything it takes in its core nodes:
// UpscaleModelLoader reads a file from models/upscale_models,
// ImageUpscaleWithModel runs it over the picture in tiles, and a plain resize
// takes a 4x model's result down to 2x. No custom node pack.
//
// The rules live here, pure and without a store, so the Composer, the submit
// and the graph builder read the same ones and the tests need no renderer.
// A Mac has no ComfyUI and keeps Enhance as a cloud tool (intents.ts).


/** How much larger the result is, per side. 2x is the default: four times the
 *  side is sixteen times the pixels, and most pictures do not need that.
 *  Discord 08.11.2026: 2x and 4x alone were too few, so any
 *  factor from 1x to 8x is taken, and a target long side instead. Above the
 *  model's own scale the rest is a plain resize (buildUpscaleWorkflow). */
export type UpscaleFactor = number
export const UPSCALE_FACTOR_MIN = 1
export const UPSCALE_FACTOR_MAX = 8
/** The factors the size menu lists; any other one is typed. */
export const UPSCALE_FACTORS: readonly UpscaleFactor[] = [1.5, 2, 3, 4]
export const DEFAULT_UPSCALE_FACTOR: UpscaleFactor = 2
/** The long sides the size menu lists, in pixels (2K, 4K UHD, 8K UHD). */
export const UPSCALE_LONG_SIDES: readonly number[] = [2048, 3840, 7680]

/** A persisted or typed factor: inside 1 to 8 on a grid of 0.05, anything
 *  that is not a number is the default. */
export function normalizeUpscaleFactor(v: unknown): UpscaleFactor {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_UPSCALE_FACTOR
  const f = Math.round(Math.min(UPSCALE_FACTOR_MAX, Math.max(UPSCALE_FACTOR_MIN, v)) * 20) / 20
  return f
}

/** A persisted or typed long side: a whole number from 256 to the largest
 *  side a result may have, or null (the factor counts). */
export function normalizeUpscaleLongSide(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.round(Math.min(UPSCALE_MAX_SIDE, Math.max(256, v)))
}

/** The factor a run takes: the long side over the image's longest side when
 *  a long side is set, else the factor. Not rounded, so the long side comes
 *  out exactly. */
export function upscaleFactorFor(width: number, height: number, factor: number, longSide: number | null): number {
  const long = Math.max(width, height)
  return longSide && long > 0 ? longSide / long : normalizeUpscaleFactor(factor)
}

/** How the menu and the error lines name a size: "2x", "1.5x", "3840 px". */
export function upscaleSizeLabel(factor: number, longSide: number | null): string {
  return longSide ? `${longSide} px` : `${normalizeUpscaleFactor(factor)}x`
}

/** The file the setup card downloads (model-bundles.ts, getUpscaleBundles). */
export const STARTER_UPSCALE_MODEL = 'RealESRGAN_x4plus.safetensors'

/** The longest side a local result may have. A 4x pass over a 3000 pixel
 *  photo is 12000 pixels a side, and the save alone then takes minutes and
 *  gigabytes; the run is refused with a sentence instead. */
export const UPSCALE_MAX_SIDE = 8192

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

/**
 * The scale an upscale model is trained for, read from its file name, or null
 * when the name does not say. The common spellings: `RealESRGAN_x4plus`,
 * `RealESRGAN_x2plus`, `4x-UltraSharp`, `4x_NMKD-Siax_200k`, `ESRGAN_4x`,
 * `realesr-general-x4v3`, `1x-ITF-SkinDiffDetail`.
 */
export function nativeUpscaleScale(file: string): number | null {
  const name = baseName(file).replace(/\.[a-z0-9]+$/i, '')
  const lead = /(?:^|[^a-z0-9])([1-8])x(?=[^a-z]|$)/i.exec(name)
  if (lead) return Number(lead[1])
  const trail = /(?:^|[^a-z])x([1-8])(?!\d)/i.exec(name)
  if (trail) return Number(trail[1])
  return null
}

/** The model a run takes: the one picked in the Composer while ComfyUI
 *  still lists it, else the starter file when it is there, else the first
 *  one ComfyUI lists. Null with nothing installed. */
export function pickUpscaleModel(list: readonly string[], picked?: string | null): string | null {
  if (picked && list.includes(picked)) return picked
  const starter = list.find((m) => baseName(m).toLowerCase() === STARTER_UPSCALE_MODEL.toLowerCase())
  return starter ?? list[0] ?? null
}

/** The size of the result. */
export function upscaleTarget(width: number, height: number, factor: UpscaleFactor): { width: number; height: number } {
  return { width: Math.round(width * factor), height: Math.round(height * factor) }
}

/** The sentence for a size the run should not take, or null when it fits:
 *  more than UPSCALE_MAX_SIDE a side, or a long side that does not enlarge. */
export function upscaleTooLargeLine(width: number, height: number, factor: UpscaleFactor, label = `${normalizeUpscaleFactor(factor)}x`): string | null {
  const t = upscaleTarget(width, height, factor)
  if (Math.max(t.width, t.height) > UPSCALE_MAX_SIDE) {
    return `At ${label} this image would be ${t.width}×${t.height}, more than ${UPSCALE_MAX_SIDE} pixels a side. Pick a smaller size or a smaller image.`
  }
  if (factor < 1) return `The image is already ${width}×${height}, larger than ${label}. Pick a long side above ${Math.max(width, height)} px.`
  return null
}

/**
 * Whether the Create button may start a local Enhance. Cloud never waits on
 * this. Locally the run needs an upscale model in ComfyUI's list; without one
 * the Stage shows the download card and the button waits for it.
 */
export function localUpscaleReady(opts: { backend: 'local' | 'cloud'; intent: string; upscaleModelCount: number }): boolean {
  if (opts.backend !== 'local' || opts.intent !== 'upscale') return true
  return opts.upscaleModelCount > 0
}

/** What the result line names as the tool's own model: the file without its
 *  extension. */
export function upscaleToolLabel(file: string): string {
  return baseName(file).replace(/\.(safetensors|pth|pt|ckpt|bin)$/i, '')
}
