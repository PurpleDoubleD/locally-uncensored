// GH #146 (2026-10-01): two LoRAs deleted from models/loras stayed
// in the persisted stack. The picker showed "2 active" with nothing ticked,
// every run sent them, and ComfyUI refused the graph with "Value not in list".
// One of them was a Z-Image character LoRA riding into the Animate lane.
// This file decides, from the one list ComfyUI reports, which picks a run uses
// and which LoRAs the stack offers for the model that is picked.
import { parseLocalCharacterLora, parseLocalStyleLora } from '../api/trainer'
import { getLoraAddonBundles } from '../api/model-bundles'
import type { ModelType } from '../api/comfyui'

export interface LoraPick {
  name: string
  strength: number
}

/** A LoRA whose model family the app knows, because the app made or shipped it. */
export interface KnownLora {
  /** The model family it was made for. */
  family: ModelType
  /** How the stack names that family, as in "Z-Image only". */
  familyLabel: string
  /** From the catalogue: the bundle name the Model Manager shows for it. */
  catalogName?: string
}

const fileOf = (name: string) => name.replace(/^.*[\\/]/, '')
const stemOf = (name: string) => fileOf(name).replace(/\.safetensors$/i, '')

/** The catalogue's LoRA add-ons by file name: the family is the bundle's
 *  workflow, its label the bundle's first tag ("MiniMax H3", "SDXL"). */
let catalogLoras: Map<string, KnownLora> | null = null
function catalog(): Map<string, KnownLora> {
  catalogLoras ??= new Map(getLoraAddonBundles().flatMap((b) => b.files.map((f) => [
    (f.filename ?? '').toLowerCase(),
    { family: b.workflow as ModelType, familyLabel: b.tags[0], catalogName: b.name },
  ])))
  return catalogLoras
}

/**
 * What the app knows about a file in models/loras, or null when it knows
 * nothing. Two kinds are known: a character or a style from Character Studio
 * (trainer naming `char_<name>_zimage` / `style_<name>_zimage`, Z-Image) and the catalogue's own add-ons
 * (the MiniMax H3 turbo LoRA, Pixel Art XL). Everything else is a file the
 * user put there, and the app does not guess a family from its name.
 */
export function knownLora(name: string): KnownLora | null {
  // A style from the same trainer (3.0.9 P8) is the same kind of file.
  if (parseLocalCharacterLora(name) || parseLocalStyleLora(name)) return { family: 'zimage', familyLabel: 'Z-Image' }
  return catalog().get(fileOf(name).toLowerCase()) ?? null
}

/** Any other model would only get noise from a LoRA of a known family. A
 *  catalogue LoRA is not ruled out on a model the app could not classify:
 *  that would be a guess about the model. */
export function loraFitsModel(name: string, modelType: ModelType): boolean {
  const known = knownLora(name)
  if (!known || known.family === modelType) return true
  return modelType === 'unknown' && !!known.catalogName
}

export interface LoraRow {
  /** The name ComfyUI lists, which is what a run sends. */
  name: string
  /** What the row reads: the catalogue name, or the file name without its ending. */
  label: string
  /** The full file name, for the row's tooltip. */
  file: string
  fits: boolean
  /** For a row that does not fit: the family it belongs to. */
  familyLabel?: string
}

/**
 * The rows the stack shows for the picked model. A LoRA of unknown origin is
 * always offered. A catalogue LoRA is offered where its family runs (the H3
 * turbo LoRA on MiniMax H3, not on an image model); elsewhere it only shows
 * while it is still ticked, so it can be turned off. A character keeps its
 * row on every model with "Z-Image only", as since 3.0.4.
 */
export function loraRows(listed: string[], picks: LoraPick[], modelType: ModelType): LoraRow[] {
  const rows: LoraRow[] = []
  for (const name of listed) {
    const known = knownLora(name)
    const fits = loraFitsModel(name, modelType)
    if (!fits && known?.catalogName && !picks.some((p) => p.name === name)) continue
    rows.push({
      name,
      label: known?.catalogName ?? name.replace(/\.safetensors$/i, ''),
      file: fileOf(name),
      fits,
      ...(fits ? {} : { familyLabel: known?.familyLabel }),
    })
  }
  return rows
}

/**
 * What a run sends. `listed` is ComfyUI's live loras list, or null when it
 * could not be read; then nothing counts as missing, because "not reachable"
 * is no proof a file is gone.
 */
export function lorasForRun(
  picks: LoraPick[],
  listed: string[] | null,
  modelType: ModelType,
): { use: LoraPick[]; missing: string[]; otherModel: string[] } {
  const missing: string[] = []
  const otherModel: string[] = []
  const use: LoraPick[] = []
  for (const p of picks) {
    if (listed && !listed.includes(p.name)) missing.push(p.name)
    else if (!loraFitsModel(p.name, modelType)) otherModel.push(p.name)
    else use.push(p)
  }
  return { use, missing, otherModel }
}

/** The progress line for picks a run leaves out, or null when it uses all. */
export function skippedLorasLine(missing: string[], otherModel: string[]): string | null {
  const parts: string[] = []
  if (missing.length) parts.push(`no longer in models/loras: ${missing.map(stemOf).join(', ')}`)
  const characters = otherModel.filter((n) => !knownLora(n)?.catalogName)
  if (characters.length) parts.push(`Z-Image characters only: ${characters.map(stemOf).join(', ')}`)
  for (const name of otherModel) {
    const known = knownLora(name)
    if (known?.catalogName) parts.push(`${known.familyLabel} only: ${known.catalogName}`)
  }
  return parts.length ? `Skipping LoRA ${parts.join('; ')}` : null
}

/**
 * The rows a search in the stack leaves (Discord 2026-10-23: with many LoRAs
 * the list had to be scrolled through to find one). Case does not count.
 * Every word of the search has to be found, in the name the row reads or in
 * the name ComfyUI lists (folder included). An empty search leaves all rows.
 */
export function filterLoraRows(rows: LoraRow[], query: string): LoraRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return rows
  return rows.filter((r) => {
    const hay = `${r.label}\n${r.name}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** What the copy button of a row puts on the clipboard: the file name without
 *  folder and ending, which is where people keep a LoRA's trigger words. */
export function loraCopyText(name: string): string {
  return stemOf(name)
}
