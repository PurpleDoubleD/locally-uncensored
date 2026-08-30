/**
 * The sentence the Create tab shows while ComfyUI is rendering on the processor.
 *
 * Nebenbefund 1 of the R12/R13 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r1213-nachmessung.md):
 *
 *   "Der Klammergrund im CPU-Band ist bei Force CPU falsch. (no usable GPU
 *    detected) bei erkannter und funktionierender RTX 3060."
 *
 * The banner had exactly one text for two very different situations. On that
 * box the user had picked `Force CPU` himself in Settings, Hardware, ComfyUI
 * GPU, the app had listed his RTX 3060 correctly two panels away, and the
 * banner still told him no usable GPU had been found and then walked him
 * through three sentences of AMD advice on a machine with no AMD card in it.
 *
 * The state is distinguishable, so it gets distinguished. `get_comfy_gpu_status`
 * already returns all three facts (`mode`, `startedCpu`, `hasAmd`); only the
 * frontend was throwing two of them away.
 *
 *   1. `mode === 'cpu'`  the user chose this. Say so, and say where to undo it.
 *   2. no AMD card       the old sentence, which is true here: nothing usable
 *                        was found.
 *   3. an AMD card       the same sentence plus the AMD route, which is the
 *                        one case where those three sentences help.
 *
 * Pure and stringly on purpose: the Create tab is a .tsx the node-environment
 * test runner does not render, so the copy lives where it can be asserted.
 */

/** The user's ComfyUI device override, as `get_comfy_gpu_status` reports it. */
export type ComfyGpuModeName = 'auto' | 'cpu' | 'gpu'

/** What LU knows about the ComfyUI it started this session. */
export interface ComfyCpuBannerFacts {
  /** LU itself started ComfyUI with `--cpu` this session. */
  startedCpu: boolean
  /** Settings, Hardware, ComfyUI GPU. `cpu` is the Force CPU entry. */
  mode: ComfyGpuModeName
  /** An AMD card is present on this machine (same probe the installers use). */
  hasAmd: boolean
  /** Host is Linux. The AMD answer differs per OS and always has. */
  isLinux: boolean
}

/** Normalise whatever the backend handed us into the three known modes. */
export function asComfyGpuMode(value: unknown): ComfyGpuModeName {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'cpu' || s === 'gpu' ? s : 'auto'
}

/**
 * The AMD half of the banner. Windows and Linux take different routes, which
 * is the finding three users hit in round 12 (numbrain/lapbo/suraj3014): the
 * generic ZLUDA pointer is a Windows-only dead end on Linux, and the Windows
 * half used to claim there was no Windows ROCm wheel at all, which AMD's own
 * index disproves.
 *
 * It is a separate export because it is now CONDITIONAL: a machine with no AMD
 * card never reads it. That was the second half of the R12/R13 finding.
 */
export function amdCpuAdvice(isLinux: boolean): string {
  return isLinux
    ? ' AMD GPU? LU installs the ROCm build of PyTorch for AMD cards now. Reinstall the ComfyUI environment from Settings → ComfyUI, then set Settings → Hardware → ComfyUI GPU to Auto.'
    : " AMD GPU? LU installs AMD's own ROCm build of PyTorch for RX 7000 and RX 9000 cards on Windows. Reinstall the ComfyUI environment from Settings → ComfyUI to try that again. For any other AMD card you need a ZLUDA ComfyUI of your own: point LU at it and set Settings → Hardware → ComfyUI GPU to force GPU."
}

/** The slowness warning both honest variants share, word for word. */
const SLOW = 'Generation will be extremely slow and may time out.'

/**
 * Why the processor is in play when the user asked for it.
 *
 * Exported because the Create tab's banner is not the only surface that had the
 * wrong reason in it: the render failure notices in lib/render-budget.ts said
 * "because no supported GPU path is active" for the same press. One wording,
 * one place, so the two cannot drift apart.
 */
export const FORCE_CPU_REASON = 'you selected Force CPU'

/** ... and the way back out of it, likewise said once. */
export const FORCE_CPU_WAY_BACK =
  'Set Settings → Hardware → ComfyUI GPU back to Auto and restart ComfyUI from Settings → AI Backends to use your card again.'

/**
 * The whole banner text, or '' when there is no banner to draw.
 *
 * Empty string is the single "say nothing" answer, so a caller cannot render a
 * yellow bar with no reason in it.
 */
export function comfyCpuBannerText(facts: ComfyCpuBannerFacts | null | undefined): string {
  if (!facts?.startedCpu) return ''

  // 1. The user asked for this. Nothing was detected wrongly, nothing is
  //    broken, and the AMD route is beside the point: the way out is the
  //    switch he set himself, so that is the only thing worth naming.
  if (facts.mode === 'cpu') {
    return `ComfyUI is running on the CPU because ${FORCE_CPU_REASON}. ${SLOW} ${FORCE_CPU_WAY_BACK}`
  }

  // 2. and 3. LU fell back to the processor on its own, so the old sentence is
  //    the true one. The AMD paragraph rides along only where there is an AMD
  //    card to talk about.
  const head = `ComfyUI is running on the CPU (no usable GPU detected). ${SLOW}`
  return facts.hasAmd ? head + amdCpuAdvice(facts.isLinux) : head
}
