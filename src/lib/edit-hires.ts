import { qwenEditResolution } from '../api/dynamic-workflow'
import { isQwenImageEditModel } from './edit-references'
import { editCanvas } from './image-engines'
import type { ImageRef } from './image-ref'

/**
 * The canvas a local ComfyUI Edit comes out at, before Native HiRes scales
 * it. In Create the sliders are the canvas; in Edit the source picture is:
 *
 * - Qwen-Image 2.1 edits on the pixel budget of the sliders, in the shape of
 *   the source (TextEncodeQwenImage21 `resolution`, as `editCanvas` mirrors).
 * - Qwen-Image-Edit 2509/2511 goes through FluxKontextImageScale, which picks
 *   the trained size closest to the source, about one megapixel.
 * - Every other edit encodes the source as it is (VAEEncode).
 *
 * An estimate for the size line and the 4096 limit: the HiRes node itself
 * scales whatever latent the first pass made (LatentUpscaleBy, api/hires-fix).
 */
export function editHiresBase(opts: {
  source: Pick<ImageRef, 'width' | 'height'> | null | undefined
  width: number
  height: number
  modelType?: string
  modelName?: string
  /** C75: a Qwen-Image 2.1 edit in the shape of the size fields. */
  editShape?: 'source' | 'canvas'
}): { width: number; height: number } | null {
  const { source, width, height, modelType, modelName } = opts
  if (!source || !(source.width > 0) || !(source.height > 0)) return null
  // MiniMax H3 Image edits the same way (3.1.3): the pixels of the fields in
  // the shape of the source, or ("Custom size") the fields' shape.
  if (modelType === 'qwenimage' || modelType === 'minimaxh3image') {
    // "Custom size": the canvas has the fields' shape; the whole source is
    // the reference, nothing of it is cropped (3.1.3).
    return editCanvas(qwenEditResolution(width, height), opts.editShape === 'canvas' ? { width, height } : source)
  }
  if (modelType === 'qwenimage1' && modelName && isQwenImageEditModel(modelName)) return editCanvas(1024, source)
  return { width: source.width, height: source.height }
}
