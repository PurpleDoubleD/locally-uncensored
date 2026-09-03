import type { IncomingMessage } from 'http'
import https from 'https'
import http from 'http'
import dns from 'node:dns'
import net from 'node:net'
import { createSsrfPolicy } from '../src/dev/ssrf-policy'
import { checkPublicUrl, type SsrfFetchDeps } from '../src/dev/ssrf-fetch'

// ── Dev-server SSRF guard ───────────────────────────────────────
// The dev proxies that fetch a *user-supplied* ?url= (proxy-image,
// proxy-download) are an SSRF sink: a markdown image / download link could
// point the server at an internal address (169.254.169.254 metadata, LAN
// boxes, localhost services). The packaged desktop app routes these through
// the Rust proxy, which has the strong validate_public_url guard
// (src-tauri/src/commands/proxy.rs); this is the parity guard for the
// `npm run dev` / web build (konata's SSH-tunnel path). Best-effort against
// DNS-rebind — this is a dev server, not the production trust boundary.
//
// The rule table itself now lives in src/dev/ssrf-policy.ts, next to its test:
// it used to decide on the SPELLING of an IPv6 address (`startsWith('fe80')`,
// `/::ffff:…$/`), which only holds while the text is already in canonical
// compressed form. `net.isIP` stays the oracle for "is this an IP literal at
// all" and is handed in rather than reimplemented.
export const ssrf = createSsrfPolicy((value) => net.isIP(value))

// Die drei Dinge, die der reine Wächter nicht selbst haben darf: das
// IP-Orakel, der Resolver und die HTTP-Schicht. Alles echt, nichts nachgebaut —
// derselbe Satz Funktionen, den der Test von src/dev/ssrf-fetch.ts
// hereinreicht, damit dort NICHT eine zweite HTTP-Welt geprüft wird.
export const ssrfDeps: SsrfFetchDeps<IncomingMessage> = {
  policy: ssrf,
  ipFamily: (value) => net.isIP(value),
  resolveHost: async (host) =>
    (await dns.promises.lookup(host, { all: true })).map((a) => a.address),
  getter: (protocol) => {
    const impl = protocol === 'https:' ? https : http
    return (url, options, callback) => impl.get(url, options, callback)
  },
}

/**
 * Der Wächter für EINE URL — und seit dem Rebind-Fix gibt er die geprüften
 * Adressen mit heraus, statt sie wegzuwerfen.
 *
 * Vorher endete er mit `return verdict.url`, und der `http.get` daneben löste
 * den Namen ein zweites Mal auf. Zwischen Prüfung und Verbindung lag damit ein
 * Fenster, in dem ein Resolver die Antwort wechseln kann (DNS-Rebinding). Wer
 * dieses Ergebnis benutzt, muss `createPinnedLookup(addresses, …)` an den
 * `get` weiterreichen — sonst ist das Fenster wieder offen. Rust:
 * `validate_public_url_addrs` + `pinned_client` (proxy.rs:213 / :290).
 */
export async function assertPublicUrl(urlStr: string) {
  return checkPublicUrl(urlStr, ssrfDeps)
}
