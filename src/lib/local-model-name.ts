/**
 * The name a local model carries in the model picker.
 *
 * A local model is a file, and the picker showed the file name with its
 * underscores taken out. For a model that came from the Model Manager that is
 * a second name for the same thing: the box, 03.10.2026, installed the card
 * "Noct Q (Qwen-Image 2.1, Unfiltered)" and then had to recognise it in the
 * picker as "NoctQ V4 int8 convrot". A file the catalogue lists is shown
 * under the name the catalogue gives that file ("Noct Q V4 (INT8)"), which is
 * short and still tells two quants of one model apart. The file name stays
 * reachable as the row's tooltip and in the search. A file the catalogue does
 * not know (a CivitAI download, the user's own) keeps its file name.
 */
import { getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles, getRetiredBundles } from '../api/model-bundles'

let names: Map<string, string> | null = null

function baseName(filename: string): string {
  return (filename.split(/[\\/]/).pop() ?? filename).toLowerCase()
}

/** The catalogue's name for a file, or null when no bundle lists it. */
export function catalogModelName(filename: string): string | null {
  if (!names) {
    names = new Map()
    const bundles = [...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles(), ...getUpscaleBundles(), ...getRetiredBundles()]
    for (const b of bundles) {
      for (const f of b.files) {
        if (f.filename && f.name && !names.has(baseName(f.filename))) names.set(baseName(f.filename), f.name)
      }
    }
  }
  return names.get(baseName(filename)) ?? null
}

/** The file name as the picker always showed it: no extension, no underscores. */
export function prettyFileName(filename: string): string {
  return filename.replace(/\.(safetensors|ckpt|pt|gguf)$/i, '').replace(/[_]+/g, ' ')
}

/** What a picker row says for a local model, and its tooltip. */
export function localModelLabel(filename: string): { label: string; title?: string } {
  const known = catalogModelName(filename)
  return known ? { label: known, title: filename } : { label: prettyFileName(filename) }
}
