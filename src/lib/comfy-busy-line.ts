/**
 * What the progress line says while ComfyUI does not answer (Discord
 * bug-reports 21.11.2026, Qwen Edit at 2730x1536). A model load or a VAE decode
 * can hold its HTTP server for minutes, so no answer does not end the run. It
 * must not read as a hang either: after a few minutes the line names the way
 * out, and Cancel returns even if ComfyUI never answers it.
 */
export const COMFY_BUSY_LONG_MS = 3 * 60_000

/** How long Cancel waits for ComfyUI before the app is free again. */
export const CANCEL_ANSWER_LIMIT_MS = 5_000

export function comfyBusyLabel(silentMs: number): string {
  if (silentMs < COMFY_BUSY_LONG_MS) return 'ComfyUI is busy and does not answer yet...'
  const minutes = Math.floor(silentMs / 60_000)
  return `ComfyUI has not answered for ${minutes} min. If it stays like this, cancel and try a smaller size.`
}

/** Waits for `work`, but never longer than `limitMs`. A failure counts as done. */
export function settleWithin(work: Promise<unknown>, limitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, limitMs)
    const done = () => { clearTimeout(timer); resolve() }
    work.then(done, done)
  })
}
