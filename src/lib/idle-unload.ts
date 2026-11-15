// GH #235: one setting unloads a chat model nobody uses, on every local
// backend. The LU Engine's watch lives in Rust (engine-idle-unload.ts); Ollama
// and LM Studio each have a timer of their own, and LU hands them the minutes:
// Ollama as `keep_alive` on every request, LM Studio as `--ttl` when LU loads a
// model and as `ttl` on every request (a model LM Studio loaded by itself).
import { useSettingsStore } from '../stores/settingsStore'

/** The stored minutes, 0 for never (same reading as engine-idle-unload.ts). */
export function idleMinutesSetting(): number {
  const v = useSettingsStore.getState().settings.engineIdleUnloadMinutes
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0
}

/** Ollama's `keep_alive` for a request. With no time set, the value the call
 *  always sent (LU keeps a model warm 30 minutes for a long agent step). */
export function ollamaKeepAlive(usual: string): string {
  const minutes = idleMinutesSetting()
  return minutes > 0 ? `${minutes}m` : usual
}

/** LM Studio's idle time in seconds, undefined when none is set (LM Studio
 *  then keeps the model as it always did). */
export function lmStudioTtlSeconds(): number | undefined {
  const minutes = idleMinutesSetting()
  return minutes > 0 ? minutes * 60 : undefined
}

/** The `ttlSeconds` argument of `lmstudio_load_model`, or nothing. */
export function lmsTtlArg(): { ttlSeconds?: number } {
  const ttl = lmStudioTtlSeconds()
  return ttl ? { ttlSeconds: ttl } : {}
}
