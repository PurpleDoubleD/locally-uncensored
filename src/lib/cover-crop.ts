// C75 on a Mac: a Qwen-Image 2.1 edit in a shape of its own. The engine's
// edit follows the shape of its first image, as the ComfyUI encode node does,
// so the picture is cut to the asked shape before it is staged: the largest
// centred piece of it in that aspect ratio, at its own pixels (never scaled
// up). The mask is cut by the same rectangle, so it still lies on the picture.

/** The centred piece of a `srcW` x `srcH` picture in the aspect ratio of
 *  `w` x `h`, in whole source pixels. */
export function coverCropRect(srcW: number, srcH: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  if (!(srcW > 0 && srcH > 0 && w > 0 && h > 0)) return { sx: 0, sy: 0, sw: Math.max(1, srcW), sh: Math.max(1, srcH) }
  const want = w / h
  let sw = srcW
  let sh = Math.round(srcW / want)
  if (sh > srcH) {
    sh = srcH
    sw = Math.round(srcH * want)
  }
  sw = Math.max(1, Math.min(srcW, sw))
  sh = Math.max(1, Math.min(srcH, sh))
  return { sx: Math.floor((srcW - sw) / 2), sy: Math.floor((srcH - sh) / 2), sw, sh }
}

/** `image` cut to the centred piece in the aspect ratio of `w` x `h`, as a PNG. */
export async function coverCropBlob(image: Blob, w: number, h: number): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  const { sx, sy, sw, sh } = coverCropRect(bitmap.width, bitmap.height, w, h)
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be cut to its shape.'))), 'image/png'))
}
