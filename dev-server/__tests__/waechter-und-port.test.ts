/**
 * Der Wächter vor /local-api — und der Port, der ihn speist.
 *
 * ZWEI DINGE, DIE VORHER NICHT PRÜFBAR WAREN:
 *
 *  • Der Wächter (`localApiGuard`) war eine lokale Konstante im
 *    `configureServer`-Rumpf von vite.config.ts. Er ist die einzige
 *    Zugangssperre vor /local-api/shell-execute und /local-api/execute-code,
 *    und es gab keine Zeile, die sein Verhalten festhielt.
 *  • `DEV_PORT` war fest verdrahtet. Ein Modul mit fest verdrahtetem Port
 *    lässt sich kein zweites Mal starten — und was man nicht zweimal starten
 *    kann, kann man auch nicht neben einem laufenden Server prüfen.
 *
 * Run: npx vitest run dev-server/__tests__/waechter-und-port.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLocalApiGuard } from '../guard'
import { anfrage } from './echte-anfrage'

/** Der Wächter, wie dev-server/index.ts ihn baut — nur mit einem anderen Port. */
const waechter = createLocalApiGuard(5399)

/**
 * Status 599 ist die Marke der Prüfvorrichtung für „der Wächter hat `next()`
 * gerufen", also durchgereicht. In der App ginge es dort zur nächsten
 * Middleware weiter.
 */
const DURCHGEREICHT = 599

const csrf = { 'x-locally-uncensored': 'true' }
const json = { 'Content-Type': 'application/json', ...csrf }

describe('der CSRF-Header ist Pflicht', () => {
  it('weist eine POST ohne x-locally-uncensored mit 403 ab', async () => {
    const res = await anfrage(waechter, {
      method: 'POST',
      url: '/fs-read',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.text).toContain('CSRF')
  })

  it('lässt sie mit Header durch', async () => {
    const res = await anfrage(waechter, { method: 'POST', url: '/fs-read', headers: json, body: '{}' })
    expect(res.status).toBe(DURCHGEREICHT)
  })
})

describe('der Content-Type wird erzwungen', () => {
  it('weist eine POST mit text/plain mit 415 ab', async () => {
    const res = await anfrage(waechter, {
      method: 'POST',
      url: '/fs-read',
      headers: { 'Content-Type': 'text/plain', ...csrf },
      body: 'hallo',
    })
    expect(res.status).toBe(415)
    expect(res.text).toContain('application/json')
  })

  it('lässt auf /transcribe einen Audio-Körper durch (GitHub #115)', async () => {
    // Die Ausnahme TAUSCHT die Anforderung, sie lässt sie nicht weg: der Körper
    // dieses einen Endpunkts IST die Aufnahme.
    const res = await anfrage(waechter, {
      method: 'POST',
      url: '/transcribe',
      headers: { 'Content-Type': 'audio/webm', ...csrf },
      body: 'nicht-wirklich-audio',
    })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('weist auf /transcribe einen JSON-Körper ab — die Prüfung bleibt', async () => {
    const res = await anfrage(waechter, {
      method: 'POST', url: '/transcribe', headers: json, body: '{}',
    })
    expect(res.status).toBe(415)
  })
})

describe('die Origin-Prüfung', () => {
  it('lässt den eigenen Port durch', async () => {
    // Seit KF-13 tut das die Loopback-Regel, nicht ein Listeneintrag: der
    // Eintrag `http://localhost:${port}` stand hier einmal und war von der
    // Regex ohnehin gedeckt. Der Fall bleibt, weil das ERGEBNIS zählt.
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'http://localhost:5399' }, body: '{}',
    })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('lässt jeden Loopback-Port durch (Vite bindet 5274+, wenn 5273 belegt ist)', async () => {
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'http://127.0.0.1:61234' }, body: '{}',
    })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('lässt tauri://localhost durch', async () => {
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'tauri://localhost' }, body: '{}',
    })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('weist eine fremde Origin ab', async () => {
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'https://boese.example' }, body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.text).toContain('Invalid Origin')
  })

  it('lässt sich NICHT vom Host-Header überreden (DNS-Rebinding)', async () => {
    // DER BEFUND: die Liste hängte einmal `http(s)://${req.headers.host}` an,
    // damit eine Anfrage immer zu ihrem eigenen Host passt. Unter DNS-Rebinding
    // ist der Host-Header aber vom Angreifer gewählt: eine Seite auf boese.example,
    // deren DNS auf 127.0.0.1 umschwenkt, schickt Origin UND Host als
    // boese.example, die beiden stimmen überein — und die Prüfung winkte sie
    // zu /shell-execute durch. Ein Wert, den der Aufrufer mitbringt, kann den
    // Aufrufer nie autorisieren.
    const res = await anfrage(waechter, {
      method: 'POST', url: '/shell-execute',
      headers: { ...json, Origin: 'http://boese.example', Host: 'boese.example' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('lässt evil.localhost NICHT durch, obwohl Vites eigene Host-Prüfung das täte', async () => {
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'http://evil.localhost' }, body: '{}',
    })
    expect(res.status).toBe(403)
  })
})

describe('KF-13 — die Origin-Liste nennt keinen Port mehr', () => {
  /**
   * DER BEFUND: in der Liste erlaubter Origins standen `http://localhost:${port}`
   * und `http://127.0.0.1:${port}`. KEIN LOCH — beide waren von der
   * Loopback-Regex zwei Zeilen darunter ohnehin gedeckt. Aber damit hatten sie
   * am Wächter KEINE beobachtbare Wirkung, und eine wirkungslose Zeile liest
   * sich wie eine Zusicherung („nur DIESER Port"), die es nie gab.
   *
   * WIE MAN SO ETWAS ÜBERHAUPT PRÜFT. Die Entfernung ist per Konstruktion
   * verhaltensneutral — es gibt keine Anfrage, die die Liste annahm und die
   * Regex ablehnte. Eine Sonde auf ANNAHME oder ABLEHNUNG kann es hier also
   * nicht geben. Was es gibt: die Ablehnung ZÄHLT DIE LISTE AUF. Damit ist
   * ihr Inhalt beobachtbar, und der erste Fall unten ist eine echte
   * Verhaltensprobe statt eines Griffs in den Quelltext. Der zweite Fall
   * greift zusätzlich in den Quelltext, für den Fall, dass jemand die Meldung
   * umbaut — er nennt DAFÜR keinen Variablennamen, weil ein Umbenennen
   * harmlos ist und nicht rot werden darf.
   */
  const quelle = readFileSync(resolve(process.cwd(), 'dev-server/guard.ts'), 'utf8')

  it('zählt in der Ablehnung eine Liste OHNE Port auf', async () => {
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'https://boese.example' }, body: '{}',
    })
    // Alles vor dem Wort „loopback" ist die Aufzählung der festen Einträge;
    // der Port steht danach, in der Diagnose.
    const aufzaehlung = res.text.slice(0, res.text.indexOf('loopback'))
    expect(aufzaehlung).not.toContain('5399')
    // Eine Zusicherung, die nur Abwesenheit prüft, wäre auch grün, wenn die
    // Liste leer wäre.
    expect(aufzaehlung).toContain('tauri://localhost')
    expect(aufzaehlung).toContain('http://tauri.localhost')
  })

  it('interpoliert den Port in keinem Listeneintrag der Quelle', () => {
    // Eine Zeile, die mit einem Template-Literal `http://…:${port}` BEGINNT,
    // ist ein Array-Eintrag; die Diagnose steht hinter einem `+ `. Absichtlich
    // ohne den Namen der Konstante: ein Umbenennen ist harmlos.
    expect(quelle).not.toMatch(/^\s*`https?:\/\/(localhost|127\.0\.0\.1):\$\{port\}`/m)
  })

  it('die weitere Regel BLEIBT — Loopback auf einem ganz anderen Port kommt durch', async () => {
    // Verengt wurde nichts. Wer die Regex enger fasst, um die Liste wirksam zu
    // machen, bricht genau den Fall, für den sie da ist (Vite bindet 5274+,
    // wenn 5273 belegt ist — issue #51).
    for (const origin of ['http://localhost:5402', 'http://127.0.0.1:5402', 'https://localhost:1']) {
      const res = await anfrage(waechter, {
        method: 'POST', url: '/fs-read', headers: { ...json, Origin: origin }, body: '{}',
      })
      expect(res.status, origin).toBe(DURCHGEREICHT)
    }
  })

  it('nennt den echten Port in der Ablehnung — die einzige Stelle, an der er noch wirkt', async () => {
    // `port` ist keine Regel mehr, sondern die Diagnose: „Invalid Origin"
    // allein sagt nicht, was erwartet war. Diese Zusicherung ist die Sonde für
    // die eine verbliebene Wirkung des Parameters.
    const res = await anfrage(waechter, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'https://boese.example' }, body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.text).toContain('Invalid Origin')
    expect(res.text).toContain('http://localhost:5399')
    expect(res.text).toContain('loopback on ANY port')
  })

  it('nennt den Port des Wächters, den man ihm gegeben hat, und nicht 5399 aus Versehen', async () => {
    // Die Gegenprobe zur Zeile darüber: stünde die Zahl fest im Text, wäre
    // jener Fall auch grün, ohne dass der Parameter irgendetwas täte.
    const anderer = createLocalApiGuard(5402)
    const res = await anfrage(anderer, {
      method: 'POST', url: '/fs-read',
      headers: { ...json, Origin: 'https://boese.example' }, body: '{}',
    })
    expect(res.text).toContain('http://localhost:5402')
    expect(res.text).not.toContain('5399')
  })
})

describe('die GET-Ausnahme der beiden Proxies', () => {
  it('lässt GET /proxy-image ohne CSRF-Header durch (es steht in <img src>)', async () => {
    const res = await anfrage(waechter, { method: 'GET', url: '/proxy-image?url=https://x.example/a.png' })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('lässt GET /proxy-download ohne CSRF-Header durch', async () => {
    const res = await anfrage(waechter, { method: 'GET', url: '/proxy-download?url=https://x.example/a.bin' })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('macht die Ausnahme NICHT für einen anderen Endpunkt', async () => {
    const res = await anfrage(waechter, { method: 'GET', url: '/shell-execute' })
    expect(res.status).toBe(403)
  })
})

describe('der Port ist ein Parameter, kein fest verdrahteter Wert', () => {
  // Der Beweis liegt dort, wo der Port wirkt: `server.port` in der
  // Build-Konfiguration. Vorher stand da `const DEV_PORT = 5273` und sonst
  // nichts — den Server ein zweites Mal zu starten hiess, die Datei zu ändern.
  const vorher = process.env.LU_DEV_PORT

  afterEach(() => {
    if (vorher === undefined) delete process.env.LU_DEV_PORT
    else process.env.LU_DEV_PORT = vorher
  })

  /** Lädt vite.config.ts frisch, mit dem gesetzten (oder fehlenden) LU_DEV_PORT. */
  async function portAusKonfiguration(wert: string | undefined): Promise<number | undefined> {
    if (wert === undefined) delete process.env.LU_DEV_PORT
    else process.env.LU_DEV_PORT = wert
    // `resetModules` leert die Modul-Registrierung, damit vite.config.ts beim
    // nächsten `import` WIRKLICH neu ausgewertet wird — sonst käme dreimal
    // dasselbe zwischengespeicherte Objekt zurück und der Test wäre grün,
    // ohne etwas gemessen zu haben.
    vi.resetModules()
    const modul = await import('../../vite.config')
    const konfiguration = modul.default as { server?: { port?: number } }
    return konfiguration.server?.port
  }

  it('bleibt ohne LU_DEV_PORT bei 5273 — tauri.conf.json und playwright.config.ts nennen die Zahl', async () => {
    expect(await portAusKonfiguration(undefined)).toBe(5273)
  })

  it('folgt LU_DEV_PORT', async () => {
    expect(await portAusKonfiguration('5399')).toBe(5399)
  })

  it('fällt bei Unsinn auf 5273 zurück, statt auf NaN zu binden', async () => {
    expect(await portAusKonfiguration('keine-zahl')).toBe(5273)
  })
})
