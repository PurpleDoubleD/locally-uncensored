// Short notes next to the CFG and LoRA strength sliders when a value is far
// outside what the model takes. They never block; the value stays.
//
// B50 (Discord, 30.10.2026): a character trained in LU came out as noise with a
// checker pattern. The picture's own workflow showed CFG 30 and the LoRA at
// 2.0, both turned up by hand on Z-Image. Nothing said that this breaks it.
import type { ModelType } from '../api/comfyui'

/** The default CFG of each image family with a low optimum, as in
 *  MODEL_TYPE_DEFAULTS (api/comfyui.ts; a test keeps the two equal). Kept here
 *  so the rule needs no import of the ComfyUI module. SD 1.5 and SDXL (7) are
 *  made for a high CFG and are not in it. */
export const LOW_CFG_FAMILIES: Partial<Record<ModelType, number>> = {
  flux: 1, flux2: 1, krea2: 1, qwenimage: 1, hidream: 1, ernie_image: 1,
  zimage: 3.5, chroma: 3.5, qwenimage1: 4, sd3: 4, lumina2: 4,
}

/** Z-Image: Turbo runs at 1, Base at about 3.5 to 5 (LU starts at 3.5, the
 *  P8 box runs used 4). */
const ZIMAGE_RANGE = { low: 1, high: 5, limit: 10 }

function cfgRange(family: ModelType): { low: number; high: number; limit: number } | null {
  if (family === 'zimage') return ZIMAGE_RANGE
  const cfg = LOW_CFG_FAMILIES[family]
  if (cfg === undefined) return null
  // A family that runs at CFG 1 (distilled, or guidance in the model) already
  // suffers at 5; the others around their default from 10 on.
  return cfg <= 1 ? { low: 1, high: 2, limit: 5 } : { low: 1, high: Math.round((cfg + 1.5) * 2) / 2, limit: 10 }
}

/** The note under the CFG slider of an image model, or null. */
export function cfgHint(family: ModelType, cfg: number): string | null {
  const range = cfgRange(family)
  if (!range || cfg <= range.limit) return null
  return `This model works best at CFG ${range.low} to ${range.high}. Above ${range.limit} the picture turns to noise or a checker pattern.`
}

/** Above this most LoRAs break the picture. */
export const LORA_STRENGTH_HINT_ABOVE = 1.5

/** Slider LoRAs are made for a wide range (lib/lora-strength.ts: -10 to 15),
 *  so a high value there is meant. Their files say so in the name. */
const SLIDER_LORA = /slider/i

/** The note under the strength of one LoRA in the stack, or null. */
export function loraStrengthHint(file: string, strength: number): string | null {
  if (strength <= LORA_STRENGTH_HINT_ABOVE) return null
  if (SLIDER_LORA.test(file.replace(/^.*[\\/]/, ''))) return null
  return 'Above 1.5 most LoRAs break the picture. 0.6 to 1.2 is the usual range.'
}
