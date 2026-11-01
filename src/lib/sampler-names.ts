// C24 (Discord xlollobx, 2026-10-31): Create listed ComfyUI's raw sampler and
// scheduler names (dpmpp_sde, euler_ancestral, karras). Tips from the community
// say "DPM++ SDE" or "Euler a", the names A1111 and Forge show, and users could
// not find them in the list. The list now shows that name with the raw one
// beside it. What is stored and sent to ComfyUI stays the raw name.
import type { SelectOption } from '../components/create/ui/Select'

const SAMPLER_LABELS: Record<string, string> = {
  euler: 'Euler',
  euler_ancestral: 'Euler a',
  heun: 'Heun',
  heunpp2: 'Heun++ 2',
  dpm_2: 'DPM2',
  dpm_2_ancestral: 'DPM2 a',
  lms: 'LMS',
  dpm_fast: 'DPM fast',
  dpm_adaptive: 'DPM adaptive',
  dpmpp_2s_ancestral: 'DPM++ 2S a',
  dpmpp_sde: 'DPM++ SDE',
  dpmpp_2m: 'DPM++ 2M',
  dpmpp_2m_sde: 'DPM++ 2M SDE',
  dpmpp_2m_sde_heun: 'DPM++ 2M SDE Heun',
  dpmpp_3m_sde: 'DPM++ 3M SDE',
  ddpm: 'DDPM',
  lcm: 'LCM',
  ipndm: 'iPNDM',
  ipndm_v: 'iPNDM v',
  deis: 'DEIS',
  res_multistep: 'Res Multistep',
  res_multistep_ancestral: 'Res Multistep a',
  gradient_estimation: 'Gradient Estimation',
  er_sde: 'ER-SDE',
  seeds_2: 'SEEDS 2',
  seeds_3: 'SEEDS 3',
  sa_solver: 'SA-Solver',
  sa_solver_pece: 'SA-Solver PECE',
  ddim: 'DDIM',
  uni_pc: 'UniPC',
  uni_pc_bh2: 'UniPC BH2',
}

/** ComfyUI's variants of a sampler: the same name with a suffix. */
const SAMPLER_SUFFIXES: [string, string][] = [
  ['_cfg_pp', ' CFG++'],
  ['_gpu', ' GPU'],
]

const SCHEDULER_LABELS: Record<string, string> = {
  normal: 'Normal',
  karras: 'Karras',
  exponential: 'Exponential',
  sgm_uniform: 'SGM Uniform',
  simple: 'Simple',
  ddim_uniform: 'DDIM Uniform',
  beta: 'Beta',
  linear_quadratic: 'Linear Quadratic',
  kl_optimal: 'KL Optimal',
  align_your_steps: 'Align Your Steps',
}

/** The name the community uses for a ComfyUI sampler; an unknown one stays raw. */
export function samplerLabel(raw: string): string {
  if (SAMPLER_LABELS[raw]) return SAMPLER_LABELS[raw]
  for (const [suffix, label] of SAMPLER_SUFFIXES) {
    if (raw.endsWith(suffix)) {
      const base = samplerLabel(raw.slice(0, -suffix.length))
      if (base !== raw.slice(0, -suffix.length)) return base + label
    }
  }
  return raw
}

/** The name the community uses for a ComfyUI scheduler; an unknown one stays raw. */
export function schedulerLabel(raw: string): string {
  return SCHEDULER_LABELS[raw] ?? raw
}

function options(list: string[], label: (raw: string) => string): SelectOption[] {
  return list.map((raw) => {
    const shown = label(raw)
    // The raw name stays in sight, small beside the row and as the tooltip,
    // and the search finds it there too.
    return shown === raw ? { value: raw, label: raw } : { value: raw, label: shown, sublabel: raw, title: raw }
  })
}

export const samplerOptions = (list: string[]) => options(list, samplerLabel)
export const schedulerOptions = (list: string[]) => options(list, schedulerLabel)

/** One line for a plain <select> of an imported workflow ("Workflow parameters"):
 *  the readable name with the raw one after it, by the ComfyUI input it sets.
 *  Other inputs and unknown names stay as they are. */
export function workflowOptionText(inputKey: string, raw: string): string {
  const shown = inputKey === 'sampler_name' ? samplerLabel(raw) : inputKey === 'scheduler' ? schedulerLabel(raw) : raw
  return shown === raw ? raw : `${shown} · ${raw}`
}
