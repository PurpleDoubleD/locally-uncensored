/**
 * The port the managed built-in engine actually runs on, and the base URL the
 * `openai` slot has to carry so requests reach it.
 *
 * GH #118 (nayffy, 2026-08-27, Windows 11): the engine port was a constant in
 * two places, `http://127.0.0.1:8127/v1` in the provider slot and 8127 in Rust,
 * and nothing could move. Since the Rust side may now take the next free port
 * when 8127 is held (a leftover llama-server, or one of the port ranges Windows
 * reserves for Hyper-V and WSL), the slot has to follow it. A slot pointing at
 * the old port would produce exactly the symptom the ticket describes, a
 * refused connection to a server that is up and healthy one port away.
 *
 * Pure on purpose, and deliberately narrow: only a LOOPBACK base URL is ever
 * rewritten. The same slot can hold LM Studio or a remote OpenAI-compatible
 * server the user configured, and moving somebody else's port would be a much
 * worse bug than the one this fixes.
 */

/** Hosts that mean "this machine". Anything else is not ours to rewrite. */
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])$/i

/** `http://host:port/rest` split into scheme, host[:port] and the rest. */
const URL_SHAPE = /^(https?:\/\/)([^/?#]+)([/?#].*)?$/i

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
}

/** Split `host:port` into its two halves. The port half is null when absent. */
function splitHostPort(hostPort: string): { host: string; port: number | null } {
  const idx = hostPort.lastIndexOf(':')
  if (idx < 0) return { host: hostPort, port: null }
  const tail = hostPort.slice(idx + 1)
  // `[::1]` carries colons of its own, so a tail that is not all digits is
  // part of the host, not a port.
  if (!/^\d+$/.test(tail)) return { host: hostPort, port: null }
  const port = Number(tail)
  return { host: hostPort.slice(0, idx), port: isPort(port) ? port : null }
}

/** The port a base URL points at, or null when it names none. */
export function enginePortFromBaseUrl(baseUrl: string): number | null {
  const m = String(baseUrl ?? '').match(URL_SHAPE)
  return m ? splitHostPort(m[2]).port : null
}

/** The same base URL with `port` substituted. Unparseable input is returned
 *  unchanged rather than mangled. */
export function withEnginePort(baseUrl: string, port: number): string {
  const m = String(baseUrl ?? '').match(URL_SHAPE)
  if (!m || !isPort(port)) return baseUrl
  const { host } = splitHostPort(m[2])
  return `${m[1]}${host}:${port}${m[3] ?? ''}`
}

/**
 * The base URL the managed slot must be written to so it reaches the engine on
 * `port`, or null when there is nothing to write.
 *
 * Null covers every case where a rewrite would be wrong or pointless: a port
 * that is not a port, a slot that already names it, and a host that is not this
 * machine.
 */
export function baseUrlNeedingEnginePort(baseUrl: string, port: unknown): string | null {
  if (!isPort(port)) return null
  const m = String(baseUrl ?? '').match(URL_SHAPE)
  if (!m) return null
  const { host } = splitHostPort(m[2])
  if (!LOOPBACK.test(host)) return null
  if (enginePortFromBaseUrl(baseUrl) === port) return null
  const next = withEnginePort(baseUrl, port)
  return next === baseUrl ? null : next
}

/**
 * The one line Settings shows about where the engine is listening.
 *
 * A13, Windows counter-check 2026-09-02: the engine walked from 8127 to 8129
 * because a leftover listener held 8127, the log said so, and no surface in
 * the app did. Providers said "nothing to configure", the expert panel named
 * the model and the context size, Troubleshoot named neither port. Anyone
 * pointing another tool at the engine, or reading a refused connection on
 * 8127, had nothing to go on.
 *
 * `preferred` is the port the engine starts its walk at (`ENGINE_PORT`, the
 * mirror of Rust's `DEFAULT_ENGINE_PORT`). It is passed in rather than
 * imported so this module stays free of the API layer that imports it.
 */
export function enginePortLine(
  status: { running?: boolean; port?: unknown } | null | undefined,
  preferred: number,
): string {
  if (!status?.running || !isPort(status.port)) return 'Engine not running'
  if (status.port === preferred) return `Port: ${status.port}`
  return `Port: ${status.port} (${preferred} was taken)`
}
