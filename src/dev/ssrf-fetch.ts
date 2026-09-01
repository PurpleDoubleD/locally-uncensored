/**
 * Das HOLEN einer vom Aufrufer bestimmten URL — Wächter, Pin und
 * Weiterleitungskette an einer Stelle.
 *
 * `ssrf-policy.ts` daneben entscheidet, WELCHE Adresse gesperrt ist. Diese
 * Datei entscheidet, WIE die Entscheidung an die Verbindung kommt, und schliesst
 * damit zwei Lücken, die in `vite.config.ts` offen standen:
 *
 * 1. DAS REBIND-FENSTER. `assertPublicUrl` löste den Namen auf, prüfte die
 *    Adressen — und danach löste `http.get(url)` denselben Namen ERNEUT auf.
 *    Zwischen beiden Auflösungen liegt ein Fenster: ein Resolver, der der
 *    Prüfung eine öffentliche Adresse und dem Verbindungsaufbau `127.0.0.1`
 *    gibt, lief ungebremst durch (klassisches TOCTOU / DNS-Rebinding). Rust hat
 *    dieselbe Stelle längst zu: `pinned_client` in
 *    `src-tauri/src/commands/proxy.rs` (:290) setzt `resolve_to_addrs(host,
 *    addrs)` auf genau die Adressen, die das Tor gerade freigegeben hat, und
 *    `ssrf_safe_fetch` (:314) folgt jeder Weiterleitung von Hand, damit jeder
 *    Sprung SEINE eigene Prüfung UND SEINEN eigenen Pin bekommt. Hier ist das
 *    `createPinnedLookup`: Node fragt für einen NAMEN die `lookup`-Funktion,
 *    und diese gibt nur die geprüften Adressen zurück. Der Name bleibt in der
 *    URL — Host-Header und SNI sind davon unberührt, nur das Ziel der
 *    Verbindung ist festgenagelt. Für eine IP-LITERAL im Host fragt Node gar
 *    nicht erst; das ist genau Rusts `if parse_ip_host(host).is_none()`.
 *
 * 2. DIE KETTE. Jeder der drei Aufrufer hatte seine eigene Weiterleitungs-
 *    schleife — `proxy-image` folgte GENAU EINEM Sprung, `proxy-download` und
 *    `downloadFile` je fünf, jede mit eigener `Location`-Auflösung. Drei Kopien
 *    derselben Sicherheitslogik sind drei Gelegenheiten, sie unterschiedlich
 *    kaputt zu machen. Jetzt gibt es eine Schleife, und sie liegt hier, wo ein
 *    Test sie gegen einen echten Server fahren kann.
 *
 * REIN WIE ALLES UNTER src/dev: kein `node:*`-Import. Die HTTP-Schicht
 * (`http.get` / `https.get`), der Resolver (`dns.promises.lookup`) und das
 * IP-Orakel (`net.isIP`) werden HEREINGEREICHT. Das ist keine Attrappe: der
 * Test gibt dieselben echten Funktionen herein wie `vite.config.ts` und fährt
 * sie gegen einen echten lokalen Server — nur die DNS-Antwort für den einen
 * Testnamen kommt aus dem Test, weil kein Test einen DNS-Eintrag setzen kann.
 */

import type { IpFamilyFn, SsrfPolicy } from './ssrf-policy'

// ── Die Form der Node-Bausteine, ohne node:* zu importieren ────────────────

/** Ein Eintrag, wie `dns.lookup(…, { all: true })` ihn zurückgibt. */
export interface LookupAddress {
  address: string
  family: number
}

/** Die Rückmeldung an Node: entweder EINE Adresse, oder alle. */
export type LookupCallback = (
  err: Error | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * Was Node der `lookup`-Funktion mitgibt (`dns.LookupOptions`).
 *
 * `family` ist dort `number | 'IPv4' | 'IPv6'` — beide Schreibweisen müssen
 * hier stehen, sonst passt diese Signatur nicht auf Nodes `LookupFunction`.
 */
export interface LookupOptions {
  family?: number | string | undefined
  all?: boolean | undefined
  hints?: number | undefined
}

/** `4`, `6` oder `0` (egal welche) aus Nodes beiden Schreibweisen. */
function wantedFamily(family: number | string | undefined): number {
  if (family === 4 || family === 'IPv4') return 4
  if (family === 6 || family === 'IPv6') return 6
  return 0
}

/** Die Form von `dns.lookup`, wie `net.connect` sie erwartet. */
export type LookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void

/** Das Stück `http.IncomingMessage`, das diese Schleife anfasst. */
export interface HttpResponseLike {
  statusCode?: number | undefined
  headers: Record<string, string | string[] | undefined>
  resume(): void
}

/** Das Stück `http.ClientRequest`, das diese Schleife anfasst. */
export interface HttpRequestLike {
  on(event: 'error', listener: (err: Error) => void): unknown
}

/** Die Optionen, die an `http.get` gehen. */
export interface HttpGetOptions {
  headers?: Record<string, string>
  lookup?: LookupFn
}

/** Die Form von `http.get(url, options, callback)`. */
export type HttpGetter<R extends HttpResponseLike = HttpResponseLike> = (
  url: string,
  options: HttpGetOptions,
  callback: (response: R) => void,
) => HttpRequestLike

// ── Der Pin ────────────────────────────────────────────────────────────────

/**
 * Eine `lookup`-Funktion, die AUSSCHLIESSLICH die schon geprüften Adressen
 * zurückgibt — der Port von `pinned_client`/`resolve_to_addrs`.
 *
 * Node ruft sie mit `{ family }` (dann muss die Antwort aus dieser Familie
 * kommen) oder mit `{ all: true }` (dann als Liste) auf; beide Formen werden
 * bedient, weil welche davon kommt, von der Node-Version und von
 * `autoSelectFamily` abhängt. Bleibt nach dem Familienfilter nichts übrig, ist
 * die richtige Antwort ein Fehler und nicht etwa eine frische Auflösung: eine
 * Adresse, die niemand geprüft hat, darf hier nicht entstehen.
 */
export function createPinnedLookup(
  addresses: readonly string[],
  ipFamily: IpFamilyFn,
): LookupFn {
  const pinned: LookupAddress[] = addresses
    .map((address) => ({ address, family: ipFamily(address) }))
    .filter((entry) => entry.family === 4 || entry.family === 6)

  return (hostname, options, callback) => {
    const wanted = wantedFamily(options?.family)
    const matching = wanted === 0 ? pinned : pinned.filter((e) => e.family === wanted)
    if (matching.length === 0) {
      const err: Error & { code?: string } = new Error(
        `no checked address pinned for ${hostname}`,
      )
      // Dieselbe Kennung, die ein echter Resolver für „gibt es nicht" benutzt,
      // damit der Aufrufer den Fall nicht gesondert lesen muss.
      err.code = 'ENOTFOUND'
      callback(err, '')
      return
    }
    if (options?.all) {
      callback(null, matching.map((e) => ({ address: e.address, family: e.family })))
      return
    }
    callback(null, matching[0].address, matching[0].family)
  }
}

// ── Das Tor, mit den freigegebenen Adressen als Ergebnis ───────────────────

/**
 * Der Wächter hat NEIN gesagt — abgegrenzt von einem Transportfehler, damit
 * die Aufrufer weiter 403 (gesperrt) und 502 (nicht erreichbar) auseinander
 * halten können. Ohne eigene Klasse müsste dafür der Meldungstext gelesen
 * werden, und dann wäre jede Umformulierung einer Fehlermeldung eine
 * Statuscode-Änderung.
 */
export class SsrfBlockedError extends Error {}

/** Eine URL, die den Wächter passiert hat, samt der Adressen, auf die. */
export interface CheckedTarget {
  url: URL
  /** Die geprüften Adressen — genau die, auf die verbunden werden darf. */
  addresses: string[]
}

/** Was diese Datei vom Aufrufer braucht. */
export interface SsrfFetchDeps<R extends HttpResponseLike = HttpResponseLike> {
  /** Die Regeln (`createSsrfPolicy(net.isIP)`). */
  policy: SsrfPolicy
  /** `net.isIP` — dasselbe Orakel, mit dem die Regeln gebaut wurden. */
  ipFamily: IpFamilyFn
  /** `dns.promises.lookup(host, { all: true })`, auf die Adressen reduziert. */
  resolveHost: (host: string) => Promise<string[]>
  /** `http.get` bzw. `https.get`, ausgewählt nach Protokoll (`'https:'`). */
  getter: (protocol: string) => HttpGetter<R>
}

/**
 * Das Urteil über EINE URL, mit den Adressen, die dabei freigegeben wurden.
 *
 * Der Unterschied zum alten `assertPublicUrl`: dort fiel die DNS-Antwort nach
 * der Prüfung auf den Boden, und die Verbindung fragte neu. Hier kommt sie
 * zurück und wird zum Pin.
 */
export async function checkPublicUrl<R extends HttpResponseLike>(
  urlStr: string,
  deps: SsrfFetchDeps<R>,
): Promise<CheckedTarget> {
  const verdict = deps.policy.checkUrl(urlStr)
  if (verdict.kind === 'deny') throw new SsrfBlockedError(verdict.reason)
  if (verdict.kind === 'allow') {
    // IP-Literal: die Adresse steht in der URL, es gibt nichts aufzulösen.
    return { url: verdict.url, addresses: [verdict.url.hostname.replace(/^\[|\]$/g, '')] }
  }
  const addresses = await deps.resolveHost(verdict.host)
  const resolved = deps.policy.checkResolved(addresses)
  if (!resolved.ok) throw new SsrfBlockedError(resolved.reason)
  return { url: verdict.url, addresses: [...addresses] }
}

// ── Die Kette ──────────────────────────────────────────────────────────────

/** So viele Sprünge wie die bisherigen Schleifen in vite.config.ts erlaubten. */
export const SSRF_MAX_HOPS = 5

/**
 * Die Status, denen gefolgt wird.
 *
 * Wörtlich Rusts Liste (`ssrf_safe_fetch`: `301 | 302 | 303 | 307 | 308`) und
 * damit ENGER als das bisherige `>= 300 && < 400` hier: 300 und 304 sind zwar
 * Umleitungsklasse, tragen aber kein Ziel — sie gehören dem Aufrufer, nicht der
 * Schleife.
 */
function isFollowedRedirect(status: number | undefined): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Ein `Location`-Header ist laut Typ auch eine Liste; der erste Wert zählt. */
function locationOf(response: HttpResponseLike): string | null {
  const raw = response.headers.location
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return null
}

/** Das Ergebnis: die Antwort und die URL, von der sie kam. */
export interface SsrfFetchResult<R extends HttpResponseLike = HttpResponseLike> {
  response: R
  url: string
}

/**
 * GET auf eine vom Aufrufer bestimmte URL, mit dem Wächter auf JEDEM Sprung
 * und der Verbindung auf genau der Adresse, gegen die dieser Sprung geprüft
 * wurde — der Port von `ssrf_safe_fetch` (proxy.rs:314).
 *
 * Die Antwort kommt ungelesen zurück (Node hält den Strom angehalten, bis
 * jemand liest), damit der Aufrufer sie weiterreichen oder auf die Platte
 * schreiben kann. Nur die Rümpfe der Weiterleitungen werden hier verworfen.
 */
export async function ssrfSafeGet<R extends HttpResponseLike>(
  startUrl: string,
  opts: { headers?: Record<string, string>; maxHops?: number },
  deps: SsrfFetchDeps<R>,
): Promise<SsrfFetchResult<R>> {
  const maxHops = opts.maxHops ?? SSRF_MAX_HOPS
  let current = startUrl
  for (let hop = 0; hop <= maxHops; hop++) {
    // JEDER Sprung, nicht nur der erste. Eine öffentliche URL, die mit
    // `302 Location: http://169.254.169.254/…` antwortet, ist der klassische
    // Bypass — und das Ziel wird hier geprüft, BEVOR eine Verbindung dorthin
    // aufgebaut wird.
    const target = await checkPublicUrl(current, deps)
    const options: HttpGetOptions = {
      // Der Pin. Für eine IP-Literal im Host fragt Node die `lookup`-Funktion
      // gar nicht erst — dann ist sie unbenutzt, und die Adresse steht ohnehin
      // schon in der URL.
      lookup: createPinnedLookup(target.addresses, deps.ipFamily),
    }
    if (opts.headers) options.headers = opts.headers
    const response = await new Promise<R>((resolveResponse, rejectResponse) => {
      const request = deps.getter(target.url.protocol)(current, options, resolveResponse)
      request.on('error', rejectResponse)
    })

    const location = isFollowedRedirect(response.statusCode) ? locationOf(response) : null
    if (location === null) return { response, url: current }

    response.resume() // Rumpf der Weiterleitung verwerfen
    // `Location` darf relativ sein (RFC 7231) und wird gegen den AKTUELLEN
    // Sprung aufgelöst — der ist geprüft, der rohe Header ist es nicht.
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new Error(`Invalid redirect target: ${location}`)
    }
    current = next
  }
  throw new Error('Too many redirects')
}
