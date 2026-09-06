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
 * touched. One limit is real and the Settings copy names it: only a ComfyUI
 * that LU starts is handed the folder. The subfolders are scanned again on
 * every one of those starts, so a subfolder added later arrives with the next
 * start.
 */

import { backendCall } from '../api/backend'
import { log } from './logger'

/**
 * What the folder is worth right now.
 *
 * `unusable` is a relative path or a `~` the OS never expands, `unreachable` is
 * a folder that is not there (an unplugged drive, a dead network mount), and
 * `denied` is one that is there and closed to the account this app runs as.
 * All three used to be silence, and the middle two used to be one answer, so a
 * folder without read rights was reported as a missing drive.
 */
export type CustomModelDirStatus =
  | 'off'
  | 'ok'
  | 'unusable'
  | 'unreachable'
  | 'denied'
  /** This host never starts a ComfyUI, so there is nobody to hand the folder
   *  to. The Mac, where local media is MLX. */
  | 'unsupported'
  | 'unknown'

export interface CustomModelPathSync {
  /** Whether a config file is on disk for ComfyUI to read. */
  written: boolean
  status: CustomModelDirStatus
  file: string
  /** ComfyUI folder names handed over, e.g. `['loras', 'vae']`. */
  folders: string[]
}

export interface CustomModelDirResult {
  status: CustomModelDirStatus
  folders: string[]
}

/**
 * Register (or clear) the folder with ComfyUI, and report back what it is
 * worth.
 *
 * Never throws: an older backend without the command costs the handover and
 * nothing else, and says `unknown` rather than inventing a verdict. The GGUF
 * scan is a separate path and keeps working either way.
 */
export async function syncCustomModelDir(
  dir: string | undefined | null,
): Promise<CustomModelDirResult> {
  const trimmed = (dir ?? '').trim()
  try {
    const res = await backendCall<CustomModelPathSync>('sync_custom_model_paths', {
      dir: trimmed,
    })
    return { status: res?.status ?? 'unknown', folders: res?.folders ?? [] }
  } catch (err) {
    log.warn('[models] custom model folder not handed to ComfyUI', { err })
    return { status: 'unknown', folders: [] }
  }
}
