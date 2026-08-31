/**
 * Idle watchdog for streamed HTTP bodies — the one place every provider's
 * bytes pass through.
 *
 * Constraint: a chat stream has no client-side deadline it can rely on. The
 * only bound the app had was the Rust proxy's 7200 s TOTAL timeout, and the
 * direct-fetch paths (cloud providers, macOS/Linux, browser dev mode) had none
 * at all. When a laptop sleeps or Wi-Fi drops without a FIN the TCP connection
 * stays half-open: `reader.read()` never settles, the spinner runs forever and
 * only "Stop" ends it. Every laptop lid triggers it.
 *
 * So the bound is on SILENCE, not on total duration — a stream still producing
 * tokens after an hour is healthy, one that produced nothing for a minute is
 * not. Both stream parsers (sse.ts for OpenAI/Anthropic, stream.ts for Ollama
 * NDJSON) read through `readChunks` below, so the watchdog exists once instead
 * of once per provider.
 *
 * Relation to the Rust-side idle timeout (proxy.rs): the two do not double up.
 * Whichever fires first ends the body. Rust closing the channel makes the
 * parser see a clean EOF, which the providers already turn into their single
 * terminal 'disconnect' chunk, and the timer here is cleared by the read that
 * comes back done. This side exists because the direct-fetch paths never reach
 * Rust at all, so it must work on its own.
 */

/** No chunk for this long, once the stream has started → treat it as dead. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000

/**
 * Grace for the FIRST chunk. A cold local model is loaded only when the
 * request arrives: Ollama answers the headers immediately and then sends
 * nothing at all while it pulls tens of gigabytes off disk into VRAM, and
 * llama.cpp behaves the same on a long prompt. Holding that to the 60 s
 * between-chunk budget would abort exactly the legitimate slow start the UI
 * already shows as "loading model". Five minutes is past any load this app
 * survives and still far short of the endless hang.
 */
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 300_000

/** Thrown by the parsers when the watchdog fires. Providers catch it and end
 *  the turn with a terminal 'disconnect' chunk rather than letting it bubble
 *  up as a raw error — the stream did not fail, it went quiet. */
export class StreamIdleTimeoutError extends Error {
  readonly code = 'stream_idle_timeout'
  /** The budget that elapsed, in ms — the readable cause for the log line. */
  readonly idleMs: number

  constructor(idleMs: number, phase: 'first chunk' | 'stream') {
    super(`No data on the ${phase} for ${Math.round(idleMs / 1000)}s — connection went silent`)
    this.name = 'StreamIdleTimeoutError'
    this.idleMs = idleMs
  }
}

export function isStreamIdleTimeout(err: unknown): err is StreamIdleTimeoutError {
  return !!err && typeof err === 'object'
    && (err as { code?: unknown }).code === 'stream_idle_timeout'
}

export interface StreamIdleOptions {
  /** Silence budget between chunks, ms. `0` or negative disables the watchdog. */
  idleMs?: number
  /** Silence budget before the first chunk, ms. Independent of `idleMs` and
   *  much larger by default — see STREAM_FIRST_CHUNK_TIMEOUT_MS for why. Only
   *  consulted when `idleMs` enables the watchdog at all. */
  firstChunkMs?: number
  /**
   * Fired once, before the error is thrown, so the caller can abort the request
   * itself. That is what actually stops the upstream generation — and on the
   * Tauri proxy path it is what fires `cancel_proxy_stream`. Cancelling only
   * this reader would leave Rust happily pulling from the backend.
   */
  onIdle?: () => void
}

/**
 * Read a response body chunk by chunk, abandoning it when it goes silent for
 * longer than the budget. Yields the raw bytes; decoding and framing stay with
 * the parser that called us, so the SSE line-terminator handling in sse.ts is
 * untouched by this.
 */
export async function* readChunks(
  response: Response,
  opts?: StreamIdleOptions,
): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const idleMs = opts?.idleMs ?? 0
  const firstChunkMs = opts?.firstChunkMs ?? STREAM_FIRST_CHUNK_TIMEOUT_MS
  let first = true
  let timedOut = false

  try {
    for (;;) {
      const budget = first ? firstChunkMs : idleMs
      let result: ReadableStreamReadResult<Uint8Array>

      if (idleMs > 0 && budget > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const silent = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            // Abort BEFORE rejecting: the reject only unblocks this loop, the
            // caller's abort is what tears the request down.
            try { opts?.onIdle?.() } catch { /* best effort, never mask the timeout */ }
            reject(new StreamIdleTimeoutError(budget, first ? 'first chunk' : 'stream'))
          }, budget)
        })
        try {
          // Promise.race leaves a reaction on the pending read, so the abort's
          // later rejection is handled and never surfaces as an unhandled one.
          result = await Promise.race([reader.read(), silent])
        } finally {
          if (timer) clearTimeout(timer)
        }
      } else {
        result = await reader.read()
      }

      if (result.done) break
      if (result.value) {
        first = false
        yield result.value
      }
    }
  } finally {
    if (timedOut) {
      // A read is still outstanding. Cancel so the body is not left dangling;
      // both the cancel and the release can reject/throw on a stream the abort
      // already killed, and neither is worth reporting.
      try { void Promise.resolve(reader.cancel()).catch(() => { /* already dead */ }) } catch { /* no cancel */ }
    }
    try { reader.releaseLock() } catch { /* outstanding read after an idle abort */ }
  }
}

/** A controller the watchdog may abort, chained to the caller's own signal. */
export interface IdleAbortGuard {
  /** Hand THIS to fetch / localFetchStream instead of the caller's signal. */
  readonly signal: AbortSignal
  /** Abort the request. Wired to `StreamIdleOptions.onIdle`. */
  readonly abort: () => void
  /** Drop the listener on the caller's signal — always call it in a `finally`,
   *  a long chat session would otherwise pile up listeners on a shared signal. */
  readonly release: () => void
}

/**
 * Chain a fresh AbortController onto the caller's signal.
 *
 * The provider only ever receives an AbortSignal, never the controller behind
 * it, so it has nothing to abort when the watchdog fires. This gives it one:
 * Stop still propagates (caller → ours), and the watchdog can now cancel the
 * request without the caller knowing.
 *
 * Deliberately not `AbortSignal.any()`: that landed in Chrome 116 / Safari
 * 17.4, and this ships inside whatever WebView the user's OS provides.
 */
export function idleAbortGuard(outer?: AbortSignal): IdleAbortGuard {
  const ctl = new AbortController()
  let onOuterAbort: (() => void) | null = null

  if (outer) {
    if (outer.aborted) {
      ctl.abort()
    } else {
      onOuterAbort = () => ctl.abort()
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
  }

  return {
    signal: ctl.signal,
    abort: () => { if (!ctl.signal.aborted) ctl.abort() },
    release: () => {
      if (outer && onOuterAbort) {
        outer.removeEventListener('abort', onOuterAbort)
        onOuterAbort = null
      }
    },
  }
}
