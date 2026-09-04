import type { ModelType } from '../../../api/comfyui'

/**
 * Model-type badge map, the single source for ModelChip and Badge.
 *
 * Die Farbe hier ist ein Erkennungszeichen fuer eine Modellfamilie, keine
 * Warnung. Trotzdem waren zwei Eintraege gelb (`ernie_image` yellow,
 * `cogvideo` amber), und genau das hat Gelb in der ganzen App unlesbar
 * gemacht: dieselbe Farbe stand mal fuer eine Marke, mal fuer einen Fehler.
 * Beide sind jetzt neutral getoent. Die Begruendung steht in `lib/hinweis.ts`.
 *
 * Warum ausgerechnet slate und stone: jeder BUNTE Ton dieser Tabelle ist
 * vergeben (purple, rose, blue, green, orange, red, cyan, pink, emerald,
 * indigo, teal, violet, lime, fuchsia, sky), und zwei Familien duerfen nicht
 * dieselbe Farbe tragen. Frei waren nur die neutralen Reihen. `unknown`
 * bleibt davon unterscheidbar: es faerbt gar nicht (bg-white/10 + gray).
 *
 * Bewusst doppelt sind nur die Toene EINER Familie: flux/flux2 und die vier
 * Wan-Spuren. Das Paar zimage/allegro traegt beides Rose, seit die Tabelle
 * angelegt wurde; das ist aelter als diese Runde und bleibt hier unberuehrt,
 * damit keine Familie ihr Erkennungszeichen ohne Not wechselt.
 */
export const TYPE_BADGE: Record<ModelType, { label: string; color: string }> = {
  flux: { label: 'FLUX', color: 'bg-purple-500/15 text-purple-300' },
  flux2: { label: 'FLUX 2', color: 'bg-purple-500/15 text-purple-300' },
  zimage: { label: 'Z-Image', color: 'bg-rose-500/15 text-rose-300' },
  ernie_image: { label: 'Ernie', color: 'bg-slate-500/15 text-slate-300' },
  sdxl: { label: 'SDXL', color: 'bg-blue-500/15 text-blue-300' },
  sd15: { label: 'SD 1.5', color: 'bg-green-500/15 text-green-300' },
  wan: { label: 'Wan', color: 'bg-orange-500/15 text-orange-300' },
  wan22: { label: 'Wan 2.2', color: 'bg-orange-500/15 text-orange-300' },
  hunyuan: { label: 'Hunyuan', color: 'bg-red-500/15 text-red-300' },
  ltx: { label: 'LTX', color: 'bg-cyan-500/15 text-cyan-300' },
  mochi: { label: 'Mochi', color: 'bg-pink-500/15 text-pink-300' },
  cosmos: { label: 'Cosmos', color: 'bg-emerald-500/15 text-emerald-300' },
  cogvideo: { label: 'CogVideo', color: 'bg-stone-500/15 text-stone-300' },
  svd: { label: 'SVD', color: 'bg-indigo-500/15 text-indigo-300' },
  framepack: { label: 'FramePack', color: 'bg-teal-500/15 text-teal-300' },
  pyramidflow: { label: 'PyramidFlow', color: 'bg-violet-500/15 text-violet-300' },
  allegro: { label: 'Allegro', color: 'bg-rose-500/15 text-rose-300' },
  // 2.5.8 specialized local lanes
  ace: { label: 'ACE Step', color: 'bg-fuchsia-500/15 text-fuchsia-300' },
  wans2v: { label: 'Wan S2V', color: 'bg-orange-500/15 text-orange-300' },
  wananimate: { label: 'Wan Animate', color: 'bg-orange-500/15 text-orange-300' },
  wanvace: { label: 'VACE', color: 'bg-lime-500/15 text-lime-300' },
  // A motion module, not a main model. It shows up in the Models inventory,
  // never in a Create picker, so this label is only ever read there.
  animatediff: { label: 'AnimateDiff', color: 'bg-sky-500/15 text-sky-300' },
  unknown: { label: 'Model', color: 'bg-white/10 text-gray-400' },
}

/** Fallback sampler/scheduler lists, used until ComfyUI's /object_info lists
 *  arrive via useCreate (threaded through CreateContext). Standard ComfyUI names. */
export const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'heun', 'dpm_2', 'lms', 'ddim', 'uni_pc']
export const SCHEDULERS = ['normal', 'karras', 'simple', 'sgm_uniform', 'exponential', 'beta', 'ddim_uniform']
