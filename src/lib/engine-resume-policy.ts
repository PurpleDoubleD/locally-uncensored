/**
 * How often, and how patiently, the app may try to bring the built-in engine
 * back up on its own after a start failed.
 *
 * GH #118: the boot resume was one shot and swallowed its failure without a
 * word, so an engine that lost a race at login (antivirus scanning a fresh
 * install, graphics driver still settling) stayed dead until the user re-picked
 * the model by hand. The other direction is just as bad: a model this box
 * genuinely cannot load must not turn into an endless restart loop that keeps
 * the machine busy forever. So the policy is bounded and lives in one place.
 */

/** Total start attempts, the first one included. */
export const RESUME_ATTEMPTS = 3

/** How long to wait after attempt 1, and after attempt 2. */
export const RESUME_BACKOFF_MS = [1500, 5000]

/**
 * Milliseconds to wait before the attempt that follows `attempt` (0-based), or
 * null when the budget is spent and the app has to stop trying.
 */
export function resumeBackoffMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null
  if (attempt >= RESUME_ATTEMPTS - 1) return null
  return RESUME_BACKOFF_MS[attempt] ?? RESUME_BACKOFF_MS[RESUME_BACKOFF_MS.length - 1]
}
