/**
 * The image part of a local chat model, as the surfaces talk about it.
 *
 * A GGUF chat model takes pictures only when a second file lies next to it,
 * which llama.cpp calls mmproj. The owner's rule (October 2026): whoever
 * downloads such a model here gets that file with it, as part of the same
 * download, and where it is missing on a machine the app offers to add it with
 * one click.
 *
 * This file holds what every surface has to agree on: the name the part gets
 * on disk, how a model and its part read as ONE download, what the sizes sum
 * to, and the words. Pure and without imports from api/, so the catalog, the
 * download store and the components can all read it and no import cycle forms.
 */

import type { DownloadProgress } from '../types/downloads'

const GIB = 1_073_741_824

/**
 * On-disk name of the image part that belongs to `modelFilename`:
 * `<model stem>.mmproj.gguf`, written next to the model.
 *
 * Derived, never hand-written in the catalog, because the built-in engine has
 * to find the part from the model path alone (src-tauri engine.rs
 * `mmproj_sibling_path` mirrors this exact rule). The upstream repositories
 * disagree on naming (`mmproj-F16.gguf`, `mmproj-model-bf16.gguf`,
 * `Holo-3.1-9B.mmproj-Q8_0.gguf`), and the built-in models folder is flat, so
 * keeping the upstream name would leave two models fighting over one file.
 * Tying the name to the model also keeps the pairing right when a user
 * downloads several sizes of one model.
 *
 * A split model names its part after its first file, which is the path the
 * engine is started with.
 */
export function imagePartFileName(modelFilename: string): string {
  const stem = modelFilename.replace(/\.gguf$/i, '')
  return `${stem}.mmproj.gguf`
}

/**
 * What the part beside the model does, in the words a tile uses. Most parts
 * are image parts; LFM3 Audio's carries only an audio encoder (N1, the
 * projector's head says `clip.has_audio_encoder`), and the catalog marks such
 * an entry with the tag "Audio" and without "Vision".
 */
export function partInputWord(model: { tags?: string[] }): 'image input' | 'sound input' {
  const tags = model.tags ?? []
  return tags.includes('Audio') && !tags.includes('Vision') ? 'sound input' : 'image input'
}

/** True for the on-disk name of an image part. */
export function isImagePartFile(filename: string): boolean {
  return /\.mmproj\.gguf$/i.test(filename)
}

/** The model file an image part belongs to, or null for any other file. */
export function modelFileOfImagePart(partFilename: string): string | null {
  if (!isImagePartFile(partFilename)) return null
  return partFilename.replace(/\.mmproj\.gguf$/i, '.gguf')
}

/** Bytes as the GB number the catalog shows (GiB, one decimal). */
export function gbOf(bytes: number | undefined): number {
  if (!bytes || bytes <= 0) return 0
  return Math.round((bytes / GIB) * 10) / 10
}

/**
 * What a download of the model takes on disk: the model alone, or model plus
 * image part. One decimal, like every size on the Models page.
 */
export function downloadSizeGB(modelGB: number | undefined, partBytes: number | undefined, withPart: boolean): number | undefined {
  if (!modelGB) return undefined
  if (!withPart || !partBytes) return modelGB
  return Math.round((modelGB + partBytes / GIB) * 10) / 10
}

/** The label of the tick box in the download dialogs. */
export function includeImageInputLabel(partBytes: number | undefined): string {
  const gb = gbOf(partBytes)
  return gb > 0 ? `Include image input (+${gb} GB)` : 'Include image input'
}

/** The label of the one click that adds a missing part to an installed model. */
export function addImageInputLabel(partBytes: number | undefined): string {
  const gb = gbOf(partBytes)
  return gb > 0 ? `Add image input (${gb} GB)` : 'Add image input'
}

/** Said beside an installed model that could see and cannot yet. */
export const IMAGE_INPUT_MISSING = 'This model can take images, but its image part is not installed.'

/** Said where a picture was handed to a model whose image part is installed
 *  and was left out when the model was loaded. The model menu carries the
 *  reason the engine gave. */
export const IMAGE_INPUT_LOADED_WITHOUT = 'This model was loaded without its image part, so it cannot read the attachment. The model menu says why.'

/** Said where a picture was handed to a model that has no image input at all. */
export const NO_IMAGE_INPUT = 'This model has no image input.'

type Row = Pick<DownloadProgress, 'progress' | 'total' | 'speed' | 'status' | 'error' | 'filename'>

/**
 * A model and its image part as ONE download: one progress, one total.
 *
 * The rows are the model's first, then the part's when there is one. Rows that
 * do not exist are left out: a user who unticked the image part has no second
 * row, and the model alone is the whole download.
 *
 * The state is the least finished one. Complete only when every row is, so a
 * model whose part is still on its way never reads as installed; an error on
 * either file is the error of the download.
 */
export function asOneDownload(rows: readonly (Row | null | undefined)[]): DownloadProgress | null {
  const there = rows.filter((r): r is Row => !!r)
  if (there.length === 0) return null
  if (there.length === 1) return there[0] as DownloadProgress
  const failed = there.find((r) => r.status === 'error')
  const has = (s: Row['status']) => there.some((r) => r.status === s)
  const status: Row['status'] = failed
    ? 'error'
    : has('downloading')
      ? 'downloading'
      : has('connecting')
        ? 'connecting'
        : has('pausing')
          ? 'pausing'
          : has('paused')
            ? 'paused'
            : 'complete'
  return {
    filename: there[0].filename,
    progress: there.reduce((sum, r) => sum + (r.progress || 0), 0),
    total: there.reduce((sum, r) => sum + (r.total || 0), 0),
    speed: there.reduce((sum, r) => sum + (r.speed || 0), 0),
    status,
    ...(failed?.error ? { error: failed.error } : {}),
  }
}

/** One file of a repository listing, as far as this file reads it. */
export interface RepoFile {
  path: string
  size?: number
  sha256?: string
}

/** True for a file that is an image part in a repository listing. */
export function isUpstreamImagePart(path: string): boolean {
  const leaf = (path.split('/').pop() ?? '').toLowerCase()
  return leaf.endsWith('.gguf') && leaf.includes('mmproj')
}

/**
 * The image part to take out of a repository that offers several.
 *
 * F16 first, then BF16, then Q8_0, then whatever else there is, and F32 last:
 * it is twice the size for nothing a chat can show. The same order the catalog
 * table was filled by (api/image-parts.ts).
 */
export function pickUpstreamImagePart<T extends RepoFile>(files: readonly T[]): T | null {
  const parts = files.filter((f) => isUpstreamImagePart(f.path))
  if (parts.length === 0) return null
  const rank = (f: T): number => {
    const leaf = (f.path.split('/').pop() ?? '').toLowerCase()
    if (leaf.includes('f32')) return 9
    if (/(^|[^b])f16/.test(leaf)) return 0
    if (leaf.includes('bf16')) return 1
    if (leaf.includes('q8_0')) return 2
    return 3
  }
  return [...parts].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))[0]
}

/** What the app knows about the image part of one INSTALLED model. */
export interface InstalledImagePart {
  /** The part lies next to the model. */
  present: boolean
  /** Where to fetch it, when the app knows a source. */
  source: { url: string; sizeBytes?: number; sha256?: string } | null
}

/**
 * Should the app offer to add the image part to this installed model?
 *
 * Yes exactly when the part is not there and a source is known. A model of a
 * family without image input has no source and gets no offer; a model whose
 * part is installed has nothing to add.
 */
export function canAddImagePart(state: InstalledImagePart | null | undefined): boolean {
  return !!state && !state.present && !!state.source
}
