/**
 * Der SSRF-Wächter der Dev-Proxies — die Regeln, gegen echte Adressen.
 *
 * `/local-api/proxy-image` und `/local-api/proxy-download` holen eine URL, die
 * der Aufrufer bestimmt. Im gepackten Build steht davor `validate_public_url`
 * (Rust); unter `npm run dev` steht davor nur dieser Wächter.
 *
 * Der Befund, der diese Datei ausgelöst hat: die IPv6-Hälfte prüfte auf
 * SCHREIBWEISE, nicht auf Adresse. `lc.startsWith('fe80')`, `/::ffff:…$/` —
 * das trägt nur, solange der Text schon komprimiert vorliegt. Nachgemessen:
 *
 *   - `0:0:0:0:0:ffff:127.0.0.1` ist gültiges IPv6 (`net.isIP` → 6) und
 *     erreicht nachweislich einen Server auf 127.0.0.1; keine der alten
 *     Regexen traf darauf.
 *   - `::7f00:1` (IPv4-kompatibel), `ff02::1` (Multicast) und `fec0::1`
 *     (site-local) kamen ebenfalls durch.
 *
 * Über die Proxy-Endpunkte rettete bisher der WHATWG-URL-Parser die Lage (er
 * komprimiert den Host, bevor der Wächter ihn sieht). Der Wächter läuft aber
 * AUCH über DNS-Antworten — dort normalisiert niemand. Deshalb wird hier
 * beides geprüft: `checkUrl` mit dem URL-Parser davor, und `isBlockedIp` roh,
 * so wie die DNS-Auflösung es aufruft.
 *
 * `net.isIP` ist auch im Test das Orakel, damit „ist das eine IP-Literal"
 * hier und in vite.config.ts nicht auseinanderlaufen kann.
 *
 * NEGATIVE CONTROL (von Hand geprüft):
 *   • in `isBlockedIpv6` die Zeile `if (zeroPrefix(6)) return true` entfernen
 *     → "::1", "::" und "::7f00:1" werden rot.
 *   • die `zeroPrefix(5) && groups[5] === 0xffff`-Zeile entfernen
 *     → jede IPv4-mapped-Schreibweise wird rot.
 *   • in `parseIpv6Groups` die Zeile `if (fill < 1) return null` streichen
 *     → "eine zu lange Adresse ist keine Adresse" wird rot.
 *   • in `createSsrfPolicy` `groups === null ? true` zu `false` machen
 *     → "unlesbares IPv6 wird gesperrt" wird rot.
 *
 * Run: npx vitest run src/dev/__tests__/ssrf-policy.test.ts
 */
import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { createSsrfPolicy, parseIpv6Groups } from '../ssrf-policy'

const policy = createSsrfPolicy((value) => net.isIP(value))

/** Wie `assertPublicUrl` in vite.config.ts: der Host geht durch `new URL`. */
function hostOfUrl(urlStr: string): string {
  return new URL(urlStr).hostname.replace(/^\[|\]$/g, '')
}

describe('parseIpv6Groups', () => {
  it('zerlegt die volle Schreibweise', () => {
    expect(parseIpv6Groups('2606:4700:0:0:0:0:0:1111')).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111])
  })

  it('füllt die `::`-Kompression auf', () => {
    expect(parseIpv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(parseIpv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6Groups('2606:4700::1111')).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111])
  })

  it('rechnet eine angehängte IPv4 in zwei Gruppen um', () => {
    expect(parseIpv6Groups('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    // Genau die Schreibweise, die der alte Wächter nicht sah:
    expect(parseIpv6Groups('0:0:0:0:0:ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
  })

  it('ignoriert eine Zonen-ID und die Klammern', () => {
    expect(parseIpv6Groups('[fe80::1%en0]')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
  })

  it('eine zu lange Adresse ist keine Adresse', () => {
    expect(parseIpv6Groups('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(parseIpv6Groups('1:2:3:4:5:6:7:8::9')).toBeNull()
    expect(parseIpv6Groups('1:2:3')).toBeNull()
    expect(parseIpv6Groups('::1::2')).toBeNull()
    expect(parseIpv6Groups('gggg::1')).toBeNull()
    expect(parseIpv6Groups('::ffff:999.1.1.1')).toBeNull()
  })
})

describe('isBlockedIp — IPv4', () => {
  it('sperrt, was nicht öffentlich routbar ist', () => {
    for (const ip of [
      '0.0.0.0', '10.0.0.1', '127.0.0.1', '127.1.2.3',
      '169.254.169.254', // Cloud-Metadaten
      '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '100.64.0.1', '100.127.0.1', // CGNAT
      '224.0.0.1', '255.255.255.255',
    ]) {
      expect(policy.isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('lässt öffentliche Adressen durch', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '223.255.255.255']) {
      expect(policy.isBlockedIp(ip), ip).toBe(false)
    }
  })
})

describe('isBlockedIp — IPv6', () => {
  it('sperrt Loopback und die Unspecified-Adresse in jeder Schreibweise', () => {
    for (const ip of ['::1', '::', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001']) {
      expect(policy.isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('sperrt IPv4-mapped auch ungekürzt geschrieben', () => {
    // DER BEFUND: alle drei zeigen auf 127.0.0.1, der alte Wächter sah nur
    // die ersten beiden.
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1']) {
      expect(net.isIP(ip), `${ip} muss eine gültige IPv6 sein`).toBe(6)
      expect(policy.isBlockedIp(ip), ip).toBe(true)
    }
    // ... und die Metadaten-Adresse ebenso.
    for (const ip of ['::ffff:169.254.169.254', '0:0:0:0:0:ffff:a9fe:a9fe']) {
      expect(policy.isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('sperrt IPv4-kompatible Adressen (::/96)', () => {
    // `::127.0.0.1` — abgeschafft, aber `net.isIP` sagt 6 und der alte
    // Wächter liess sie durch.
    for (const ip of ['::127.0.0.1', '::7f00:1', '::a9fe:a9fe']) {
      expect(policy.isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('sperrt link-local, ULA, site-local, NAT64 und Multicast', () => {
    for (const ip of [
      'fe80::1', 'febf::1', // fe80::/10 — der alte `startsWith('fe80')` traf febf nicht
      'fc00::1', 'fd12:3456::1', // ULA
      'fec0::1', // site-local
      '64:ff9b::1.1.1.1', // NAT64
      'ff02::1', 'ff00::1', // Multicast
    ]) {
      expect(policy.isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('lässt öffentliche IPv6-Adressen durch', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e']) {
      expect(policy.isBlockedIp(ip), ip).toBe(false)
    }
  })

  it('was nicht als IP-Literal gilt, entscheidet der Aufrufer per DNS', () => {
    expect(policy.isBlockedIp('example.com')).toBe(false)
    expect(policy.isBlockedIp('0177.0.0.1')).toBe(false) // net.isIP → 0
  })

  it('was das Orakel IPv6 nennt, muss die Zerlegung auch lesen können', () => {
    // Die Zusicherung hinter der Bauart: `net.isIP` sagt, WAS eine Adresse
    // ist, dieses Modul sagt, ob sie gesperrt ist. Ein Loch zwischen den
    // beiden wäre genau die Lücke, die der alte Wächter hatte.
    for (const ip of [
      '::', '::1', '::ffff:1.2.3.4', '0:0:0:0:0:ffff:1.2.3.4', '::127.0.0.1',
      '1:2:3:4:5:6:7:8', 'fe80::1', 'fc00::1', 'ff02::1', '64:ff9b::1.1.1.1',
      '2606:4700:4700::1111', '2001:db8::', 'a:b:c:d:e:f:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0000',
    ]) {
      expect(net.isIP(ip), ip).toBe(6)
      expect(parseIpv6Groups(ip), ip).not.toBeNull()
    }
  })

  it('unlesbares IPv6 wird gesperrt, nicht durchgewinkt', () => {
    // Sollte die Zerlegung doch einmal an einer Schreibweise scheitern, die
    // das Orakel akzeptiert, ist die Antwort "sperren". Hier lügt das Orakel
    // absichtlich, damit dieser Zweig überhaupt erreichbar ist.
    const lügendesOrakel = createSsrfPolicy(() => 6)
    expect(lügendesOrakel.isBlockedIp('gar keine adresse')).toBe(true)
    expect(lügendesOrakel.isBlockedIp('1:2:3')).toBe(true)
    expect(lügendesOrakel.checkResolved(['1:2:3'])).toEqual({ ok: false, reason: 'blocked resolved ip' })
  })
})

describe('checkUrl', () => {
  it('lehnt fremde Schemata ab', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,x']) {
      expect(policy.checkUrl(url)).toEqual({ kind: 'deny', reason: 'scheme not allowed' })
    }
  })

  it('lehnt Unlesbares ab', () => {
    expect(policy.checkUrl('nicht mal eine url')).toEqual({ kind: 'deny', reason: 'invalid url' })
  })

  it('lehnt localhost und *.localhost ab', () => {
    for (const url of ['http://localhost:8188/x', 'http://evil.localhost/x']) {
      expect(policy.checkUrl(url)).toEqual({ kind: 'deny', reason: 'blocked host' })
    }
  })

  it('lehnt inet_aton-Schreibweisen ab', () => {
    // 2130706433 === 127.0.0.1, dasselbe hexadezimal und oktal.
    // BEFUND (kein Loch, aber gut zu wissen): der WHATWG-Parser rechnet diese
    // Formen SELBST in die punktierte Notation um, bevor der Wächter den Host
    // sieht — `new URL('http://2130706433/x').hostname` ist '127.0.0.1'. Der
    // `blocked numeric host`-Zweig kann über checkUrl also nie auslösen; die
    // Ablehnung kommt aus der IP-Tabelle. Der Zweig bleibt als Netz für einen
    // Aufrufer, der isBlockedIp ohne URL-Parser davor benutzt.
    for (const url of ['http://2130706433/x', 'http://0x7f000001/x', 'http://017700000001/x', 'http://3232235777/x']) {
      expect(policy.checkUrl(url), url).toEqual({ kind: 'deny', reason: 'blocked ip' })
    }
    expect(hostOfUrl('http://2130706433/x')).toBe('127.0.0.1')
  })

  it('lehnt interne IP-Literale ab', () => {
    for (const url of [
      'http://127.0.0.1:8188/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8188/x',
      'http://[fe80::1]/x',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/x',
      'http://[::127.0.0.1]/x',
    ]) {
      expect(policy.checkUrl(url), url).toEqual({ kind: 'deny', reason: 'blocked ip' })
    }
  })

  it('lässt eine öffentliche IP direkt durch, ohne DNS', () => {
    const verdict = policy.checkUrl('https://1.1.1.1/logo.png')
    expect(verdict.kind).toBe('allow')
  })

  it('schickt einen Namen zur Auflösung', () => {
    const verdict = policy.checkUrl('https://civitai.com/api/x.png')
    expect(verdict).toMatchObject({ kind: 'resolve', host: 'civitai.com' })
  })

  it('deckt sich mit isBlockedIp auf dem Host, den der URL-Parser liefert', () => {
    // Der Parser komprimiert `[0:0:0:0:0:ffff:127.0.0.1]` zu `::ffff:7f00:1` —
    // beide Wege müssen zum selben Urteil kommen, sonst hängt der Schutz an
    // einer Normalisierung, die der DNS-Pfad nicht hat.
    const raw = 'http://[0:0:0:0:0:ffff:127.0.0.1]/x'
    expect(policy.isBlockedIp(hostOfUrl(raw))).toBe(true)
    expect(policy.isBlockedIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true)
  })
})

describe('checkResolved', () => {
  it('eine leere DNS-Antwort ist kein Freibrief', () => {
    expect(policy.checkResolved([])).toEqual({ ok: false, reason: 'dns empty' })
  })

  it('EINE interne Adresse reicht zur Ablehnung', () => {
    // DNS-Rebinding-Nachbarschaft: ein Name, der A und AAAA hat.
    expect(policy.checkResolved(['93.184.216.34', '127.0.0.1']))
      .toEqual({ ok: false, reason: 'blocked resolved ip' })
    expect(policy.checkResolved(['93.184.216.34', '0:0:0:0:0:ffff:127.0.0.1']))
      .toEqual({ ok: false, reason: 'blocked resolved ip' })
  })

  it('lässt rein öffentliche Antworten durch', () => {
    expect(policy.checkResolved(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])).toEqual({ ok: true })
  })
})
