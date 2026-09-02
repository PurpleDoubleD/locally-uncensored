/**
 * Is a failed engine start worth trying again.
 *
 * Review S3 on the GH #118 fix: the boot resume repeats a start up to three
 * times, and a repeat is only ever right for a start that DIED. The other
 * failures cost far more than they can win. A health-budget timeout means the
 * engine is still loading, and the budget scales with the GGUF, so a repeat
 * spends up to ten minutes a second and a third time, and each attempt also
 * drops ComfyUI's VRAM cache and evicts Ollama's loaded models on the way in.
 * A missing binary, a missing model file and a completely blocked block of
 * ports are all facts about the machine that 1.5 seconds do not change.
 *
 * Tauri hands a command failure across as a plain string, so this reads the
 * message. The Rust side keeps its half of the contract in a test
 * (`a_slow_load_stays_recognisable_as_a_timeout_for_the_frontend`): the
 * timeout message always carries "did not become healthy", and no death
 * message ever does.
 */

/** Failures that no amount of waiting repairs. Lower-cased fragments. */
const HOPELESS = [
  // the engine is alive and still loading, the budget simply ran out
  'did not become healthy',
  // the walk over every candidate port came back empty
  'could not open a local port',
  // the sidecar is not in this installation
  'is missing from this installation',
  // the GGUF the caller named is gone
  'model file not found',
  'has no model file named',
]

/** The message behind an unknown thrown value. */
export function engineStartFailureText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err ?? '')
}

/** True when starting again has a chance of a different answer. */
export function engineStartIsWorthRetrying(err: unknown): boolean {
  const msg = engineStartFailureText(err).toLowerCase()
  if (!msg) return true // no message at all is not evidence of hopelessness
  return !HOPELESS.some((m) => msg.includes(m))
}
