/**
 * C81 (3.1.0): the LU Engine died on its own, and now the app says how.
 *
 * c1rrus (Linux, ROCm) had the engine vanish in the middle of an answer, and
 * neither the log nor the window said why. Rust now reads the exit code or
 * signal and the last stderr lines when it reaps the process, and sends one
 * sentence with the `lu-sidecar-gone` event (`message`, chat engine only).
 * This shows that sentence above the chat history, where the other chat
 * notices live (stores/chatNoticeStore.ts).
 */
import { useChatNoticeStore } from '../stores/chatNoticeStore'

/** Long enough to read a two-sentence cause, short enough not to linger. */
export const ENGINE_STOPPED_NOTICE_MS = 60_000

/** Pure: the sentence in a `lu-sidecar-gone` payload, or null. */
export function engineStoppedMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { sidecar?: unknown; message?: unknown }
  if (p.sidecar !== 'engine') return null
  return typeof p.message === 'string' && p.message.trim() ? p.message.trim() : null
}

/** Called for every `lu-sidecar-gone`; shows the sentence when there is one. */
export function noteSidecarGone(payload: unknown): void {
  const message = engineStoppedMessage(payload)
  if (!message) return
  useChatNoticeStore.getState().show('engine-stopped', message, 'fehler', ENGINE_STOPPED_NOTICE_MS)
}
