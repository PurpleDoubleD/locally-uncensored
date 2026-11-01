import type { ModelType } from '../api/comfyui'

/** Qwen-Image-Edit (2509/2511) and FireRed edit files take the source image
 *  through TextEncodeQwenImageEditPlus; plain Qwen-Image does latent img2img. */
export function isQwenImageEditModel(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('edit') && (lower.includes('qwen') || lower.includes('firered'))
}

/** The most extra references any family takes in LU (Qwen-Image 2.1): nine
 *  besides the source, ten images in all. Discord D7 / G26 asked for ten. */
export const MAX_EXTRA_REFERENCES = 9

/** The most further photos the store keeps. The local lane reads the most
 *  (MAX_EXTRA_REFERENCES); a cloud run reads at most four besides its large
 *  source image (create-studio MAX_STUDIO_PHOTOS, five in all). Each model
 *  shows and sends only as many as it reads. */
export const MAX_STORED_REFERENCES = MAX_EXTRA_REFERENCES

/** The most training photos a trained character hands to Edit (MAX_PHOTOS in
 *  src-tauri/src/commands/character_files.rs). Kept at three on purpose: they
 *  are there to hold one face, and every further image takes a slot and, past
 *  FULL_SIZE_IMAGES, shrinks every image of the edit (referenceSide). */
export const MAX_CHARACTER_PHOTOS = 3

/** Up to this many images in all (the source counted), an edit scales every
 *  image to the full side the canvas asks for. That is the most 3.0.4 to
 *  3.0.7 offered, so it is the load a run has been known to carry. */
export const FULL_SIZE_IMAGES = 4

/**
 * The side every image of a Qwen-Image 2.1 edit is scaled to, for `count`
 * images in all (the source counted), when the canvas asks for `side`.
 *
 * Why: TextEncodeQwenImage21 (and mflux on the Mac) scales EVERY image to
 * about side x side pixels. Each one then costs (side / 32)^2 vision tokens in
 * the text encoder and (side / 16)^2 tokens in the diffusion model's sequence,
 * and the reference part of that sequence is kept as a key/value cache. Ten
 * images at 1024 are about 41,000 reference tokens, two and a half times what
 * four images carry; attention grows with the square of that, and the cache
 * spills out of a 12 GB card. So past FULL_SIZE_IMAGES the images share the
 * pixel budget four images at `side` would have: count x newSide^2 stays at
 * or below 4 x side^2. Ten images at 1024 come down to 640, the total stays
 * where 3.0.4 had it, and a smaller canvas shrinks them further.
 *
 * `fullImages` is that budget in full size images: FULL_SIZE_IMAGES unless a
 * smaller graphics card carries fewer (lib/comfy-edit-memory).
 *
 * Floored to the encoder's grid of 32 (never below 32), so the budget is never
 * exceeded. Up to `fullImages` images the side is returned unchanged.
 * Not proven on a 12 GB card with ten images yet (box run pending).
 */
export function referenceSide(side: number, count: number, fullImages: number = FULL_SIZE_IMAGES): number {
  if (!(count > fullImages)) return side
  const shared = side * Math.sqrt(fullImages / count)
  return Math.max(32, Math.floor(shared / 32) * 32)
}

/** How the prompt names the further images: "image 2", "image 2, image 3",
 *  and from three on a range, "image 2 to image 10". */
export function referenceNames(count: number): string {
  if (count <= 0) return ''
  if (count <= 2) return Array.from({ length: count }, (_, i) => `image ${i + 2}`).join(', ')
  return `image 2 to image ${count + 1}`
}

/**
 * How many reference images an Edit may carry BESIDES the source, for one
 * local image model. 0 hides the reference strip.
 *
 * GH #144 and Discord (a user 2026-09-23 and 09-27, a user 2026-09-25):
 * Edit took one image, so "put the person from this photo into that scene"
 * could not be asked at all. Read off the node schemas:
 *   - TextEncodeQwenImage21 (Qwen-Image 2.1) has an Autogrow group of
 *     reference slots image_1 to image_16. LU offers ten images in all: the
 *     model itself reads up to ten (Qwen/Qwen-Image-2.1, and mflux 0.22
 *     `MAX_REFERENCES = 10` in qwen21/variants/edit/qwen_image_21_edit.py,
 *     which the Mac lane runs). 3.0.4 to 3.0.7 offered four. Past four the
 *     images are scaled smaller (referenceSide).
 *   - TextEncodeQwenImageEditPlus (Qwen-Image-Edit 2509/2511) has image1 to
 *     image3, so the source plus two.
 */
export function extraReferenceSlots(type: ModelType | null | undefined, modelName: string): number {
  if (type === 'qwenimage') return MAX_EXTRA_REFERENCES
  if (type === 'qwenimage1' && isQwenImageEditModel(modelName)) return 2
  return 0
}


/** From this many extra images Qwen-Image 2.1 tends to lay them out side by
 *  side unless the prompt says what each one brings (10 images on a Mac,
 *  15.10.2026: only the first fox got the scarf, the rest stood in a grid). */
export const MANY_REFERENCES = 4
export const MANY_REFERENCES_LINE = 'With this many images, say what each one brings, for example "the scarf from image 3".'

/**
 * Whether a local ComfyUI edit with this model takes its strength from
 * `editStrength` (the Mac's field, 1 = the template's edit) instead of the
 * img2img `denoise`. Both Qwen edit families sample at denoise 1.0 from the
 * latent their encoder hands over, as the official templates do. Up to 3.0.7
 * the slider here set `denoise`, which the graph never read (Discord #general
 * 23.10.2026: "even with strength at 95%"); 3.0.8 took it out. B46 (3.0.9):
 * below 1 the run starts from the source at that denoise (dynamic-workflow.ts),
 * so the slider is back and does what it says.
 */
export function readsEditStrength(type: ModelType | null | undefined, modelName: string): boolean {
  return type === 'qwenimage' || (type === 'qwenimage1' && isQwenImageEditModel(modelName))
}
