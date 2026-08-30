/**
 * Does the ComfyUI we are about to render on hold any VRAM at all?
 *
 * Nebenbefund 1 of the R14 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r14-nachmessung.md): every image generation evicts the
 * chat engine before the render and reloads it after. That trade is the whole
 * point of the VRAM hand-off when ComfyUI is about to claim the card. It is
 * pure loss when ComfyUI was started with `--cpu`, because then ComfyUI never
 * touches the card and the user pays a full cold reload of his chat model for
 * every single picture.
 *
 * Measured on the box, Force CPU run: engine PID 4420 was alive before the
 * generation and PID 16896 after it, started at 20:19:32, the moment the CPU
 * render ended. Nothing was gained by the eviction, since the ComfyUI command
 * line was `main.py ... --cpu`.
 *
 * The one fact that carries this decision is `startedCpu` from
 * `get_comfy_gpu_status`: LU started THIS ComfyUI with `--cpu` itself, so it
 * knows, rather than guesses, that no VRAM is in play. `mode` is deliberately
 * NOT part of the condition, see below.
 */
import type { ComfyGpuModeName } from './comfy-cpu-banner'

/** The two facts `get_comfy_gpu_status` reports about the running ComfyUI. */
export interface ComfyDeviceFacts {
  /** LU itself started ComfyUI with `--cpu` this session. */
  startedCpu: boolean
  /** Settings, Hardware, ComfyUI GPU. `cpu` is the Force CPU entry. */
  mode: ComfyGpuModeName
}

/**
 * True when this ComfyUI provably holds no VRAM, so freeing VRAM for it is
 * pointless work.
 *
 * Only a `--cpu` start LU performed itself counts. Two cases are deliberately
 * left out, both of which would break the hand-off if they were let in:
 *
 *   - `mode === 'cpu'` on its own. A user who picks Force CPU and does NOT
 *     restart ComfyUI still has a ComfyUI on the card. Skipping the hand-off
 *     there brings back the OOM the mechanism exists to prevent.
 *   - a ComfyUI LU did not start (someone else's server on port 8188). LU
 *     cannot know what that one was started with, so it stays on the safe
 *     side and keeps handing VRAM over.
 *
 * `startedCpu` with `mode === 'auto'` DOES count: that is the automatic CPU
 * fallback on a machine with no usable GPU path, and it holds no VRAM either.
 */
export function comfyHoldsNoVram(facts: ComfyDeviceFacts | null | undefined): boolean {
  return facts?.startedCpu === true
}
