// C76 (3.1.0): the mask as it is kept (white where painted, on black, the
// ComfyUI LoadImageMask convention) turned back into what is drawn: an alpha
// mask for the editor, a red tint for the preview on the Stage.

/** In place: every pixel becomes `rgb` with the brightness of the stored mask
 *  as its alpha, times `opacity`. Black stays fully see-through. */
export function maskToAlpha(data: Uint8ClampedArray, rgb: readonly [number, number, number], opacity = 1): void {
  for (let i = 0; i < data.length; i += 4) {
    // The brightest channel: a mask is grey, and a feathered edge keeps its share.
    const a = Math.max(data[i], data[i + 1], data[i + 2]) * (data[i + 3] / 255)
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
    data[i + 3] = Math.round(a * opacity)
  }
}

/** The editor's tint, so the preview shows the mask as it was painted. */
export const MASK_TINT: readonly [number, number, number] = [239, 68, 68]
export const MASK_TINT_OPACITY = 0.5

/** Draw `img` at `width` x `height` and hand back its pixels, or null where
 *  the platform has no 2D canvas. */
export function readPixels(img: CanvasImageSource, width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, width, height)
  return { canvas, ctx, data: ctx.getImageData(0, 0, width, height) }
}

/** The stored mask as a red, half see-through PNG for the preview. */
export async function maskTintUrl(maskUrl: string, width: number, height: number): Promise<string | null> {
  const img = new Image()
  img.src = maskUrl
  try { await img.decode() } catch { return null }
  const px = readPixels(img, width, height)
  if (!px) return null
  maskToAlpha(px.data.data, MASK_TINT, MASK_TINT_OPACITY)
  px.ctx.putImageData(px.data, 0, 0)
  return px.canvas.toDataURL('image/png')
}
