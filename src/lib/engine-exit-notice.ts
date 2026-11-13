/**
 * C81 (3.1.0): the LU Engine died on its own, and now the app says how.
 *
 * c1rrus (Linux, ROCm) had the engine vanish in the middle of an answer, and
 * neither the log nor the window said why. Rust now reads the exit code or
 * signal and the last stderr lines when it reaps the process, and sends one
 * sentence with the `lu-sidecar-gone` event (`message`, chat engine only).
 * That sentence goes on the LU Engine line (stores/luEngineSwitchStore.ts),
 * the place every other engine event already uses, as an error: it stays
 * until it was seen and dismissed, not on a clock.
 */
import { isTauri } from '../api/backend'
import { useLuEngineSwitchStore } from '../stores/luEngineSwitchStore'

/** Rust's event when its watch reaped a dead sidecar (commands/engine.rs). */
export const SIDECAR_GONE_EVENT = 'lu-sidecar-gone'

/** Pure: the sentence in a `lu-sidecar-gone` payload, or null. */
export function engineStoppedMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { sidecar?: unknown; message?: unknown }
  if (p.sidecar !== 'engine') return null
  return typeof p.message === 'string' && p.message.trim() ? p.message.trim() : null
}

/** Called for every `lu-sidecar-gone`; announces the sentence when there is one. */
export function noteSidecarGone(payload: unknown): void {
  const message = engineStoppedMessage(payload)
  if (!message) return
  useLuEngineSwitchStore.getState().announce(message, 'error')
}

/** At boot (App.tsx): one listener for the life of the window. */
export function startEngineExitNotices(): void {
  if (!isTauri()) return
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen(SIDECAR_GONE_EVENT, (event) => noteSidecarGone(event.payload)))
    .catch(() => {
      /* a build without events keeps the Settings line (lastExit) */
    })
}
