// Fetch wrapper for the lu-labs.ai cloud APIs: prefixes CLOUD_BASE and
// injects the Supabase bearer token. Direct HTTPS from the WebView (no Tauri
// proxy — the CSP allowlists the cloud hosts, and the server side speaks
// CORS for Tauri origins).

import { CLOUD_BASE } from './config'
import { getAccessToken } from './supabase'
import { parseRetryAfter } from '../../lib/http-status'

export class CloudJobError extends Error {
  readonly status: number
  /** The server's machine-readable reason (`code` next to `error` in the
   *  body), when it sent one. The status alone is ambiguous where it matters
   *  most: LU Cloud answers 429 for the per-user burst guard, for an upstream
   *  provider throttle AND for an empty wallet, and only the last of those is
   *  something the user can act on by paying. */
  readonly code?: string
  /** What `retry-after` asked for, in ms — the burst guard's window is fixed
   *  and up to a minute long, so the number is worth showing. */
  readonly retryAfterMs?: number
  constructor(message: string, status: number, meta?: { code?: string; retryAfterMs?: number }) {
    super(message)
    this.name = 'CloudJobError'
    this.status = status
    this.code = meta?.code
    this.retryAfterMs = meta?.retryAfterMs
  }
}

export async function jsonOrError<T>(res: Response): Promise<T> {
  // Read as text rather than json() so a body that never finished arriving is
  // distinguishable from one that legitimately has nothing in it. A torn read
  // used to fall into the same `{}` as a 204, which handed submitCloudJob an
  // undefined job id and left the run polling a job that never existed.
  let truncated = false
  const raw = await res.text().catch(() => {
    truncated = true
    return ''
  })
  let body: unknown = {}
  let unparseable = false
  if (raw.trim()) {
    try {
      body = JSON.parse(raw)
    } catch {
      unparseable = true
    }
  }
  if (!res.ok) {
    const b = body as { error?: unknown; code?: unknown }
    const msg = typeof b.error === 'string' ? b.error : `request failed (${res.status})`
    throw new CloudJobError(msg, res.status, {
      code: typeof b.code === 'string' ? b.code : undefined,
      retryAfterMs: parseRetryAfter(res),
    })
  }
  if (truncated || unparseable) {
    throw new CloudJobError(`the server's answer arrived incomplete (${res.status})`, res.status)
  }
  return body as T
}

/** Ceiling for one cloud round-trip. Nothing else bounds these: the Create
 *  surface awaits them one after another, and a fetch whose peer disappears
 *  mid-flight never settles on its own — one half-open socket during an
 *  upload or a submit therefore wedged Create until the app was restarted. */
const REQUEST_TIMEOUT_MS = 60_000

/** Uploads have to survive a slow uplink, so their deadline grows with the
 *  body instead of cutting a legitimate 40 MB clip off at the flat ceiling.
 *  ~64 KB/s is far below any connection that could ever finish the upload. */
const UPLOAD_BYTES_PER_MS = 64

/** Size of a request body in bytes, or `null` when this body shape cannot be
 *  measured without consuming it.
 *
 *  Measured: ArrayBuffer, any view over one, Blob/File, string, URLSearchParams
 *  (its serialised form is what goes on the wire) and FormData (the sum of its
 *  parts — the multipart boundaries add a few hundred bytes per field, which
 *  is noise next to a file and does not change the deadline).
 *
 *  NOT measurable: a ReadableStream body has no length until it has been read,
 *  and reading it here would consume the only copy. `null` says so rather than
 *  reporting 0 bytes — FormData, URLSearchParams and a stream all counted as
 *  zero before, so all three quietly got the flat ceiling while this comment
 *  block claimed the deadline grew with the body. */
function bodyBytes(body: RequestInit['body']): number | null {
  if (body == null) return 0
  if (typeof body === 'string') return body.length
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString().length
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    let total = 0
    for (const [name, value] of body) {
      total += name.length
      total += typeof value === 'string' ? value.length : value.size
    }
    return total
  }
  return null // ReadableStream, or something this engine does not know
}

/** The deadline for one request.
 *
 *  A body whose size cannot be known falls back to the flat ceiling, because
 *  there is nothing to derive anything else from — and that is a real limit,
 *  not a rounding: a streamed 40 MB upload would be cut off at 60 s. Nothing
 *  in this app sends a stream body today (uploadInput reads the Blob into an
 *  ArrayBuffer first, everything else is JSON or a Blob), and the day one does
 *  it has to pass `timeoutMs` itself rather than assume this function guessed. */
function deadlineFor(init: RequestInit): number {
  const bytes = bodyBytes(init.body)
  if (bytes === null) return REQUEST_TIMEOUT_MS
  return REQUEST_TIMEOUT_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_MS)
}

export interface CloudFetchInit extends RequestInit {
  /** Overrides the size-derived deadline for this one request. */
  timeoutMs?: number
}

/** Settle `work` as soon as it settles, or reject the moment `signal` aborts.
 *
 *  For the steps of a request that take no AbortSignal of their own. The
 *  abandoned promise keeps running — it just no longer decides anything, and
 *  its rejection is still handled here, so it cannot surface as an unhandled
 *  one later. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = (): unknown => signal.reason ?? new Error('aborted')
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    const stopListening = () => signal.removeEventListener('abort', onAbort)
    work.then(
      (value) => { stopListening(); resolve(value) },
      (err: unknown) => { stopListening(); reject(err) },
    )
  })
}

export async function cloudFetch(path: string, init: CloudFetchInit = {}): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init
  // The clock starts BEFORE the token, not after it. getAccessToken() goes to
  // the network whenever the access token has expired (supabase-js refreshes
  // it there), and that refresh has no deadline of its own — so awaiting it
  // outside this guard left exactly the wedge the guard exists to remove, one
  // step earlier: Create awaits these calls one after another, and a refresh
  // whose peer disappeared mid-flight never settles on its own.
  //
  // Two things must be able to end all of it — the caller's signal (a
  // cancelled run) and the deadline — and fetch takes one. AbortSignal.any
  // would merge them, but it is newer than the WKWebView LU runs inside on
  // older macOS, so the relay is wired by hand.
  const ac = new AbortController()
  const relay = () => ac.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs ?? deadlineFor(init))
  try {
    const token = await untilAborted(getAccessToken(), ac.signal)
    if (!token) throw new CloudJobError('not signed in', 401)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return await fetch(`${CLOUD_BASE}${path}`, { ...rest, headers, signal: ac.signal })
  } catch (err) {
    // Engines disagree on whether a fetch rejects with the abort *reason*, so
    // the deadline is remembered here instead of read back off the signal.
    // 408 keeps pollJob's policy intact — a timeout is worth another try.
    // A 401 raised above is not a timeout and must keep its own status.
    if (timedOut && !(err instanceof CloudJobError)) {
      throw new CloudJobError('the cloud did not answer in time', 408)
    }
    throw err
  } finally {
    // The deadline covers what this function owns: the token (refresh
    // included), connect, request body, response headers — which is where the
    // observed wedge lived (an upload or a submit that never came back).
    // Reading the response body is the caller's half; jsonOrError reports a
    // torn read rather than hanging.
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}
