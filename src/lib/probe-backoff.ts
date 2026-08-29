/**
 * How long to wait before knocking on a local backend again.
 *
 * WHAT WENT WRONG (counter-check round 2, installed Windows build,
 * 2026-08-29). With Ollama not installed at all, the app kept asking
 * `http://localhost:11434/api/ps` every 1.5 seconds and wrote two console
 * lines per attempt:
 *
 *   [localFetch] Proxy failed, trying direct fetch  err: proxy_localhost: ...
 *   Failed to load resource: net::ERR_CONNECTION_REFUSED
 *
 * Over forty hits inside a single chat round. Harmless to the product, ruinous
 * to fault-finding: the real errors drown in it.
 *
 * A backend that answers is worth polling briskly, because the loaded/unloaded
 * toggle has to self-correct within a beat (David 2026-06-12: "on und offload
 * button sehr delayed"). A backend that is not there is worth asking about
 * less and less often, up to a minute, because the answer only changes when
 * somebody starts it and one minute is a fine time to notice that.
 */

export const PROBE_BASE_MS = 1500
export const PROBE_MAX_MS = 60_000

/**
 * Delay before the next probe. Zero consecutive failures means the backend is
 * answering, so the brisk base interval stands. Each failure doubles it, and
 * the ladder stops at one minute:
 *
 *   0 -> 1.5s   1 -> 3s   2 -> 6s   3 -> 12s   4 -> 24s   5 -> 48s   6+ -> 60s
 */
export function nextProbeDelayMs(
  consecutiveFailures: number,
  base: number = PROBE_BASE_MS,
  cap: number = PROBE_MAX_MS,
): number {
  const fails = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0
    ? Math.floor(consecutiveFailures)
    : 0
  if (fails === 0) return base
  // Cap the exponent before it is used, so a long-running app cannot compute
  // 2 ** 400 and hand back Infinity.
  const steps = Math.min(fails, 20)
  return Math.min(cap, base * 2 ** steps)
}

/**
 * Should this repeated failure be written to the console.
 *
 * The backoff alone already thins the noise out, but the first failures still
 * arrive at the base interval and a second poller can double them. This keeps
 * one line per key per window and swallows the rest, so a genuinely new error
 * from somewhere else stays visible.
 *
 * The clock is passed in, never read here, so the rule is testable without a
 * fake timer.
 */
export function shouldLogRepeat(
  seen: Map<string, number>,
  key: string,
  now: number,
  windowMs = 60_000,
): boolean {
  const last = seen.get(key)
  if (last !== undefined && now - last < windowMs) return false
  seen.set(key, now)
  return true
}
