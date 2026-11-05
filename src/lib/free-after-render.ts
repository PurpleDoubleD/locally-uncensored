/**
 * B27 (3.0.9): give the memory back after a render. Discord .molot, 28.10.2026:
 * after a picture or a video, ComfyUI kept its models in graphics memory and
 * in RAM until it was closed.
 *
 * That was on purpose (vram-handoff, "bug C"): the next render reuses the warm
 * model instead of reading 10 to 20 GB again, 70 s on the test box. So the
 * choice is the user's, with a default that keeps both: a run of renders stays
 * warm, a machine left alone gets its memory back.
 *
 *   'idle'  (default) frees five minutes after the last render, unless another
 *           one started in between
 *   'now'   frees right after the render; a short grace keeps a chain (a long
 *           clip in sections, the character image then its video) from
 *           reloading between its steps
 *   'keep'  never frees, the behaviour before 3.0.9
 *
 * What is freed is ComfyUI's: `/free` with unload_models and free_memory
 * unloads every model from the card and drops ComfyUI's node cache, which is
 * what holds the weights in RAM (ComfyUI main.py, prompt_worker). The chat
 * models are not touched here: the hand-off already gives them back after a
 * render, and Ollama's own keep_alive unloads them when nobody chats.
 */

import { freeMemory } from '../api/comfyui'
import { log } from './logger'

export type FreeAfterRender = 'idle' | 'now' | 'keep'

export const FREE_AFTER_RENDER_DEFAULT: FreeAfterRender = 'idle'
/** 'idle': how long nothing has to render before the memory goes back. */
export const FREE_AFTER_IDLE_MS = 5 * 60_000
/** 'now': the grace that lets the next step of a chain start warm. */
export const FREE_AFTER_NOW_GRACE_MS = 15_000

/** The setting as stored, with the default for a profile that never had it. */
export function freeAfterRenderMode(value: unknown): FreeAfterRender {
  return value === 'now' || value === 'keep' || value === 'idle' ? value : FREE_AFTER_RENDER_DEFAULT
}

/** How long after a render the memory goes back, or null for never. */
export function freeAfterDelayMs(mode: FreeAfterRender): number | null {
  if (mode === 'keep') return null
  return mode === 'now' ? FREE_AFTER_NOW_GRACE_MS : FREE_AFTER_IDLE_MS
}

let pending: ReturnType<typeof setTimeout> | null = null

/** A render starts: whatever was planned to be freed stays, it is about to be used. */
export function cancelFreeAfterRender(): void {
  if (pending) clearTimeout(pending)
  pending = null
}

/**
 * A ComfyUI render ended (done, failed or cancelled). Plans the free for the
 * mode. `busy` is asked again when the time comes: a render that started in
 * between without passing cancelFreeAfterRender (another surface) keeps its
 * models. Never throws.
 */
export function scheduleFreeAfterRender(mode: FreeAfterRender, busy: () => boolean, free: () => Promise<void> = freeMemory): void {
  cancelFreeAfterRender()
  const delay = freeAfterDelayMs(mode)
  if (delay === null) return
  pending = setTimeout(() => {
    pending = null
    if (busy()) return
    log.info('render.free_after', { mode })
    void free().catch(() => { /* best effort */ })
  }, delay)
}

/** Tests: is a free planned? */
export function freeAfterRenderPending(): boolean {
  return pending !== null
}
