// A LoRA file of the user's own as a character (3.1.0, "New character").
//
// Where this machine keeps character files, the button that opens that
// folder, and the way a dropped `.safetensors` gets there: the WebView hands
// a dropped file over as bytes, not as a path, so it goes to the backend in
// pieces (src-tauri commands/character_files.rs, take_piece) and gets its
// name `char_<name>_zimage.safetensors` once its header reads as a LoRA.

import { backendCall, isTauri } from '../../api/backend'

/** One piece, before base64. Well under the backend's limit of 16 MB. */
export const LORA_PIECE_BYTES = 4 * 1024 * 1024

export type LoraFolder = { status: 'ok'; path: string } | { status: 'no_comfy' }

/** The LoRA folder of this machine, or null outside the desktop app. */
export async function characterLoraFolder(): Promise<LoraFolder | null> {
  if (!isTauri()) return null
  try {
    const r = await backendCall<{ status?: string; path?: string }>('character_lora_folder')
    return r?.status === 'ok' && r.path ? { status: 'ok', path: r.path } : { status: 'no_comfy' }
  } catch {
    return null
  }
}

/** Shows that folder in the file manager. It is made first if it is not there. */
export async function openCharacterLoraFolder(): Promise<void> {
  await backendCall('character_lora_folder_open')
}

/** A home folder shortened to `~`, as a path reads in a sentence. */
export function shortFolder(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/')
}

export function isLoraFile(file: { name: string }): boolean {
  return file.name.toLowerCase().endsWith('.safetensors')
}

/** The name a dropped file suggests: `char_mira_zimage.safetensors` and
 *  `mira_v2.safetensors` both read "mira…". */
export function nameFromLoraFile(fileName: string): string {
  const base = fileName.replace(/\.safetensors$/i, '')
  const m = /^char_(.+)_zimage$/i.exec(base)
  return (m ? m[1] : base).replace(/[_-]+/g, ' ').trim().slice(0, 40)
}

export type LoraImport =
  | { status: 'saved'; file: string; path: string; keyFormat: 'same' | 'known' | 'unknown' }
  | { status: 'exists'; file: string }
  | { status: 'no_comfy' }

function pieceBase64(piece: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(piece)
  })
}

/**
 * Puts a dropped LoRA file into the LoRA folder under the character's name.
 * `onProgress` hears the bytes that are there. A failure on the way removes
 * what was written; a character of that name is never replaced.
 */
export async function importCharacterLora(
  file: Blob,
  name: string,
  onProgress?: (received: number, total: number) => void,
  pieceBytes: number = LORA_PIECE_BYTES,
): Promise<LoraImport> {
  const total = file.size
  if (total === 0) throw new Error('This file is empty.')
  let offset = 0
  try {
    for (;;) {
      const piece = file.slice(offset, offset + pieceBytes)
      const last = offset + piece.size >= total
      const r = await backendCall<{ status: string; file?: string; path?: string; keyFormat?: string; received?: number }>(
        'character_lora_import',
        { name, offset, dataB64: await pieceBase64(piece), last },
      )
      if (r.status === 'no_comfy') return { status: 'no_comfy' }
      if (r.status === 'exists') return { status: 'exists', file: r.file ?? '' }
      if (r.status === 'saved') {
        onProgress?.(total, total)
        const keyFormat = r.keyFormat === 'same' || r.keyFormat === 'known' ? r.keyFormat : 'unknown'
        return { status: 'saved', file: r.file ?? '', path: r.path ?? '', keyFormat }
      }
      offset += piece.size
      onProgress?.(offset, total)
      if (last) throw new Error('The file did not arrive whole. Nothing was added, drop it again.')
    }
  } catch (err) {
    void backendCall('character_lora_import_cancel', { name }).catch(() => undefined)
    throw err
  }
}
