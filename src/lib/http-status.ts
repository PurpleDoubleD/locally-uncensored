import { isCloudFinalCode } from './cloud-final-codes'
import { isCloudAgentStopCode } from './agent-core/cloud-agent-stop'
import { FIRST_REPLY_TIMEOUT } from './chat-reply-timeout'
// The HTTP status of a failed model call, whichever field happens to carry it.
//
// ProviderError (api/providers/types.ts) stores it as `status`; the Ollama
// streaming path (lib/ollama-stream-tools.ts) tags its plain Error with
// `statusCode`. A guard that reads only one of the two is dead on the other
// transport, and both are on the hot path of every run.
//
// That is exactly what happened (Morgan, 2026-08-10): the agent's rule "never
// retry a deterministic 4xx" read `statusCode`, so on the cloud path an
// out-of-credits refusal was retried twice with backoff before anything was
// shown, and a dying run looked like work for another 4.5 seconds.

export function httpStatusOf(err: unknown): number {
  if (!err || typeof err !== 'object') return 0
  const e = err as { status?: unknown; statusCode?: unknown }
  const raw = typeof e.status === 'number' ? e.status : e.statusCode
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/**
 * Is retrying this failure pointless? True for a deterministic client error:
 * the same request will be refused the same way, so the run must stop and say
 * so instead of burning seconds on backoff.
 *
 * "Deterministic" is about the request, not about the status number, and three
 * 4xx codes are not:
 *
 * 429 is the one that makes this worth a function. LU Cloud answers it for
 * three different things: the per-user burst guard, an upstream provider
 * throttle (both genuinely transient, both send retry-after), and an empty
 * wallet, which no amount of waiting fixes. Only the last one is terminal, and
 * it is the only one that carries `code: 'credits_exhausted'`.
 *
 * 408 is a request timeout, which is the definition of worth another try.
 *
 * 401 depends on WHOSE credential it is. For a provider the user configured
 * with an API key, a refusal is final until they fix the key. LU Cloud does
 * not work that way: its bearer is a Supabase access token that lives about an
 * hour and is re-minted per call by LuCloudProvider.delegate(), so a 401 in
 * the middle of a long agent run usually means nothing worse than "that token
 * just aged out". The retry calls delegate() again, getSession() hands back a
 * fresh token, and the user never learns it happened. Treating it as terminal
 * ended the run at the first refusal with "unauthenticated", or worse with
 * "Invalid API key, check Settings > Providers" for a provider that has no API
 * key field. api/cloud/jobs.ts states the same policy for the same cloud, with
 * the same reason: a failed lazy refresh must not tell a signed-in user to
 * sign in. When the session really is gone, getAccessToken() returns nothing
 * and the provider throws `signed_out`, which IS terminal, so the dead end
 * costs one backoff and then says the true thing.
 */
/** Longest server-directed wait worth sitting through inside one run. */
export const MAX_RETRY_AFTER_MS = 60_000

/**
 * The wait a throttling server asked for, in milliseconds, or undefined.
 *
 * `retry-after` comes in two shapes (RFC 9110): whole seconds, which is what
 * LU Cloud sends, or an HTTP date. Both are read here so a provider that picks
 * the other one still gets honoured. Anything unparseable or negative is
 * treated as absent rather than as zero, so a broken header falls back to the
 * caller's own backoff instead of hammering the server immediately.
 */
export function parseRetryAfter(res: { headers: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  const ms = at - Date.now()
  return ms > 0 ? ms : 0
}

/**
 * How long to wait before attempt number `attempt` (1-based).
 *
 * The server's own number wins whenever it sent one, and this is the whole
 * point: LU Cloud's burst guard is a FIXED window (60 requests per 60 s), so
 * `retry-after` can be anything up to a full minute, while the caller's ladder
 * waited 1.5 s and then 3 s. Both retries therefore landed inside the very
 * same window that had just refused them, and a throttled run died after 4.5 s
 * with "too many requests" and no instruction. The 429 carve-out in
 * isTerminalModelError only pays off if the wait is long enough to outlast the
 * window it is waiting for.
 *
 * Capped at MAX_RETRY_AFTER_MS: a minute of silence is already a lot to ask,
 * and beyond that the honest answer is to stop and tell the user when to come
 * back rather than freeze the run.
 */
export function retryDelayMs(err: unknown, attempt: number): number {
  const asked = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs
  if (typeof asked === 'number' && Number.isFinite(asked) && asked >= 0) {
    // A server that says "0" means now; keep a beat so the retry is not a
    // tight loop against a limiter that rounds down.
    return Math.min(Math.max(asked, 250), MAX_RETRY_AFTER_MS)
  }
  return 1500 * attempt
}

export function isTerminalModelError(err: unknown): boolean {
  const e = err as { code?: unknown; provider?: unknown } | null
  // R5-53: `flash_timeout` is a 504, so without this line it fell through to
  // "status >= 400 && status < 500" (false) and read as a plain gateway
  // hiccup worth retrying. The free-tier request had already sat out its own
  // four-minute hard deadline (see the server's route), so each of the three
  // attempts in the connRetries ladder repeated the same four-minute wait,
  // twelve silent minutes before the run gave up, same shape as the
  // `credits_exhausted` bug this line is modelled on.
  if (e?.code === 'credits_exhausted' || e?.code === 'signed_out' || e?.code === 'flash_timeout') return true
  // LU Cloud ended a step that produced no visible output for ten minutes
  // (a model run away inside a tool call). Sending it again runs the same
  // ten minutes again, twice, on the customer's credits.
  if (e?.code === 'stalled_runaway') return true
  // Images or request too large, a schema the model will not follow: the
  // same request fails the same way (lib/cloud-final-codes).
  if (isCloudFinalCode(e?.code)) return true
  // LU Cloud ended the agent run (409, agent-core/cloud-agent-stop.ts): a
  // retry meets the same stop.
  if (isCloudAgentStopCode(e?.code)) return true
  // LU Cloud has an outage the server announced (lib/cloud-outage.ts). A
  // retry lands in the same outage and only delays the sentence that says so.
  if (e?.code === 'outage') return true
  // Issue 177: the first reply window the user set ran out. Another attempt
  // waits the whole window again.
  if (e?.code === FIRST_REPLY_TIMEOUT) return true
  const status = httpStatusOf(err)
  if (status === 429 || status === 408) return false
  if (status === 401 && e?.provider === 'lu-cloud') return false
  return status >= 400 && status < 500
}
