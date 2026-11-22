// What a painted mask does on the local Edit tab. Local mode has no Erase tab:
// an object goes by painting over it in Edit and pressing Create without a
// prompt.
//
// ComfyUI wires a mask into the SD 1.5 and SDXL checkpoint graph only
// (api/dynamic-workflow.ts, sdCheckpointFamily). Every other family refuses
// it at build time, so the tab says so before the click. On a Mac every model
// of the Edit lane is Qwen-Image 2.1, which reads the mask (mflux
// `--mask-image`, commands/image_mflux.rs).

/** The model types that reach the checkpoint graph. 'unknown' does too: the
 *  builder falls through to CheckpointLoaderSimple for it. */
const COMFY_MASK_TYPES: ReadonlySet<string> = new Set(['sd15', 'sdxl', 'unknown'])

export const MASK_NEEDS_CHECKPOINT =
  'This model cannot use a mask. Pick an SDXL or SD 1.5 checkpoint, or clear the mask to edit the whole image.'

export const MASK_PROMPT_PLACEHOLDER = 'Describe what goes there, or leave this empty to remove what you painted…'

export const MASK_READY_LINE = 'Hit Create to remove the painted area, or describe below what should be there instead.'

/** Checkpoint models read tags and scenes, not instructions. */
export const REMOVE_PROMPT_COMFY = 'empty background, seamless continuation of the surrounding area, matching light and texture'
export const REMOVE_NEGATIVE_COMFY = 'object, person, figure, text, watermark, logo, artifacts, seam'
/** Qwen-Image 2.1 follows an instruction. */
export const REMOVE_PROMPT_MAC = 'Remove the object in the masked area and fill it in so it matches the surrounding background.'

export function comfyModelTakesMask(modelType: string): boolean {
  return COMFY_MASK_TYPES.has(modelType)
}

interface MaskState {
  intent: string
  backend: 'local' | 'cloud'
  mac: boolean
  hasMask: boolean
  modelType: string
}

/** Why this masked edit cannot run on the picked model, or null. */
export function localEditMaskBlock(s: MaskState): string | null {
  if (s.backend !== 'local' || s.intent !== 'edit' || !s.hasMask || s.mac) return null
  return comfyModelTakesMask(s.modelType) ? null : MASK_NEEDS_CHECKPOINT
}

/** A local masked edit with an empty prompt: the painted area is removed. */
export function isPromptlessRemoval(s: { intent: string; backend: 'local' | 'cloud'; hasMask: boolean; prompt: string }): boolean {
  return s.backend === 'local' && s.intent === 'edit' && s.hasMask && !s.prompt.trim()
}
