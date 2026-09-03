/**
 * Der Pin und die Weiterleitungskette — gegen ECHTE Server, nicht gegen eine
 * Attrappe.
 *
 * ZWEI BEFUNDE STEHEN HIER DRIN:
 *
 *  • DAS REBIND-FENSTER (Lücke 3). `assertPublicUrl` in vite.config.ts löste
 *    den Namen auf, prüfte die Adressen und warf sie weg; der `http.get`
 *    daneben löste denselben Namen ERNEUT auf. Ein Resolver, der der Prüfung
 *    eine öffentliche Adresse und dem Verbindungsaufbau `127.0.0.1` gibt, kam
 *    durch. Rust hat die Stelle zu (`pinned_client` / `resolve_to_addrs`,
 *    proxy.rs:290). `createPinnedLookup` ist der Port davon.
 *  • DIE KETTE (Lücke 4). Dass jeder Sprung geprüft wird, war nur durch
 *    Codelesen belegt — drei handgeschriebene Schleifen, eine davon
 *    (`proxy-image`) prüfte überhaupt nur EINEN Sprung weit. Hier läuft die
 *    echte Schleife (`ssrfSafeGet`) gegen echte `http.Server`, mit echten
 *    Sockets und echten 302-Antworten.
 *
 * WAS ECHT IST UND WAS NICHT — die einzige Ersetzung, offen benannt:
 *   • ECHT: die Server, die Sockets, die Weiterleitungen, `http.get`, die
 *     Regeln aus `createSsrfPolicy`, `net.isIP` für den Pin, die
 *     Schleife selbst.
 *   • ERSETZT: die DNS-Antwort (kein Test kann einen DNS-Eintrag setzen —
 *     `resolveHost` ist genau dafür der hereingereichte Seam) und EIN Punkt im
 *     Orakel: der Wächter bekommt für die Adresse `::1` gesagt, sie sei keine
 *     IP-Literal. Ohne das könnte der ERSTE Sprung nie stattfinden — die
 *     Regeln sperren jede Adresse, die ein Test binden kann, das ist ihr Sinn.
 *     Der Kunstgriff ist auf diese eine Zeichenkette begrenzt (unten
 *     zugesichert); JEDES Sprungziel geht durch das unveränderte `net.isIP`,
 *     und der Pin benutzt ohnehin nur das echte Orakel.
 *
 * WARUM DER EINSTIEG EIN NAME OHNE DNS-EINTRAG IST (`hop0.test`): damit der
 * Test nicht behaupten muss, dass gepinnt wird, sondern es braucht. Ohne den
 * Pin kann Node diesen Namen nicht auflösen, und JEDER Fall hier scheitert mit
 * ENOTFOUND.
 *
 * MUTATIONSSONDEN (von Hand geprüft):
 *   • in `ssrfSafeGet` die Zeile `lookup: createPinnedLookup(…)` aus `options`
 *     entfernen → alle Fälle mit echtem Server werden rot (ENOTFOUND
 *     hop0.test): die Verbindung hängt wieder am Namen statt an der geprüften
 *     Adresse.
 *   • in `ssrfSafeGet` `const target = await checkPublicUrl(current, deps)` aus
 *     der Schleife heraus davor ziehen (nur der erste Sprung wird geprüft) →
 *     „169.254.169.254", „127.0.0.1", „IPv4-mapped" und „per DNS" werden rot,
 *     und der gesperrte Server zählt Treffer.
 *   • in `createPinnedLookup` `if (matching.length === 0)` durch ein
 *     Weiterreichen an den echten Resolver ersetzen → „ohne passende Familie
 *     kommt ein Fehler" wird rot.
 *
 * Run: npx vitest run src/dev/__tests__/ssrf-fetch.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createSsrfPolicy } from '../ssrf-policy'
import {
  createPinnedLookup,
  SsrfBlockedError,
  ssrfSafeGet,
  type SsrfFetchDeps,
} from '../ssrf-fetch'

// ── Echte Server ───────────────────────────────────────────────────────────

interface TestServer {
  port: number
  /** Jeder Pfad, den dieser Server tatsächlich zu sehen bekommen hat. */
  treffer: string[]
  /** Der `Host`-Header des letzten Requests — für die SNI-/Host-Zusicherung. */
  letzterHost: string | undefined
}

const server: http.Server[] = []

async function starte(
  adresse: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse, s: TestServer) => void,
): Promise<TestServer> {
  const s: TestServer = { port: 0, treffer: [], letzterHost: undefined }
  const srv = http.createServer((req, res) => {
    s.treffer.push(req.url ?? '')
    s.letzterHost = req.headers.host
    handler(req, res, s)
  })
  server.push(srv)
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, adresse, resolve)
  })
  s.port = (srv.address() as AddressInfo).port
  return s
}

/** Der Server, auf den weitergeleitet wird und der NIE erreicht werden darf. */
let gesperrt: TestServer
/** Der Einstieg: leitet je nach Pfad woandershin weiter. */
let hop0: TestServer
/** Ein zweiter erlaubter Sprung, damit „folgt überhaupt" belegt ist. */
let hop1: TestServer

beforeAll(async () => {
  gesperrt = await starte('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('GEHEIM')
  })
  hop1 = await starte('::1', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('HOP1-ZIEL')
  })
  hop0 = await starte('::1', (req, res) => {
    const ziel: Record<string, string> = {
      '/nach-loopback': `http://127.0.0.1:${gesperrt.port}/geheim`,
      '/nach-metadaten': 'http://169.254.169.254/latest/meta-data/',
      '/nach-mapped': `http://[0:0:0:0:0:ffff:127.0.0.1]:${gesperrt.port}/geheim`,
      '/nach-rebind': `http://rebind.test:${gesperrt.port}/geheim`,
      '/nach-hop1': `http://hop1.test:${hop1.port}/ziel`,
    }
    const location = ziel[req.url ?? '']
    if (location) {
      res.writeHead(302, { Location: location })
      res.end('umgeleitet')
      return
    }
    if (req.url === '/relativ') {
      res.writeHead(302, { Location: '/ende' })
      res.end('umgeleitet')
      return
    }
    if (req.url === '/karussell') {
      res.writeHead(302, { Location: '/karussell' })
      res.end('umgeleitet')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('HOP0-ENDE')
  })
})

afterAll(async () => {
  await Promise.all(
    server.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve()))),
  )
})

// ── Der Wächter, wie der Test ihn baut ─────────────────────────────────────

/** Die EINE Adresse, für die das Orakel des Wächters blind gemacht wird. */
const BLIND = '::1'

/**
 * `net.isIP`, aber `::1` gilt für die REGELN nicht als IP-Literal.
 *
 * Der Pin bekommt dieses Orakel NICHT (`deps.ipFamily` unten ist das echte),
 * und jede andere Adresse — auch jedes Sprungziel — geht durch `net.isIP`.
 */
const policyOrakel = (wert: string): number => (wert === BLIND ? 0 : net.isIP(wert))

/** Die Namen, die der Test „auflöst". Echte DNS-Einträge kann er nicht setzen. */
function dnsAntwort(host: string): string[] {
  const tabelle: Record<string, string[]> = {
    'hop0.test': [BLIND],
    'hop1.test': [BLIND],
    // Die rohe, unkomprimierte Schreibweise — genau die Form, die über eine
    // DNS-Antwort kommt und die kein URL-Parser vorher normalisiert.
    'rebind.test': ['0:0:0:0:0:ffff:127.0.0.1'],
  }
  const antwort = tabelle[host]
  if (!antwort) {
    const err: Error & { code?: string } = new Error(`getaddrinfo ENOTFOUND ${host}`)
    err.code = 'ENOTFOUND'
    throw err
  }
  return antwort
}

function deps(): SsrfFetchDeps<http.IncomingMessage> {
  return {
    policy: createSsrfPolicy(policyOrakel),
    // Der Pin rechnet mit dem ECHTEN Orakel.
    ipFamily: (wert) => net.isIP(wert),
    resolveHost: async (host) => dnsAntwort(host),
    getter: (protocol) => {
      expect(protocol, 'der Test spricht nur http').toBe('http:')
      return (url, options, callback) => http.get(url, options, callback)
    },
  }
}

/** Den Rumpf einer Antwort einsammeln. */
async function rumpf(response: http.IncomingMessage): Promise<string> {
  const teile: Buffer[] = []
  for await (const stueck of response) teile.push(stueck as Buffer)
  return Buffer.concat(teile).toString()
}

// ── Der Kunstgriff, eingegrenzt ────────────────────────────────────────────

describe('was dieser Test am Wächter ersetzt', () => {
  it('ist genau eine Adresse, und keine der gesperrten', () => {
    expect(policyOrakel(BLIND)).toBe(0)
    for (const adresse of [
      '127.0.0.1', '169.254.169.254', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:7f00:1',
      '10.0.0.1', '192.168.1.50', 'fe80::1', '::', '::2', '0:0:0:0:0:0:0:1',
    ]) {
      expect(policyOrakel(adresse), adresse).toBe(net.isIP(adresse))
    }
  })

  it('lässt die Regeln für jedes Sprungziel unverändert gelten', () => {
    const policy = createSsrfPolicy(policyOrakel)
    expect(policy.isBlockedIp('127.0.0.1')).toBe(true)
    expect(policy.isBlockedIp('169.254.169.254')).toBe(true)
    expect(policy.isBlockedIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true)
    // Und das echte Orakel sperrt auch die blind gemachte Adresse weiter.
    expect(createSsrfPolicy((v) => net.isIP(v)).isBlockedIp(BLIND)).toBe(true)
  })
})

// ── Der Pin ────────────────────────────────────────────────────────────────

describe('createPinnedLookup', () => {
  const echt = (wert: string): number => net.isIP(wert)

  it('gibt nur die geprüfte Adresse zurück, in beiden Aufrufformen', () => {
    const lookup = createPinnedLookup(['203.0.113.7'], echt)
    let einzeln: unknown[] = []
    lookup('egal.example', {}, (err, address, family) => {
      einzeln = [err, address, family]
    })
    expect(einzeln).toEqual([null, '203.0.113.7', 4])

    let alle: unknown = null
    lookup('egal.example', { all: true }, (err, address) => {
      expect(err).toBeNull()
      alle = address
    })
    expect(alle).toEqual([{ address: '203.0.113.7', family: 4 }])
  })

  it('achtet auf die verlangte Familie — in beiden Schreibweisen', () => {
    const lookup = createPinnedLookup(['203.0.113.7', '2001:db8::1'], echt)
    const nimm = (options: { family?: number | string }): unknown => {
      let out: unknown = null
      lookup('egal.example', options, (_err, address) => { out = address })
      return out
    }
    expect(nimm({ family: 4 })).toBe('203.0.113.7')
    expect(nimm({ family: 6 })).toBe('2001:db8::1')
    expect(nimm({ family: 'IPv6' })).toBe('2001:db8::1')
    expect(nimm({})).toBe('203.0.113.7')
  })

  it('antwortet mit einem Fehler statt mit einer ungeprüften Adresse', () => {
    // Bleibt nach dem Familienfilter nichts übrig, darf hier KEINE frische
    // Auflösung entstehen — eine Adresse, die niemand geprüft hat, ist genau
    // das, was der Pin verhindert.
    const lookup = createPinnedLookup(['203.0.113.7'], echt)
    let fehler: (Error & { code?: string }) | null = null
    lookup('egal.example', { family: 6 }, (err) => { fehler = err as Error & { code?: string } })
    expect(fehler).toBeInstanceOf(Error)
    expect(fehler!.code).toBe('ENOTFOUND')

    // Dasselbe, wenn gar nichts freigegeben wurde.
    let leer: Error | null = null
    createPinnedLookup([], echt)('egal.example', {}, (err) => { leer = err })
    expect(leer).toBeInstanceOf(Error)
  })

  it('bringt eine echte Verbindung an einen Namen OHNE DNS-Eintrag', async () => {
    // Der Beweis, dass der Pin die Verbindung bestimmt und nicht der Name:
    // `gepinnt.invalid` ist per RFC 2606 garantiert nicht auflösbar. Ohne
    // `lookup` endet dieser Aufruf mit ENOTFOUND.
    const antwort = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(
          `http://gepinnt.invalid:${hop1.port}/ziel`,
          { lookup: createPinnedLookup([BLIND], echt) },
          resolve,
        )
        .on('error', reject)
    })
    expect(antwort.statusCode).toBe(200)
    expect(await rumpf(antwort)).toBe('HOP1-ZIEL')
    // Host-Header (und damit auch SNI bei https) behalten den NAMEN — gepinnt
    // ist nur das Ziel der Verbindung, wie bei Rusts `resolve_to_addrs`.
    expect(hop1.letzterHost).toBe(`gepinnt.invalid:${hop1.port}`)
  })
})

// ── Die Kette ──────────────────────────────────────────────────────────────

describe('ssrfSafeGet gegen echte Server', () => {
  it('holt eine erlaubte Antwort — über die gepinnte Adresse', async () => {
    const { response, url } = await ssrfSafeGet(`http://hop0.test:${hop0.port}/ende`, {}, deps())
    expect(response.statusCode).toBe(200)
    expect(await rumpf(response)).toBe('HOP0-ENDE')
    expect(url).toBe(`http://hop0.test:${hop0.port}/ende`)
    // Der Server hat den Request wirklich gesehen, unter seinem Namen.
    expect(hop0.treffer).toContain('/ende')
    expect(hop0.letzterHost).toBe(`hop0.test:${hop0.port}`)
  })

  it('folgt einer Weiterleitung auf einen erlaubten Sprung', async () => {
    const { response } = await ssrfSafeGet(`http://hop0.test:${hop0.port}/nach-hop1`, {}, deps())
    expect(response.statusCode).toBe(200)
    expect(await rumpf(response)).toBe('HOP1-ZIEL')
    expect(hop1.treffer).toContain('/ziel')
  })

  it('löst eine relative Weiterleitung gegen den aktuellen Sprung auf', async () => {
    const { response } = await ssrfSafeGet(`http://hop0.test:${hop0.port}/relativ`, {}, deps())
    expect(await rumpf(response)).toBe('HOP0-ENDE')
  })

  it('greift beim SPRUNG auf 127.0.0.1 — und der Server dahinter merkt nichts', async () => {
    const vorher = gesperrt.treffer.length
    await expect(
      ssrfSafeGet(`http://hop0.test:${hop0.port}/nach-loopback`, {}, deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    // Der erste Sprung IST passiert — sonst wäre nicht der Sprung geprüft
    // worden, sondern nur die Erst-URL.
    expect(hop0.treffer).toContain('/nach-loopback')
    // Und der gesperrte Server hat nie einen Request gesehen.
    expect(gesperrt.treffer.length).toBe(vorher)
  })

  it('greift beim SPRUNG auf 169.254.169.254 (Cloud-Metadaten)', async () => {
    await expect(
      ssrfSafeGet(`http://hop0.test:${hop0.port}/nach-metadaten`, {}, deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(hop0.treffer).toContain('/nach-metadaten')
  })

  it('greift beim SPRUNG auf eine IPv4-mapped IPv6-Adresse', async () => {
    // `0:0:0:0:0:ffff:127.0.0.1` im Location-Header. Der URL-Parser komprimiert
    // ihn zu `::ffff:7f00:1`; entschieden wird auf den Zahlen, nicht auf der
    // Schreibweise.
    const vorher = gesperrt.treffer.length
    await expect(
      ssrfSafeGet(`http://hop0.test:${hop0.port}/nach-mapped`, {}, deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(hop0.treffer).toContain('/nach-mapped')
    expect(gesperrt.treffer.length).toBe(vorher)
  })

  it('greift, wenn erst die DNS-ANTWORT des Sprungziels auf Loopback zeigt', async () => {
    // Der Fall ohne Normalisierer: `rebind.test` löst auf die rohe Schreibweise
    // `0:0:0:0:0:ffff:127.0.0.1` auf. Hier steht kein URL-Parser dazwischen —
    // genau die Stelle, an der die alte Schreibweisen-Prüfung durchgefallen ist.
    const vorher = gesperrt.treffer.length
    await expect(
      ssrfSafeGet(`http://hop0.test:${hop0.port}/nach-rebind`, {}, deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(hop0.treffer).toContain('/nach-rebind')
    expect(gesperrt.treffer.length).toBe(vorher)
  })

  it('lehnt die Erst-URL weiterhin ab, wenn sie selbst gesperrt ist', async () => {
    // Die Gegenprobe zur Sprungprüfung: das erste Tor steht noch.
    const vorher = gesperrt.treffer.length
    await expect(
      ssrfSafeGet(`http://127.0.0.1:${gesperrt.port}/geheim`, {}, deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(gesperrt.treffer.length).toBe(vorher)
  })

  it('hört nach `maxHops` Sprüngen auf', async () => {
    const fehler = await ssrfSafeGet(
      `http://hop0.test:${hop0.port}/karussell`,
      { maxHops: 2 },
      deps(),
    ).catch((e: unknown) => e)
    expect(fehler).toBeInstanceOf(Error)
    expect((fehler as Error).message).toBe('Too many redirects')
    expect(fehler).not.toBeInstanceOf(SsrfBlockedError)
  })

  it('unterscheidet gesperrt von nicht erreichbar', async () => {
    // 403 gegen 502 in den Middlewares hängt genau an dieser Unterscheidung.
    const fehler = await ssrfSafeGet('http://unbekannt.test/', {}, deps()).catch(
      (e: unknown) => e,
    )
    expect(fehler).toBeInstanceOf(Error)
    expect(fehler).not.toBeInstanceOf(SsrfBlockedError)
  })

  it('reicht die Kopfzeilen des Aufrufers an jeden Sprung durch', async () => {
    const { response } = await ssrfSafeGet(
      `http://hop0.test:${hop0.port}/ende`,
      { headers: { 'User-Agent': 'LU-Test/1.0' } },
      deps(),
    )
    expect(response.statusCode).toBe(200)
    response.resume()
  })
})
