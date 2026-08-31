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

function deadlineFor(init: RequestInit): number {
  const body = init.body
  const bytes =
    body instanceof ArrayBuffer
      ? body.byteLength
      : ArrayBuffer.isView(body)
        ? body.byteLength
        : typeof Blob !== 'undefined' && body instanceof Blob
          ? body.size
          : typeof body === 'string'
            ? body.length
            : 0
  return REQUEST_TIMEOUT_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_MS)
}

export interface CloudFetchInit extends RequestInit {
  /** Overrides the size-derived deadline for this one request. */
  timeoutMs?: number
}

export async function cloudFetch(path: string, init: CloudFetchInit = {}): Promise<Response> {
  const token = await getAccessToken()
  if (!token) throw new CloudJobError('not signed in', 401)
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)

  const { timeoutMs, signal, ...rest } = init
  // Two things must be able to end this request — the caller's signal (a
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
    return await fetch(`${CLOUD_BASE}${path}`, { ...rest, headers, signal: ac.signal })
  } catch (err) {
    // Engines disagree on whether a fetch rejects with the abort *reason*, so
    // the deadline is remembered here instead of read back off the signal.
    // 408 keeps pollJob's policy intact — a timeout is worth another try.
    if (timedOut) throw new CloudJobError('the cloud did not answer in time', 408)
    throw err
  } finally {
    // The deadline covers what this function owns: connect, request body,
    // response headers — which is where the observed wedge lived (an upload
    // or a submit that never came back). Reading the response body is the
    // caller's half; jsonOrError reports a torn read rather than hanging.
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}
