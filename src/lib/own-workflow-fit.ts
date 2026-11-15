// Whether a workflow of the user's own fits the model it is assigned to, by
// the loader it brings: a file from diffusion_models needs a UNETLoader, a
// checkpoint a CheckpointLoaderSimple. A workflow with the wrong loader is
// set aside and LU's own builder runs instead.
//
// GitHub #196 (P5, 3.0.9): this used to be a fixed list of families (Flux,
// Flux 2, Z-Image, Wan, Hunyuan). An LTX 2.5 model was not on it, so the
// Comfy-Org LTX 2.5 template, which loads its transformer with UNETLoader,
// was dropped without a word and LU rendered its own graph. The folder the
// model list found the file in decides now; the list is only the fallback
// for a model no list holds.

import type { ComfyModelSource } from '../types/models'

const UNET_FAMILIES = new Set(['flux', 'flux2', 'zimage', 'wan', 'wan22', 'hunyuan', 'ltx25', 'minimaxh3image', 'mossimage'])

export function modelNeedsUnetLoader(type: string, source?: ComfyModelSource): boolean {
  if (source === 'diffusion_model') return true
  if (source === 'checkpoint') return false
  return UNET_FAMILIES.has(type)
}

/** Null when the workflow fits, else why it is set aside. */
export function ownWorkflowMisfit(classTypes: readonly string[], type: string, source?: ComfyModelSource): string | null {
  // GH #192: for a model LU does not know, found in no folder that says what
  // it is, the user's assignment is the only knowledge there is; it used to be
  // taken for a checkpoint and a UNET workflow was dropped. Where the folder
  // is known, it decides as for every model (#196).
  if (type === 'unknown' && !source) return null
  const needsUnet = modelNeedsUnetLoader(type, source)
  const hasUnet = classTypes.includes('UNETLoader')
  const hasCheckpoint = classTypes.includes('CheckpointLoaderSimple')
  if (needsUnet && !hasUnet && hasCheckpoint) return 'model needs UNETLoader but workflow has CheckpointLoaderSimple'
  if (!needsUnet && hasUnet && !hasCheckpoint) return 'model needs CheckpointLoaderSimple but workflow has UNETLoader'
  return null
}

/**
 * C72 (3.1.0): the sentence for a workflow that is set aside, or null when it
 * fits. The run used to say it only in the developer console, and Create
 * rendered LU's own graph as if the workflow had been used.
 */
export function ownWorkflowMisfitNote(workflowName: string, classTypes: readonly string[], type: string, source?: ComfyModelSource): string | null {
  if (!ownWorkflowMisfit(classTypes, type, source)) return null
  const what = modelNeedsUnetLoader(type, source)
    ? 'this model is a diffusion model and needs a UNETLoader, but the workflow loads a checkpoint (CheckpointLoaderSimple)'
    : 'this model is a checkpoint and needs a CheckpointLoaderSimple, but the workflow loads a UNETLoader'
  return `Your workflow "${workflowName}" is not used: ${what}. LU builds its own workflow for this model instead. Change the loader in ComfyUI and import the workflow again, or use it with a model it fits.`
}
