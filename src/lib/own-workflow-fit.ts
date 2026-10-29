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

const UNET_FAMILIES = new Set(['flux', 'flux2', 'zimage', 'wan', 'wan22', 'hunyuan', 'ltx25'])

export function modelNeedsUnetLoader(type: string, source?: ComfyModelSource): boolean {
  if (source === 'diffusion_model') return true
  if (source === 'checkpoint') return false
  return UNET_FAMILIES.has(type)
}

/** Null when the workflow fits, else why it is set aside. */
export function ownWorkflowMisfit(classTypes: readonly string[], type: string, source?: ComfyModelSource): string | null {
  const needsUnet = modelNeedsUnetLoader(type, source)
  const hasUnet = classTypes.includes('UNETLoader')
  const hasCheckpoint = classTypes.includes('CheckpointLoaderSimple')
  if (needsUnet && !hasUnet && hasCheckpoint) return 'model needs UNETLoader but workflow has CheckpointLoaderSimple'
  if (!needsUnet && hasUnet && !hasCheckpoint) return 'model needs CheckpointLoaderSimple but workflow has UNETLoader'
  return null
}
