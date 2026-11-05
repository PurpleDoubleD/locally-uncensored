/**
 * A render the Create watchdog gave up on can still finish. I1 on the 12 GB
 * box (30.10.2026): a second Z-Image bf16 run took 22 min, its VAE decode
 * went through shared memory and ComfyUI left HTTP unanswered all that time;
 * LU called it stalled at 20 min and the four finished pictures never
 * reached the gallery. After a stall verdict LU keeps asking ComfyUI's
 * history for that prompt for a while and hands over what still arrives.
 */

import { log } from '../logger'

/** How long a given-up prompt is still looked for. */
export const LATE_RESULT_WINDOW_MS = 60 * 60_000
/** How often its history is asked for. */
export const LATE_RESULT_EVERY_MS = 30_000

/** The sentence after the stall message: the user knows the run is not lost yet. */
export const LATE_RESULT_PROMISE = 'LU keeps looking for this render for another hour: if ComfyUI still finishes it, it lands in your gallery.'

interface HistoryLike {
  status?: { status_str?: string; completed?: boolean }
}

export interface LateResultOptions<H extends HistoryLike> {
  getHistory: (promptId: string) => Promise<H | null>
  /** The finished history entry: the caller adds its outputs. */
  onSuccess: (history: H) => void
  windowMs?: number
  everyMs?: number
}

const watching = new Map<string, () => void>()

/** Watch one prompt's history until it succeeds, fails or the window ends.
 *  Returns the stop. Asking twice for the same prompt keeps one watcher. */
export function collectLateResult<H extends HistoryLike>(promptId: string, opts: LateResultOptions<H>): () => void {
  watching.get(promptId)?.()
  const windowMs = opts.windowMs ?? LATE_RESULT_WINDOW_MS
  const started = Date.now()
  let busy = false
  const stop = () => {
    clearInterval(timer)
    if (watching.get(promptId) === stop) watching.delete(promptId)
  }
  const timer = setInterval(async () => {
    if (busy) return
    if (Date.now() - started > windowMs) {
      stop()
      log.info('render.late_result_none', { promptId })
      return
    }
    busy = true
    try {
      const h = await opts.getHistory(promptId).catch(() => null)
      if (!h) return
      if (h.status?.status_str === 'success' || (h.status?.completed && h.status?.status_str !== 'error')) {
        stop()
        log.info('render.late_result', { promptId, afterMs: Date.now() - started })
        opts.onSuccess(h)
      } else if (h.status?.status_str === 'error') {
        stop()
      }
    } finally {
      busy = false
    }
  }, opts.everyMs ?? LATE_RESULT_EVERY_MS)
  watching.set(promptId, stop)
  return stop
}

/** Is LU still looking for this prompt? */
export function lateResultPending(promptId: string): boolean {
  return watching.has(promptId)
}
