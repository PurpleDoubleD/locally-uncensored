/**
 * Background pictures for a chat or a persona (3.1.0, C58).
 *
 * A picture comes from three places, all on a click of the user and never on
 * their own: a file from disk, a render from the Create gallery (local or LU
 * Cloud, fetched through the gallery's own path), or a new render of the
 * current scene through the image path the chat tools use (ComfyUI on
 * Windows and Linux, MLX on a Mac). In the cloud mode a new render goes
 * through Create, where the price is shown before anything runs; this module
 * does not spend credits.
 *
 * Every picture is scaled down to at most BG_EDGE on its long side and saved
 * as JPEG into the attachment store, so the store keeps a short reference
 * and the file is a few hundred kB, not the 10 MB a render can be.
 */
import { storeAttachment } from './chat-attachments'
import { resultMediaUrl } from './chat-media-refs'
import { fileUrlToPath } from './local-media-url'

export const BG_EDGE = 1920
const MAX_INPUT_BYTES = 40 * 1024 * 1024

/** Scale a picture down and encode it as a JPEG data URL. */
export async function pictureToDataUrl(blob: Blob, edge = BG_EDGE): Promise<string> {
  if (!blob.type.startsWith('image/') && blob.type !== '') throw new Error('This file is not a picture.')
  if (blob.size > MAX_INPUT_BYTES) throw new Error('This picture is larger than 40 MB.')
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new Error('This picture could not be read.')
  })
  try {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This picture could not be drawn.')
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.86)
  } finally {
    bitmap.close()
  }
}

/** Save a picture as a background and return its reference. */
export async function storeBackground(blob: Blob): Promise<string> {
  const data = await pictureToDataUrl(blob)
  const stored = await storeAttachment({ data })
  return stored.data
}

/** The address of the picture in an image_generate result
 *  (`Image generated: <file> (prompt: "...")\n<url>`), or null. The same
 *  reading as the chat's own media (lib/chat-media-refs): a ComfyUI /view
 *  address, absolute or the dev proxy's relative `/comfyui/view?…`, a
 *  `file://` the Mac wrote, or a `data:` picture. */
export function resultUrl(result: string): string | null {
  const url = resultMediaUrl(result)
  return url && !/^data:video\//i.test(url) ? url : null
}

/** Whether the tool said it made a picture. Its refusals and failures are
 *  sentences ("Error: ...", "Cannot generate: ...", "... cancelled."). */
export function generatedOk(result: string): boolean {
  return /^Image generated:/i.test(result.trim()) && resultUrl(result) !== null
}

/** The bytes behind a result address, base64. A Mac render is a file the
 *  app wrote; it is read the way the vision loop reads it (read_media_file). */
export async function readResultPicture(url: string): Promise<string> {
  if (/^file:\/\//i.test(url)) {
    const path = fileUrlToPath(url)
    if (!path) throw new Error('The picture file could not be found.')
    const { backendCall } = await import('../api/backend')
    return backendCall<string>('read_media_file', { path })
  }
  const { fetchComfyImageBase64 } = await import('../api/comfyui')
  return fetchComfyImageBase64(url)
}

/**
 * A new background from `prompt`, rendered locally through the chat's own
 * image path, owned by `conversationId` so Stop ends exactly this render.
 */
export async function renderSceneBackground(prompt: string, conversationId: string): Promise<string> {
  const { generateMediaForRemote } = await import('../api/mcp/builtin-tools')
  const result = await generateMediaForRemote('image', { prompt, aspectRatio: '16:9' }, conversationId)
  if (!generatedOk(result)) throw new Error(result.trim().split('\n')[0] || 'The picture was not made.')
  const b64 = await readResultPicture(resultUrl(result)!)
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return storeBackground(new Blob([bytes]))
}

/** Stop a render started by renderSceneBackground. */
export async function cancelSceneBackground(conversationId: string): Promise<void> {
  const { isMlxImageHost } = await import('../api/mlx-image')
  if (isMlxImageHost()) {
    const { cancelMlxGenerate } = await import('../api/mlx-image')
    await cancelMlxGenerate().catch(() => null)
    return
  }
  const { requestGenerationCancel } = await import('../api/vram-handoff')
  requestGenerationCancel(conversationId)
}
