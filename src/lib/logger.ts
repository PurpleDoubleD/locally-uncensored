// Tiny structured logger for the web app.
//
// In production, every call serialises to a single-line JSON object on
// stdout/stderr so log aggregators (Vercel, Logflare, Datadog, etc.) can
// parse it without an SDK. In development, calls render as human-readable
// console output instead.
//
// Sensitive keys are redacted before serialisation — the denylist matches
// substring-by-name so `apiKey`, `apikey`, `api_key`, `headers.authorization`
// all collapse to `"[REDACTED]"`. Keep the list short and grow it only when
// a real leak risk shows up; an over-aggressive scrubber hides bugs.
//
// Why not pino: zero extra runtime dep, no transport setup, fits the
// uselu-on-Vercel deploy where stdout IS the transport.
//
// Audit #01 — that last paragraph was written for a server. In the DESKTOP
// build there is no stdout: the WebView's console only exists while DevTools
// are open, which happens under `debug_assertions` and nowhere else. Every
// line below was therefore written to nothing on a user's machine. Since the
// Rust side gained a rolling log file, warn/error lines are additionally
// mirrored into it through the `log_write` command, so a support log holds
// both halves of the app in one chronological stream instead of only the
// backend half of a bug whose visible symptom happened in React.
//
// Only warn and error are mirrored. debug/info are the high-frequency levels
// (render loops, polling, token streams) and would drown the signal — and
// every mirrored line costs an IPC round trip. The console keeps all four.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

const DENY_SUBSTRINGS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'service_role',
  'private_key',
]

const isProd = () => process.env.NODE_ENV === 'production'

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase()
    if (DENY_SUBSTRINGS.some((d) => lower.includes(d))) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = scrub(v, depth + 1)
    }
  }
  return out
}

function serializeError(err: unknown): Record<string, unknown> | unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return err
}

/** Levels worth a round trip into the Rust log file. See the header. */
const MIRRORED_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(['warn', 'error'])

/**
 * Same detection as `isTauri()` in ../api/backend, deliberately duplicated
 * rather than imported: backend.ts imports THIS module, and importing it back
 * would close a cycle whose evaluation order decides whether `log` exists when
 * backend.ts's module body runs. Ten lines of duplication beat a TDZ crash on
 * startup that only reproduces under some bundler settings.
 */
function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__)
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * The PROMISE is memoised, not the resolved function. Two warns in the same
 * tick both arrive before any `await` has completed, so a `cachedInvoke`
 * variable would still be null for the second one and it would start a second
 * dynamic import of the same module — measurably losing the second line under
 * some module runners. One promise, shared by every caller.
 */
let invokePromise: Promise<InvokeFn> | null = null

function getInvoke(): Promise<InvokeFn> {
  if (!invokePromise) {
    invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke as InvokeFn)
  }
  return invokePromise
}

/**
 * Mirror one line into the Rust rolling log file.
 *
 * `cleaned` is the ALREADY-SCRUBBED context — the redaction has to happen
 * before this, never inside it, or the secret that the console never shows
 * would be written to a file the user is then asked to attach to a bug report.
 * The single call site in `emit` passes the scrubbed value for that reason.
 *
 * Fire and forget, and it must never throw. Logging is called from catch
 * blocks and from error boundaries; a logger that can fail turns a handled
 * error into an unhandled one, and a failed mirror (no Tauri, command not
 * registered, IPC busy) is not worth a single pixel of user attention. Every
 * path is swallowed: the synchronous body, the dynamic import, the invoke.
 */
function mirrorToLogFile(level: LogLevel, msg: string, cleaned?: LogContext): void {
  if (!MIRRORED_LEVELS.has(level)) return
  if (!isTauriRuntime()) return
  try {
    let message = msg
    if (cleaned && Object.keys(cleaned).length > 0) {
      // scrub() caps its recursion rather than tracking visited nodes, so a
      // cyclic object survives it and JSON.stringify would throw on the cycle.
      try {
        message = `${msg} ${JSON.stringify(cleaned)}`
      } catch {
        message = `${msg} [context not serialisable]`
      }
    }
    void getInvoke()
      .then((invoke) => invoke('log_write', { level, target: 'frontend', message }))
      .catch(() => {
        /* the log file is a best effort; never surface its failure */
      })
  } catch {
    /* unreachable in practice — belt and braces, see the doc comment */
  }
}

function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (level === 'debug' && isProd()) return

  const safeCtx = ctx
    ? Object.fromEntries(
        Object.entries(ctx).map(([k, v]) => [
          k,
          k.toLowerCase() === 'err' || k.toLowerCase() === 'error'
            ? serializeError(v)
            : v,
        ]),
      )
    : undefined
  const cleaned = scrub(safeCtx) as LogContext | undefined

  // After the scrub, before either console path: the file gets the redacted
  // context and nothing else, and it gets the line whether the build is a
  // production bundle or a dev server — the desktop app is a production
  // bundle, and a `npm run tauri dev` session is the case where somebody is
  // actually reading the file while it is written.
  mirrorToLogFile(level, msg, cleaned)

  if (isProd()) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(cleaned ?? {}),
    })
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
    return
  }

  const prefix = `[${level}]`
  if (cleaned) console.log(prefix, msg, cleaned)
  else console.log(prefix, msg)
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
}

/** Exported for the test only — exercise the scrubber on arbitrary input. */
export const _scrubForTest = (v: unknown) => scrub(v)
