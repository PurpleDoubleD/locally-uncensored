/**
 * The line that explains a long load phase in the Create tab's waiting area.
 *
 * R14 Nebenbefund 3 (2026-08-30, ergebnis-r14-nachmessung.md): straight after a
 * ComfyUI restart, a healthy GPU render sat in `Loading model...` from 0 s to
 * 57 s and needed about 117 s in total. R13 measured 0 s to 7 s for the same
 * phase on a warm ComfyUI. Nothing was broken, the checkpoint was simply being
 * read from disk for the first time, and the waiting area said nothing about
 * it. Two minutes of silence on a working card reads as a hang.
 *
 * No new channel was needed. ComfyUI's own WS `executing` events already tell
 * the load phase from the sampling phase (createStore's `loading-model`,
 * `loading-clip` and `loading-vae` against `sampling`), and useCreate has
 * mapped them since long before this round.
 *
 * Honesty rules this file:
 *
 *   - The line appears only AFTER the load has run long enough to be worth
 *     explaining. A warm load finishes inside the R13 range and never shows a
 *     word, so the notice cannot become background noise.
 *   - It never claims to know that THIS is the first job after a start. LU has
 *     no such counter here. It names the cold start as the usual reason for a
 *     long load, which is what the user needs, and says what happens next.
 */

/**
 * How long the load phase may run before it gets explained.
 *
 * R13 measured 0 s to 7 s for a warm load, so 12 s is clear of a healthy warm
 * start and far below the 57 s that raised the finding.
 */
export const COLD_LOAD_HINT_AFTER_MS = 12_000

/**
 * The line itself. Said once, so the component cannot drift from the test.
 *
 * R16 Befund 2 (2026-08-30, Windows box, 12 GB GPU / 16 GB RAM, z_image_bf16 at
 * 11.46 GB): the second sentence this line used to carry, "The first render
 * after a ComfyUI start waits the longest", is false on that machine. ComfyUI
 * unloads the model after EVERY render there (RAM 7.68 GB back down to 672 MB),
 * so all five runs spent 69 s to 75 s in the load before the first sampling
 * step. No first render, no longest wait, just the same load every time.
 *
 * A line that is only shown during a load may only claim what is true whenever
 * it is shown. Which run this is, and how it compares to the next one, is not
 * something this view can know, so it no longer says it.
 */
export const COLD_LOAD_HINT = 'Loading the model into memory...'

/**
 * The notice for a waiting area, or '' when there is nothing to say.
 *
 * `loading` is true only in the model, text encoder and VAE load phases;
 * `elapsedMs` is how long that stretch has been running.
 */
export function coldLoadHint(
  loading: boolean,
  elapsedMs: number,
  afterMs: number = COLD_LOAD_HINT_AFTER_MS,
): string {
  if (!loading) return ''
  if (!Number.isFinite(elapsedMs) || elapsedMs < afterMs) return ''
  return COLD_LOAD_HINT
}
