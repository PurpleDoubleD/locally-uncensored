import type { ModelType } from '../../../api/comfyui'

/** Model-type label on a row of the local model picker. A plain tag in the
 *  pickers' own style (index.css, .lu-picker-tag): the type is a word, not a
 *  colour. The table used to give every family a tone of its own, 18 tones
 *  in one list. */
export const TYPE_LABEL: Record<ModelType, string> = {
  flux: 'FLUX',
  flux2: 'FLUX 2',
  krea2: 'Krea 2',
  zimage: 'Z-Image',
  ernie_image: 'Ernie',
  qwenimage: 'Qwen Image 2.1',
  qwenimage1: 'Qwen Image',
  chroma: 'Chroma',
  hidream: 'HiDream',
  sd3: 'SD 3.5',
  lumina2: 'Lumina 2',
  sdxl: 'SDXL',
  sd15: 'SD 1.5',
  wan: 'Wan',
  wan22: 'Wan 2.2',
  hunyuan: 'Hunyuan',
  ltx: 'LTX',
  ltx25: 'LTX 2.5',
  minimaxh3: 'MiniMax H3',
  minimaxh3image: 'MiniMax H3 Image',
  mochi: 'Mochi',
  cosmos: 'Cosmos',
  cogvideo: 'CogVideo',
  svd: 'SVD',
  framepack: 'FramePack',
  pyramidflow: 'PyramidFlow',
  allegro: 'Allegro',
  ace: 'ACE Step',
  yue2: 'YuE2',
  wans2v: 'Wan S2V',
  wananimate: 'Wan Animate',
  wanvace: 'VACE',
  animatediff: 'AnimateDiff',
  unknown: 'Model',
}

/** Fallback sampler/scheduler lists, used until ComfyUI's /object_info lists
 *  arrive via useCreate (threaded through CreateContext). Standard ComfyUI names. */
export const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'heun', 'dpm_2', 'lms', 'ddim', 'uni_pc']
export const SCHEDULERS = ['normal', 'karras', 'simple', 'sgm_uniform', 'exponential', 'beta', 'ddim_uniform']
