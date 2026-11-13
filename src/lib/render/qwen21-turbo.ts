// Qwen-Image 2.1 Turbo on ComfyUI (Discord, 28.10.2026: "Turbo looks bad in
// LU, the normal 2.1 is fine"). Turbo is a distilled 8 step checkpoint with
// its own sigma schedule. LU ran it through the same KSampler as the full
// model, at the 25 steps and the simple scheduler of the full model, and the
// pictures came out wrong.
//
// Read off the sources on 28.10.2026:
//   - Comfy-Org/workflow_templates at 14220b8bd3e86baa852959f17039613191e66656,
//     templates/image_qwen_image_2_1_turbo_t2i.json: UNETLoader →
//     QwenImage21Cache("auto", "default") → CFGGuider (cfg 1, the positive and
//     negative of TextEncodeQwenImage21), KSamplerSelect("euler"),
//     RandomNoise, ManualSigmas with the nine values below, EmptyLatentImage,
//     SamplerCustomAdvanced (output slot 0) → VAEDecode. The Turbo edit
//     template has the same chain; its CFGGuider shows a stale widget value
//     of 8, but the cfg input is wired to the subgraph's "cfg", which the
//     outer node sets to 1.
//   - the model card of Qwen/Qwen-Image-2.1-Turbo: 8 denoising steps on the
//     recommended schedule, CFG 1 by default.
//   - ComfyUI v0.42.4, comfy_extras/nodes_custom_sampler.py (ManualSigmas
//     takes one string, CFGGuider model/positive/negative/cfg, RandomNoise
//     noise_seed, KSamplerSelect sampler_name, SamplerCustomAdvanced
//     noise/guider/sampler/sigmas/latent_image) and comfy_extras/nodes_qwen.py
//     (QwenImage21Cache model/device/dtype).
//
// The Mac's Qwen-Image 2.1 Turbo is another thing: the 8-bit pack with the
// Viggle Turbo LoRA on mflux, six steps on that adapter's own schedule
// (commands/image_mflux.rs QWEN21_TURBO). Its picker name starts with "MLX "
// (api/mlx-image MLX_MODEL_PREFIX) and it is left out here.

import { classifyModel } from '../../api/comfyui'

/** The sigmas of the official Turbo templates, word for word. ManualSigmas
 *  reads the numbers out of this one string. */
export const QWEN21_TURBO_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'

/** What Turbo runs at: eight steps (nine sigmas), euler, CFG 1. The scheduler
 *  only matters on the KSampler fallback, where no schedule of its own fits. */
export const QWEN21_TURBO_SAMPLING = { steps: 8, cfg: 1.0, sampler: 'euler', scheduler: 'simple' } as const

/** The nodes the official Turbo chain needs besides the Qwen-Image 2.1 lane's
 *  own. Without one of them the run falls back to a KSampler at the numbers above. */
export const QWEN21_TURBO_NODES = ['RandomNoise', 'KSamplerSelect', 'CFGGuider', 'ManualSigmas', 'SamplerCustomAdvanced'] as const

/** The Mac's picker names (api/mlx-image MLX_MODEL_PREFIX). Spelled out here
 *  rather than imported, so this stays free of the Mac engine module. */
const MLX_PREFIX = 'MLX '

/**
 * True for a Qwen-Image 2.1 Turbo file on ComfyUI: a file of the 2.1 family
 * (classifyModel 'qwenimage') whose own name says "turbo". Comfy-Org ships
 * qwen_image_2.1_turbo_int8_convrot and qwen_image_2.1_turbo_bf16, the
 * community repacks carry the word as well (Qwen-Image-2.1-Turbo-...).
 *
 * By name only, on purpose. The headers of the official 2.1 and Turbo files
 * carry the same weights and a __metadata__ of just {"format": "pt"}; Turbo
 * adds `transformer_blocks.N.attn.comfy_attention.config` tensors in 31 of
 * its blocks. Those are an attention setting of the ComfyUI repack, not a
 * mark of the distillation, so another repack of Turbo need not carry them
 * and a repack of the full model might. The header is also read in Rust
 * (commands/model_sniff.rs) only for the family, and the workflow builder
 * gets the file name alone, so the signal would cost a new field through
 * three layers for a guess. Qwen-Image 1 (2512 Lightning and the like) is
 * another family and never matches; the folder a file sits in does not count.
 */
export function isQwenImage21Turbo(model: string | null | undefined): boolean {
  if (!model || typeof model !== 'string' || model.startsWith(MLX_PREFIX)) return false
  if (classifyModel(model) !== 'qwenimage') return false
  const base = model.replace(/^.*[\\/]/, '')
  return /turbo/i.test(base)
}
