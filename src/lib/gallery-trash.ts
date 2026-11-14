// Gallery delete reaches the file (Discord 2026-09-25: "when
// deleting files in app from gallery, they are still in output folder, which
// is getting bigger and bigger"). A local ComfyUI render goes to the Recycle
// Bin / Trash through commands/gallery_files.rs, so a misclick stays
// recoverable. A render of the Mac's engines is a file in the app's own
// output folders and goes to the Trash through commands/mlx_outputs.rs
// (persona walk, 09.10.2026: on a Mac the entry went and the file stayed).
// Cloud renders and anything another gallery entry still shows are left
// alone.

import { backendCall, isTauri } from '../api/backend'
import { invokeMedia } from '../api/mlx-invoke'

/**
 * The fields of a gallery item read here. Declared locally rather than
 * imported from createStore: the store loads this module, so even a type
 * import back is a cycle for `npm run cycles`, which CI runs.
 */
interface GalleryRender {
  filename?: string
  subfolder?: string
  comfyType?: string
  jobId?: string
  remoteUrl?: string
  localPath?: string
}

export function isTrashableRender(item: GalleryRender, remaining: readonly GalleryRender[]): boolean {
  if (!item.filename || item.jobId || item.remoteUrl || item.localPath) return false
  if ((item.comfyType ?? 'output') !== 'output') return false
  return !remaining.some((g) => g.filename === item.filename && (g.subfolder ?? '') === (item.subfolder ?? ''))
}

/** A render of the Mac's engines: a file on this Mac that no other entry shows. */
export function isTrashableMacRender(item: GalleryRender, remaining: readonly GalleryRender[]): boolean {
  if (!item.localPath || item.jobId || item.remoteUrl) return false
  return !remaining.some((g) => g.localPath === item.localPath)
}

/**
 * What Delete does to an entry, so the words on the button say it truly
 * (C3D, 14.11.2026: under a cloud result it said the file goes to the Trash).
 *   trash  a file on this computer that no other entry shows: to the Trash
 *          or the Recycle Bin (trashGalleryFile below);
 *   cloud  a cloud result: it only leaves this app's gallery. Nothing on the
 *          server is deleted, the copy in the account stays (the web gallery
 *          still shows it until it expires);
 *   entry  anything else (a file another entry still shows, a file outside
 *          the output folder): only the entry goes.
 */
export type DeleteFate = 'trash' | 'cloud' | 'entry'

export function deleteFate(item: GalleryRender, remaining: readonly GalleryRender[]): DeleteFate {
  if (item.jobId || item.remoteUrl) return 'cloud'
  return isTrashableMacRender(item, remaining) || isTrashableRender(item, remaining) ? 'trash' : 'entry'
}

/** The fates of several entries deleted one after the other, as the gallery
 *  does it: a file two of them share goes with the second. */
export function deleteFates<T extends GalleryRender & { id: string }>(ids: readonly string[], gallery: readonly T[]): DeleteFate[] {
  let rest = gallery
  return ids.map((id) => {
    const item = rest.find((g) => g.id === id)
    rest = rest.filter((g) => g.id !== id)
    return item ? deleteFate(item, rest) : 'entry'
  })
}

/** deleteFate for every entry of a whole gallery at once, without a scan of
 *  the gallery per entry (the strip has thousands, C27): who else shows the
 *  same file is counted once. Same answer as deleteFate(item, the others). */
export function deleteFateOf<T extends GalleryRender>(all: readonly T[]): (item: T) => DeleteFate {
  const comfy = new Map<string, number>()
  const mac = new Map<string, number>()
  const comfyKey = (g: GalleryRender) => `${g.subfolder ?? ''}\u0000${g.filename}`
  for (const g of all) {
    if (g.filename) comfy.set(comfyKey(g), (comfy.get(comfyKey(g)) ?? 0) + 1)
    if (g.localPath) mac.set(g.localPath, (mac.get(g.localPath) ?? 0) + 1)
  }
  return (item) => {
    if (item.jobId || item.remoteUrl) return 'cloud'
    if (item.localPath) return (mac.get(item.localPath) ?? 0) <= 1 ? 'trash' : 'entry'
    if (!item.filename || (item.comfyType ?? 'output') !== 'output') return 'entry'
    return (comfy.get(comfyKey(item)) ?? 0) <= 1 ? 'trash' : 'entry'
  }
}

/** Returns an error line for the user, or null when all went well. */
export async function trashGalleryFile(item: GalleryRender, remaining: GalleryRender[]): Promise<string | null> {
  if (!isTauri()) return null
  if (isTrashableMacRender(item, remaining)) {
    try {
      await invokeMedia('mlx_output_trash', { path: item.localPath })
      return null
    } catch (err) {
      return `Removed from the gallery, but the file stayed on this Mac: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!isTrashableRender(item, remaining)) return null
  try {
    await backendCall('trash_comfy_output', { filename: item.filename, subfolder: item.subfolder ?? '' })
    return null
  } catch (err) {
    return `Removed from the gallery, but the file stayed in the ComfyUI output folder: ${err instanceof Error ? err.message : String(err)}`
  }
}
