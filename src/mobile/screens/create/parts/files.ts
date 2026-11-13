/**
 * What a picked file may be before it goes to the cloud, in the words of
 * Create. The rules are the logic layer's: lib/media-file.ts (kind of a
 * file), lib/phone-image.ts (photos), lib/upload-limits.ts (the byte limits,
 * from the catalog when the server names them).
 */
import { checkFileAgainst, type FileProblem, type MediaKind } from '../../../../lib/media-file'
import { uploadLimitBytes } from '../../../../lib/upload-limits'

export { extensionOf, fileKind, isHeic, type FileProblem, type MediaKind } from '../../../../lib/media-file'
export { MAX_IMAGE_SIDE, needsReencode, scaledSize } from '../../../../lib/phone-image'

/** Why a file cannot be used as `wanted`, or null. The limit is the one in force right now. */
export function checkFile(file: { name: string; type: string; size: number }, wanted: MediaKind): FileProblem | null {
  return checkFileAgainst(file, wanted, uploadLimitBytes(wanted))
}

// ---------- names for saving ----------

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
}

const KIND_FALLBACK: Record<MediaKind, { ext: string; mime: string }> = {
  image: { ext: 'png', mime: 'image/png' },
  video: { ext: 'mp4', mime: 'video/mp4' },
  audio: { ext: 'mp3', mime: 'audio/mpeg' },
}

/** What a result can be: a medium, or a 3D model (3.1.0). */
export type ResultKind = MediaKind | '3d'

/** A 3D model is stored as plain bytes, so its type never names it. It is
 *  always the GLB it was made as. */
const GLB = { ext: 'glb', mime: 'model/gltf-binary' }

/** File name and type for a result that is saved or shared. */
export function saveName(kind: ResultKind, blobType: string, createdAt: number, id: string): { name: string; mime: string } {
  const type = blobType.split(';')[0].trim().toLowerCase()
  const fallback = kind === '3d' ? GLB : KIND_FALLBACK[kind]
  const known = kind !== '3d' && !!MIME_EXT[type]
  const ext = known ? MIME_EXT[type] : fallback.ext
  const mime = known ? type : fallback.mime
  const d = new Date(createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
    : 'result'
  const tail = id.replace(/[^a-z0-9]/gi, '').slice(-6) || 'lu'
  return { name: `lu-${stamp}-${tail}.${ext}`, mime }
}

/** Where a result is saved: pictures and clips to Photos, sound and 3D models to Files. */
export function saveTarget(kind: ResultKind): 'photos' | 'files' {
  return kind === 'audio' || kind === '3d' ? 'files' : 'photos'
}
