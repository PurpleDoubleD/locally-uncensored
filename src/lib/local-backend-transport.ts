/**
 * One reading of "the local backend did not answer", shared by everyone who
 * talks to a server on this machine or on the LAN.
 *
 * The Rust proxy hands a refused connection back as
 * `Response(503, {"error": "proxy_localhost_stream_chunked: error sending
 * request for url (http://127.0.0.1:8127/v1/chat/completions)"})`. That text
 * names a Rust command and a port and tells the user nothing they can act on,
 * so no provider may put it in a chat bubble. Until 04.09.2026 nobody had to:
 * the proxy's end-of-stream marker won the race against the rejection and the
 * chat said "the connection dropped, check your network" instead, which was
 * worse, because it was wrong. With that race closed (see proxy.rs) the real
 * message arrives, and every provider needs the same two answers about it:
 * is this a transport failure against MY host, and what do I say instead.
 */

/** The shapes a refused or broken local connection arrives in. */
const TRANSPORT_RE =
  /error sending request|connection refused|failed to fetch|ECONNREFUSED|tcp connect|proxy_localhost/i

/**
 * True when `message` is a transport failure against `baseUrl`'s host.
 *
 * Three halves, and each one earned its place. Without the pattern check a real
 * HTTP error from the server would be swallowed and replaced by our guess.
 * Without the hostname check a failure against a different machine would be
 * blamed on this one. And without the port check, the two servers people
 * actually run side by side on 127.0.0.1, our engine on 8127 and Ollama on
 * 11434, are indistinguishable: whoever could not reach one was told to restart
 * the other.
 *
 * The port is optional, the hostname is not. `ECONNREFUSED 127.0.0.1` names a
 * host and no port and still lands. A bare `Failed to fetch` names neither and
 * is turned down on purpose: a server may use those same words about a file it
 * could not read, and swallowing that would replace its own answer with a
 * sentence about a machine that is in fact running. So everything we produce
 * ourselves names the address it failed on, see both fallbacks in
 * `localFetchStream` (api/backend.ts).
 */
export function isLocalTransportFailure(message: string, baseUrl: string): boolean {
  const msg = String(message ?? '')
  const host = hostOf(baseUrl)
  if (!host) return false
  if (!TRANSPORT_RE.test(msg)) return false
  const [name, port] = [host.split(':')[0], host.split(':')[1]]
  if (!name || !msg.includes(name)) return false
  if (!port) return true
  const genannt = [...msg.matchAll(new RegExp(`${maskiert(name)}:(\\d+)`, 'g'))].map((m) => m[1])
  return genannt.length === 0 || genannt.includes(port)
}

/** Punkte in einer IP sind sonst Platzhalter fuer jedes Zeichen. */
function maskiert(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `127.0.0.1:8127` out of `http://127.0.0.1:8127/v1`, and '' when it is not a URL. */
export function hostOf(baseUrl: string): string {
  return String(baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/**
 * What the user reads when a backend that is not our own engine went silent.
 *
 * Deliberately without a "check your network" line: the address is on this
 * machine or on the LAN, so the internet is never the answer. The three causes
 * named are the three that actually happen, in the order they happen.
 */
export function localBackendUnreachableMessage(name: string, baseUrl: string): string {
  return `${name} is not answering on ${hostOf(baseUrl)}. It is either not running, still starting up, or listening on a different address. Start it and send again, or pick a different backend in Settings, AI Backends.`
}

/**
 * The same answer for a backend that is NOT on this machine or the LAN.
 *
 * The proxy carries more than loopback: every host the pinned CSP does not
 * know goes through it too, which is every OpenAI or Anthropic compatible
 * provider a user points at a domain of their own. A refused connection there
 * arrives in exactly the same raw shape and needs exactly the same
 * translation, but not the same advice. Out there the address can be a typo
 * and the line can be down, and telling somebody to start a server they do not
 * run would be nonsense.
 */
export function remoteBackendUnreachableMessage(name: string, baseUrl: string): string {
  return `${name} is not answering on ${hostOf(baseUrl)}. The request never reached it, so the address may be wrong or the connection may be down. Check the base URL in Settings, AI Backends, and check your network, then send again.`
}
