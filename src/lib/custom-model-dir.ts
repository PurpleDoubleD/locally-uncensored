/**
 * The folder under Settings → Model Storage, handed to ComfyUI.
 *
 * GH #122 (zrmdsxa) and the Discord thread "Read me first" (ever.noob) are one
 * folder apart: a chat GGUF in a folder of your own, and a LoRA in one. The
 * GGUF side is ours: `list_bundled_models` scans the folder now. The LoRA
 * side is not: LU never reads image or video models off the disk, that
 * inventory comes out of ComfyUI's `/object_info` enums, and ComfyUI lists
 * only what sits under its own models tree.
 *
 * So this is the handover. Rust writes ComfyUI's own extra-model-paths file
 * for the ComfyUI-shaped subfolders it finds and passes it at start; a
 * hand written `extra_model_paths.yaml` in the user's ComfyUI folder is never
 * touched. Two limits are real and the Settings copy names both: a ComfyUI
 * that LU starts, and the next start of it.
 */

import { backendCall } from '../api/backend'
import { log } from './logger'

export interface CustomModelPathSync {
  written: boolean
  file: string
  /** ComfyUI folder names found in the folder, e.g. `['loras', 'vae']`. */
  folders: string[]
}

/**
 * Register (or clear) the folder with ComfyUI. Returns the folder names that
 * were handed over, `[]` when there were none.
 *
 * Never throws: an older backend without the command, or a folder that has
 * gone away with the drive it lived on, costs the handover and nothing else.
 * The GGUF scan is a separate path and keeps working either way.
 */
export async function syncCustomModelDir(dir: string | undefined | null): Promise<string[]> {
  try {
    const res = await backendCall<CustomModelPathSync>('sync_custom_model_paths', {
      dir: (dir ?? '').trim(),
    })
    return res?.folders ?? []
  } catch (err) {
    log.warn('[models] custom model folder not handed to ComfyUI', { err })
    return []
  }
}
