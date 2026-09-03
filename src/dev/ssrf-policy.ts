/**
 * Der SSRF-Wächter der Dev-Proxies (`/local-api/proxy-image`,
 * `/local-api/proxy-download`) — die Entscheidung, ohne das Netz.
 *
 * Diese beiden Endpunkte holen eine URL, die der Aufrufer bestimmt. Im
 * gepackten Desktop-Build geht das durch `validate_public_url` in
 * `src-tauri/src/commands/proxy.rs`; unter `npm run dev` gibt es kein Rust,
 * und dieser Wächter ist die einzige Bremse zwischen einem Markdown-Bild und
 * `http://169.254.169.254/latest/meta-data/`.
 *
 * Warum die Regeln hier stehen und nicht mehr in `vite.config.ts`: sie waren
 * ungetestet, und die IPv6-Hälfte prüfte auf SCHREIBWEISE statt auf Adresse —
 * `lc.startsWith('fe80')`, `/::ffff:(…)$/`. Das trägt genau so lange, wie der
 * Text schon in der komprimierten Kanonform vorliegt:
 *
 *   - `0:0:0:0:0:ffff:127.0.0.1` ist eine gültige IPv6-Adresse (node
 *     `net.isIP` sagt 6), erreicht nachweislich den Loopback — und keine der
 *     alten Regexen greift darauf.
 *   - `::7f00:1` (IPv4-kompatibel, `::/96`), `ff02::1` (Multicast) und
 *     `fec0::1` (site-local) kamen ebenfalls durch.
 *
 * Über die Proxy-Endpunkte rettete bisher der WHATWG-URL-Parser die Lage: er
 * komprimiert `[0:0:0:0:0:ffff:127.0.0.1]` zu `::ffff:7f00:1`, und DAS traf
 * die Regex. Der Wächter läuft aber auch über DNS-Antworten
 * (`dns.lookup(…, { all: true })`), und dort normalisiert niemand. Deshalb
 * parst dieses Modul die Adresse in ihre acht Gruppen und entscheidet auf
 * Zahlen statt auf Text.
 *
 * `net.isIP` bleibt das Orakel dafür, WAS eine IP-Literal ist — es wird
 * hereingereicht statt nachgebaut, damit die Grenze zwischen „ist eine
 * Adresse" und „ist gesperrt" nicht auseinanderlaufen kann. Deshalb auch kein
 * `node:*`-Import hier: das Modul bleibt rein und liegt neben seinem Test.
 */

/** `net.isIP`: 0 = keine IP-Literal, 4 = IPv4, 6 = IPv6. */
export type IpFamilyFn = (value: string) => number

/** Das Urteil über eine URL, bevor irgendetwas aufgelöst oder geholt wurde. */
export type UrlVerdict =
  /** IP-Literal im Host, geprüft und erlaubt — kein DNS nötig. */
  | { kind: 'allow'; url: URL }
  /** Name im Host: erlaubt, sobald `checkResolved` die Adressen freigibt. */
  | { kind: 'resolve'; url: URL; host: string }
  /** Abgelehnt; `reason` ist die Fehlermeldung, die der Aufrufer wirft. */
  | { kind: 'deny'; reason: string }

/**
 * Eine IPv6-Adresse in ihre acht 16-Bit-Gruppen, oder `null`.
 *
 * Verarbeitet die `::`-Kompression, die angehängte punktierte IPv4-Notation
 * (`::ffff:127.0.0.1`) und eine Zonen-ID (`%en0`). Exportiert, weil der Test
 * die Zerlegung selbst festnageln muss — an ihr hängt jede Regel darunter.
 */
export function parseIpv6Groups(raw: string): number[] | null {
  let text = raw.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)

  // Angehängte IPv4 zu zwei Hex-Gruppen machen, dann ist der Rest rein hex.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (dotted) {
    const octets = dotted[2].split('.').map(Number)
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    text = `${dotted[1]}${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const toGroups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const seg of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null
      out.push(parseInt(seg, 16))
    }
    return out
  }

  const head = toGroups(halves[0])
  if (head === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null

  const tail = toGroups(halves[1])
  if (tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** Die letzten 32 Bit einer IPv6-Adresse als punktierte IPv4. */
function embeddedIpv4(groups: readonly number[]): string {
  const [hi, lo] = [groups[6], groups[7]]
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

/**
 * IPv4-Sperrliste: alles, was nicht öffentlich routbar ist, plus die
 * Cloud-Metadaten-Adresse. Identisch zur Liste, die vorher in
 * `vite.config.ts` stand.
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10/8 privat
  if (a === 127) return true // Loopback
  if (a === 169 && b === 254) return true // link-local + 169.254.169.254 Cloud-Metadaten
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 privat
  if (a === 192 && b === 168) return true // 192.168/16 privat
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a >= 224) return true // Multicast + reserviert
  return false
}

/**
 * IPv6-Sperrliste auf den zerlegten Gruppen — Präfixe, keine Schreibweisen.
 *
 * `::/96` wird als Ganzes gesperrt: darin liegen `::`, `::1` und die
 * abgeschafften IPv4-kompatiblen Adressen, und eine öffentlich routbare
 * Adresse gibt es dort nicht.
 */
function isBlockedIpv6(groups: readonly number[]): boolean {
  const zeroPrefix = (n: number): boolean => groups.slice(0, n).every((g) => g === 0)

  // IPv4-mapped ::ffff:0:0/96 — die eingebettete IPv4 entscheidet.
  if (zeroPrefix(5) && groups[5] === 0xffff) return isBlockedIpv4(embeddedIpv4(groups))
  // NAT64 64:ff9b::/96 — komplett gesperrt, wie vorher. Dahinter steckt immer
  // eine IPv4, und der Übersetzer davor ist nichts, dem dieser Dev-Server
  // die Auswahl des Ziels überlassen sollte.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeroPrefixFrom(groups, 2, 6)) return true
  if (zeroPrefix(6)) return true // ::/96 — unspecified, Loopback, IPv4-kompatibel
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (abgeschafft)
  if ((groups[0] & 0xff00) === 0xff00) return true // ff00::/8 Multicast
  return false
}

/** Sind die Gruppen `from` bis `to` (exklusiv) alle null? */
function zeroPrefixFrom(groups: readonly number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (groups[i] !== 0) return false
  return true
}

export interface SsrfPolicy {
  /** True für jede Adresse, die der Dev-Server nicht anfassen darf. */
  isBlockedIp(ip: string): boolean
  /** Urteil über eine vom Aufrufer gelieferte URL, ohne Netzzugriff. */
  checkUrl(urlStr: string): UrlVerdict
  /** Urteil über die DNS-Antwort zu einem Namen aus `checkUrl`. */
  checkResolved(addresses: readonly string[]): { ok: true } | { ok: false; reason: string }
}

/**
 * Der Wächter, mit `net.isIP` als hereingereichtem Orakel.
 *
 * `vite.config.ts` ruft ihn mit `(v) => net.isIP(v)` auf; der Test benutzt
 * dieselbe Funktion, damit „was ist eine IP-Literal" auf beiden Seiten
 * dieselbe Antwort gibt.
 */
export function createSsrfPolicy(ipFamily: IpFamilyFn): SsrfPolicy {
  function isBlockedIp(ip: string): boolean {
    const family = ipFamily(ip)
    if (family === 4) return isBlockedIpv4(ip)
    if (family === 6) {
      const groups = parseIpv6Groups(ip)
      // `net.isIP` sagt 6, aber die Zerlegung scheitert: dann lieber sperren,
      // als eine Adresse durchzulassen, die niemand gelesen hat.
      return groups === null ? true : isBlockedIpv6(groups)
    }
    return false // keine IP-Literal — der Aufrufer löst auf und prüft erneut
  }

  function checkUrl(urlStr: string): UrlVerdict {
    let url: URL
    try {
      url = new URL(urlStr)
    } catch {
      return { kind: 'deny', reason: 'invalid url' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { kind: 'deny', reason: 'scheme not allowed' }
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!host) return { kind: 'deny', reason: 'no host' }
    if (host === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
      return { kind: 'deny', reason: 'blocked host' }
    }
    // Rein dezimale / 0x-hexadezimale Hosts sind inet_aton-SSRF-Schreibweisen.
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
      return { kind: 'deny', reason: 'blocked numeric host' }
    }
    if (ipFamily(host) !== 0) {
      return isBlockedIp(host) ? { kind: 'deny', reason: 'blocked ip' } : { kind: 'allow', url }
    }
    return { kind: 'resolve', url, host }
  }

  function checkResolved(
    addresses: readonly string[],
  ): { ok: true } | { ok: false; reason: string } {
    if (addresses.length === 0) return { ok: false, reason: 'dns empty' }
    for (const address of addresses) {
      if (isBlockedIp(address)) return { ok: false, reason: 'blocked resolved ip' }
    }
    return { ok: true }
  }

  return { isBlockedIp, checkUrl, checkResolved }
}
