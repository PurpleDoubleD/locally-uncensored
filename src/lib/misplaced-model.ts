/**
 * GitHub #234 (luisalvarado, 14.11.2026): a bare video model,
 * ltx-2.5-22b-distilled-transformer-fp8_e4m3fn.safetensors, sat in
 * models/checkpoints. Create offered it, sent it to UNETLoader, which reads
 * models/diffusion_models only, and the user got ComfyUI's raw line
 * "Node 1 (UNETLoader): Value not in list (unet_name: '...' not in (list of
 * length 22))". The same happens the other way round for a full checkpoint
 * in diffusion_models.
 *
 * ComfyUI rejects such a prompt while validating it, before anything runs.
 * This reads that rejection: a loader that did not find its file, and the
 * file is in the other main-model folder. Then the user is told which file,
 * where it is, where it belongs and what to do. LU does not move a file the
 * user put there (ModelFileInfo.tsx); it says where.
 */

/** The loaders that read one main-model folder, and the field naming the file. */
const LOADERS: Record<string, { field: string; folder: 'checkpoints' | 'diffusion_models' }> = {
  UNETLoader: { field: 'unet_name', folder: 'diffusion_models' },
  UnetLoaderGGUF: { field: 'unet_name', folder: 'diffusion_models' },
  CheckpointLoaderSimple: { field: 'ckpt_name', folder: 'checkpoints' },
}

export interface MissedModel {
  loader: string
  file: string
  folder: 'checkpoints' | 'diffusion_models'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The files ComfyUI's main-model loaders could not find, from a /prompt
 *  rejection (`node_errors`). Empty for any other rejection. */
export function missedModelsOf(rejection: unknown): MissedModel[] {
  const nodeErrors = isRecord(rejection) ? rejection.node_errors : undefined
  if (!isRecord(nodeErrors)) return []
  const out: MissedModel[] = []
  for (const data of Object.values(nodeErrors)) {
    if (!isRecord(data)) continue
    const cls = typeof data.class_type === 'string' ? data.class_type : ''
    const loader = LOADERS[cls]
    if (!loader || !Array.isArray(data.errors)) continue
    for (const e of data.errors) {
      if (!isRecord(e)) continue
      const details = typeof e.details === 'string' ? e.details : ''
      const extra = isRecord(e.extra_info) ? e.extra_info : {}
      const field = typeof extra.input_name === 'string' ? extra.input_name : loader.field
      const value = typeof extra.received_value === 'string'
        ? extra.received_value
        : new RegExp(`${field}: '([^']+)' not in`).exec(details)?.[1]
      if (field === loader.field && value && /not in/i.test(`${e.message ?? ''} ${details}`)) {
        out.push({ loader: cls, file: value, folder: loader.folder })
      }
    }
  }
  return out
}

/** The sentence for a file that sits in the other main-model folder, or null
 *  when it is in neither (then ComfyUI's own line says it best). */
export function misplacedModelMessage(
  missed: MissedModel,
  lists: { checkpoints: readonly string[]; diffusionModels: readonly string[] },
): string | null {
  const inOther = missed.folder === 'diffusion_models'
    ? lists.checkpoints.includes(missed.file)
    : lists.diffusionModels.includes(missed.file)
  if (!inOther) return null
  const foundIn = missed.folder === 'diffusion_models' ? 'checkpoints' : 'diffusion_models'
  const what = missed.folder === 'diffusion_models'
    ? 'It is a bare diffusion model, and ComfyUI loads those only from models/diffusion_models'
    : 'It is a full checkpoint, and ComfyUI loads those only from models/checkpoints'
  return `“${missed.file}” is in models/${foundIn}. ${what}. Move the file to models/${missed.folder} in your ComfyUI folder, restart ComfyUI, and press Create again.`
}
