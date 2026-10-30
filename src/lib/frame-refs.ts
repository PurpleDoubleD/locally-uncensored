// Which model takes what besides the one start image (B38, B45, 3.0.9).
//
// Discord 29.10. and 30.10.2026: Animate should take more than one picture
// (several references, a start and an end image), and Create should take
// reference images for style, pose and camera angle, above all with Krea 2.
// One reader for the picker lines, the Stage, the builder and the submit
// guard, so none of them offers what another refuses.
//
// Read off the node schemas of ComfyUI master b5a43215 (30.10.2026) and the
// official Comfy-Org templates (workflow_templates abb9cf64):
//   - WanFirstLastFrameToVideo takes start_image and end_image. The templates
//     run it with the Wan 2.2 A14B i2v pair (video_wan2_2_14B_flf2v) and the
//     Wan 2.1 FLF2V 14B file (wan2.1_flf2v_720_f16). The TI2V-5B goes through
//     Wan22ImageToVideoLatent, which has a start_image only.
//   - MiniMaxH3ImageToVideo (fl2va) takes first_frame and last_frame;
//     MiniMaxH3ReferenceToVideo (ref2va) takes ref_image_0 to ref_image_8.
//   - WanVaceToVideo reads reference_image[:1], one picture only.
//   - Krea 2 reads reference latents. The template
//     image_krea2_turbo_int8_image_style_reference runs them through
//     TextEncodeQwenImageEditPlus (image1 to image3) with the Comfy-Org LoRA
//     krea2_style_reference: a STYLE reference, not pose or angle.
//   - TextEncodeQwenImage21 has the reference slots image_1 to image_16.
//   - FLUX.2 chains ReferenceLatent (image_flux2, the Klein edit templates).
import { classifyModel, isFastH3, isWan22A14B, videoLaneModels, type ClassifiedModel, type ModelType } from '../api/comfyui'
import { MAX_EXTRA_REFERENCES } from './edit-references'

/** Can the local graph of this video model take an end image as well? */
export function localEndFrame(model: string | null | undefined): boolean {
  if (!model) return false
  const lower = model.toLowerCase()
  const type = classifyModel(model)
  if (type === 'minimaxh3') return !isFastH3(lower) && !/ref2va/.test(lower)
  if (type !== 'wan') return false
  if (/(^|[^a-z0-9])fl?f2v([^a-z0-9]|$)/.test(lower)) return true
  return isWan22A14B(lower) && /(^|[^a-z])i2v([^a-z]|$)/.test(lower)
}

/** The line Animate shows where a local model takes the start image only. */
export const LOCAL_END_FRAME_MODELS = 'An end image works with Wan 2.2 14B i2v, Wan 2.1 FLF2V and MiniMax H3 here, and in LU Cloud with Wan 3.0, Seedance 2.5, LTX 2.5 and MiniMax H3.'

/** A long clip is made in sections (B18), and only one clip can end on the
 *  end image. */
export const END_IMAGE_ONE_CLIP = 'An end image works for one clip up to the model\'s own length. Set the length back to one clip, or remove the end image.'

/** How many further pictures a LOCAL Animate model reads besides the one on
 *  the Stage. MiniMax H3 ref2va reads nine references in all. VACE reads
 *  one, the picture on the Stage, so it takes no further ones. */
export function localAnimateReferenceSlots(model: string | null | undefined): number {
  if (!model) return 0
  if (classifyModel(model) === 'minimaxh3' && !isFastH3(model) && /ref2va/i.test(model)) return 8
  return 0
}

/** What a reference image does for a local Create (text to image) model. */
export type CreateReferenceKind = 'style' | 'content'

export interface CreateReferenceSupport {
  /** How many reference images the model reads. 0: none. */
  slots: number
  kind?: CreateReferenceKind
}

/** The most references LU hands FLUX.2 in one run. Each one is encoded at
 *  about a megapixel and joins the sequence, so on a 12 GB card four is
 *  already a lot. */
export const FLUX2_MAX_REFERENCES = 4
/** TextEncodeQwenImageEditPlus has image1 to image3. */
export const KREA2_MAX_REFERENCES = 3

/** Reference images for Create (text to image) on the local lane. */
export function createReferenceSupport(type: ModelType | null | undefined, model: string | null | undefined): CreateReferenceSupport {
  const t = type ?? (model ? classifyModel(model) : null)
  if (t === 'krea2') return { slots: KREA2_MAX_REFERENCES, kind: 'style' }
  if (t === 'qwenimage') return { slots: MAX_EXTRA_REFERENCES + 1, kind: 'content' }
  if (t === 'flux2') return { slots: FLUX2_MAX_REFERENCES, kind: 'content' }
  return { slots: 0 }
}

/** The honest line where the model on screen takes no reference image. */
export const CREATE_REFERENCE_MODELS = 'Reference images work with Krea 2 (style), Qwen-Image 2.1 and FLUX.2 (style, pose, camera angle, people). This model makes the picture from the prompt alone.'

/** The line over the reference tiles. */
export function createReferenceLine(kind: CreateReferenceKind | undefined, count: number): string {
  if (kind === 'style') {
    return 'Krea 2 takes the style of these images (colours, brushwork, mood), not the pose or camera angle. It needs the free Krea 2 style reference LoRA (436 MB), which Create offers to download on the first run.'
  }
  return count > 0
    ? `Name them in the prompt as ${count === 1 ? 'image 1' : count === 2 ? 'image 1 and image 2' : `image 1 to image ${count}`}, for example "the pose of image 1, the jacket from image 2".`
    : 'Add images for the style, the pose, the camera angle or a person, and say in the prompt what to take from each.'
}

/** The official style reference LoRA of the Krea 2 template, from the
 *  Comfy-Org repack (Hugging Face Comfy-Org/Krea-2, not gated,
 *  krea-2-community-license). Size and sha256 as the Hugging Face tree API
 *  states them on 30.10.2026. */
export const KREA2_STYLE_LORA = {
  filename: 'krea2_style_reference.safetensors',
  url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/loras/krea2_style_reference.safetensors',
  sizeBytes: 457111760,
  sha256: 'f50df5a9e62e4be8aa926a63dd5bb1a64770c4004f763c1208007ae13daa82b8',
} as const

/** The video model a local run of `intent` actually uses: the stored pick
 *  where the lane can run it, else the first one it can (useCreate does the
 *  same before it builds). */
export function laneVideoModel(list: ClassifiedModel[], stored: string, intent: string): string {
  if (list.length === 0) return stored
  const lane = videoLaneModels(list, intent)
  return lane.some((m) => m.name === stored) ? stored : (lane[0]?.name ?? stored)
}
