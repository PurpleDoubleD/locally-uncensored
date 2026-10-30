// The settings a result was made with, for the prompt panel of the gallery and
// the large view (D9, 3.0.7).
//
// Every entry has carried its negative prompt, steps, CFG, sampler, seed and
// size since the first gallery, and no view showed more than size, seed and
// model. Someone who wanted to make a picture again had to guess the rest.
//
// Only what took part in the run is listed. A tool (cutout, enhance, erase)
// and the lanes that run without the sliders (music, talking character,
// extend, motion) never had steps or a CFG, and a cloud run on a model with
// its own options sends none either: those entries carry 0 there, and 0 is
// left out instead of shown as a setting nobody made.
import type { GalleryItem } from '../../stores/createStore'
import { ranPrompt } from './ran-prompt'

/** Runs that take no seed and no model from the picker (as result-facts.ts). */
const TOOL_INTENTS: ReadonlySet<string> = new Set(['removebg', 'upscale', 'eraser'])

/** Lanes whose runs do not take steps, CFG, sampler or the negative prompt
 *  from the sliders of the Composer. */
const NO_SLIDER_INTENTS: ReadonlySet<string> = new Set([
  'removebg', 'upscale', 'eraser', 'music', 'lipsync', 'extend', 'motion',
])

export type RunSettingsSource = Partial<Pick<GalleryItem,
  'type' | 'intent' | 'model' | 'toolModel' | 'negativePrompt' | 'seed' | 'steps' | 'cfgScale' | 'sampler' | 'width' | 'height' | 'loras'
>>

/** B40: the LoRAs of a run, for its gallery entry. Nothing when none ran, so
 *  an entry without LoRAs stays as it was. */
export function ranLoras(loras: readonly { name: string; strength: number }[]): Pick<GalleryItem, 'loras'> {
  return loras.length ? { loras: loras.map((l) => ({ name: l.name, strength: l.strength })) } : {}
}

export interface RunSetting {
  label: string
  value: string
}

function prettyModel(file: string): string {
  return file.replace(/\.(safetensors|ckpt|pt|gguf)$/i, '').replace(/[_]+/g, ' ')
}

function positive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/** CFG as it was set: 7, 3.5, 1.25, never 3.5000000001. */
function cfgText(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** The negative prompt, when the run took one. */
export function ranNegativePrompt(item: RunSettingsSource): string {
  if (item.type === 'audio') return ''
  if (item.intent && NO_SLIDER_INTENTS.has(item.intent)) return ''
  return item.negativePrompt?.trim() ?? ''
}

/** The settings of a run, in the order they are read: model, LoRAs, steps, CFG,
 *  sampler, seed, size. Empty for an entry that carries none (a result from
 *  the chat, which only brings its prompt). */
export function runSettings(item: RunSettingsSource): RunSetting[] {
  const out: RunSetting[] = []
  const tool = !!item.intent && TOOL_INTENTS.has(item.intent)
  const model = tool ? item.toolModel : item.model
  if (model?.trim()) out.push({ label: 'Model', value: prettyModel(model.trim()) })
  // B40: each LoRA with the strength it ran at, right under the model it
  // steered. A tool runs no diffusion model, so it has none.
  if (!tool) {
    for (const l of item.loras ?? []) {
      if (l?.name?.trim() && Number.isFinite(l.strength)) out.push({ label: 'LoRA', value: `${prettyModel(l.name.trim().split(/[\\/]/).pop() ?? l.name)} · ${cfgText(l.strength)}` })
    }
  }
  // A track: the model and its seed, the one value a music run takes that
  // makes it again (the Mac's engine runs its own steps and guidance).
  if (item.type === 'audio') {
    if (typeof item.seed === 'number' && Number.isFinite(item.seed) && item.seed > 0) out.push({ label: 'Seed', value: String(item.seed) })
    return out
  }
  const sliders = !(item.intent && NO_SLIDER_INTENTS.has(item.intent))
  if (sliders && positive(item.steps)) out.push({ label: 'Steps', value: String(item.steps) })
  if (sliders && positive(item.cfgScale)) out.push({ label: 'CFG', value: cfgText(item.cfgScale) })
  if (sliders && positive(item.steps) && item.sampler?.trim()) out.push({ label: 'Sampler', value: item.sampler.trim() })
  if (!tool && typeof item.seed === 'number' && Number.isFinite(item.seed) && (item.seed > 0 || positive(item.steps))) {
    out.push({ label: 'Seed', value: String(item.seed) })
  }
  if (positive(item.width) && positive(item.height)) out.push({ label: 'Size', value: `${item.width}×${item.height}` })
  return out
}

/** Everything in one text for the clipboard: prompt, negative prompt, then the
 *  settings on one line each, the way they stand in the panel. */
export function runSettingsText(item: RunSettingsSource & Pick<GalleryItem, 'prompt'> & Partial<Pick<GalleryItem, 'label'>>): string {
  const lines: string[] = []
  const prompt = ranPrompt(item)
  if (prompt) lines.push(`Prompt: ${prompt}`)
  const negative = ranNegativePrompt(item)
  if (negative) lines.push(`Negative prompt: ${negative}`)
  for (const s of runSettings(item)) lines.push(`${s.label}: ${s.value}`)
  return lines.join('\n')
}
