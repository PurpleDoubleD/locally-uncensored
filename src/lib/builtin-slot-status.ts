/**
 * What the AI Backends list may say about the app's own built-in engine
 * BEFORE anyone has probed it.
 *
 * GH #118 leftover, found by the counter-check on the real 2.6.7 build
 * (2026-08-29): Settings, AI Backends showed the Built-in Engine as "Failed"
 * straight after app start, with no model loaded. A click on Test then put
 * `GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED` in the
 * console and flipped the same row to "Connected". The engine was healthy the
 * whole time. The display was wrong twice: it called an engine that had never
 * been started a failure, and it produced a red console line to find that out.
 *
 * A server the app has not started yet is not a failed server. The app owns
 * that process and can ask the Rust side whether it runs, which costs no
 * socket and cannot be refused by a port nobody is listening on. Only when
 * that answer is ambiguous is a real probe worth making.
 */

export type SlotStatus = 'idle' | 'connected' | 'failed' | 'stopped'

/** The engine status the Rust `bundled_engine_status` command returns. */
export interface EngineHealth {
  running?: boolean
  healthy?: boolean
}

/**
 * The status the built-in slot may claim from the engine answer alone.
 *
 *  - healthy            -> 'connected', it is answering right now
 *  - not running        -> 'stopped', nothing to fail yet
 *  - running, unhealthy -> null, the process is up and the port may still be
 *                          binding, so this one IS worth a real probe
 *  - no answer at all   -> null, we know nothing, fall back to the probe
 *
 * Never returns 'failed': a verdict of failure has to come from a probe that
 * actually ran.
 */
export function builtinSlotStatus(engine: EngineHealth | null | undefined): SlotStatus | null {
  if (!engine) return null
  if (engine.healthy) return 'connected'
  if (engine.running) return null
  return 'stopped'
}
