/**
 * Was der Nutzer kopiert, und was ihn davor bewahrt, sich selbst auszusperren.
 *
 * Die drei Dinge, die hier wirklich schiefgehen koennen, sind keine Logik,
 * sondern Zeichenketten und Zahlen: eine Adresse, die im Client nicht
 * funktioniert; ein Port, der jemand anderem gehoert; ein Start ohne Token.
 * Alle drei kosten den Nutzer Zeit an einer Stelle, an der er keine Diagnose
 * hat — sein Client sagt nur "connection refused".
 */
import { describe, it, expect } from 'vitest'
import {
  localApiBaseUrl, pruefePort, curlBeispiel, clientFelder, reichweiteText,
  kannStarten, LOCAL_API_DEFAULT_PORT, BELEGTE_PORTS, parseCorsOrigins, corsText,
} from '../local-api'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

describe('Die Adresse zum Kopieren', () => {
  it('localhost nennt 127.0.0.1 und den Port', () => {
    expect(localApiBaseUrl(8129, false)).toBe('http://127.0.0.1:8129/v1')
  })

  it('LAN nennt NIE 0.0.0.0', () => {
    // 0.0.0.0 ist die Bindeadresse des Servers, keine Adresse, unter der ein
    // anderes Geraet ihn erreicht. Steht sie im Client, bekommt der Nutzer
    // "connection refused" und keinen Hinweis, warum.
    const mit = localApiBaseUrl(8129, true, '192.168.0.42')
    const ohne = localApiBaseUrl(8129, true)
    expect(mit).toBe('http://192.168.0.42:8129/v1')
    expect(ohne).not.toContain('0.0.0.0')
    expect(ohne).toContain('<IP-dieses-Rechners>')
  })

  it('endet immer auf /v1, weil Clients das anhaengen erwarten', () => {
    for (const u of [localApiBaseUrl(1, false), localApiBaseUrl(2, true, 'x')]) {
      expect(u.endsWith('/v1')).toBe(true)
    }
  })
})

describe('Der Port', () => {
  it('die Vorgabe ist frei und passt zur Rust-Seite', () => {
    expect(pruefePort(LOCAL_API_DEFAULT_PORT)).toEqual({ ok: true })
    // Die eine Zahl, die an zwei Orten stehen MUSS. Laufen sie auseinander,
    // startet der Server woanders, als die Oberflaeche behauptet.
    const rust = readFileSync(resolve(here, '../../../src-tauri/src/commands/local_api.rs'), 'utf8')
    const m = /DEFAULT_LOCAL_API_PORT: u16 = (\d+)/.exec(rust)
    expect(m, 'DEFAULT_LOCAL_API_PORT steht nicht mehr wie erwartet in local_api.rs').not.toBeNull()
    expect(Number(m![1])).toBe(LOCAL_API_DEFAULT_PORT)
  })

  it('nennt beim Namen, wem ein belegter Port gehoert', () => {
    // "Port belegt" hilft niemandem. "Port 11434 gehoert Ollama" beendet die
    // Suche sofort.
    const u = pruefePort(11434)
    expect(u.ok).toBe(false)
    expect(u.ok === false && u.grund).toContain('Ollama')
  })

  it('kennt jeden Port, den diese App selbst aufmacht', () => {
    // Wenn hier einer fehlt, kann der Nutzer sich auf einen Dienst setzen,
    // den die App gleich danach selbst starten will.
    for (const p of [8127, 11434, 11435, 8188, 1234]) {
      expect(Object.keys(BELEGTE_PORTS).map(Number)).toContain(p)
    }
  })

  it('weist zurueck, was gar nicht binden kann', () => {
    expect(pruefePort(80).ok).toBe(false)
    expect(pruefePort(70000).ok).toBe(false)
    expect(pruefePort(8129.5).ok).toBe(false)
  })
})

describe('Der Start', () => {
  it('ohne Token gar nicht', () => {
    // Dieselbe Regel wie in Rust (`start_local_api` weist leeres Token ab).
    // Sie steht hier ein zweites Mal, damit die Oberflaeche den Knopf
    // ausgraut, statt in einen Fehler zu laufen.
    const u = kannStarten('   ', LOCAL_API_DEFAULT_PORT)
    expect(u.ok).toBe(false)
    expect(u.ok === false && u.grund).toContain('Token')
  })

  it('mit Token und freiem Port ja', () => {
    expect(kannStarten('abc', LOCAL_API_DEFAULT_PORT)).toEqual({ ok: true })
  })

  it('mit Token, aber fremdem Port nein', () => {
    expect(kannStarten('abc', 11434).ok).toBe(false)
  })
})

describe('Was der Nutzer angezeigt bekommt', () => {
  it('der Beispielaufruf ist vollstaendig und einfuegefertig', () => {
    const b = curlBeispiel('http://127.0.0.1:8129/v1', 'geheim', 'ollama/smollm2:135m')
    expect(b).toContain('http://127.0.0.1:8129/v1/chat/completions')
    expect(b).toContain('Authorization: Bearer geheim')
    // Kein Platzhalter, den der Nutzer erst ersetzen muss — sonst kopiert er
    // einen Befehl, der mit 401 antwortet.
    expect(b).not.toContain('$')
    expect(b).not.toContain('YOUR_')
    expect(b).toContain('"model":"ollama/smollm2:135m"')
  })

  it('die zwei Felder, nach denen jeder Client fragt', () => {
    const f = clientFelder('http://127.0.0.1:8129/v1', 'geheim')
    expect(f.map((x) => x.feld)).toEqual(['Base URL', 'API Key'])
    expect(f[1].wert).toBe('geheim')
  })

  it('der LAN-Hinweis sagt, wer wirklich gemeint ist', () => {
    // "andere Geraete" ist hoeflich und falsch. Es ist jedes Geraet im Netz,
    // und in einem WLAN mit Gaesten sind das fremde.
    expect(reichweiteText(true)).toContain('Gaeste')
    expect(reichweiteText(false)).toContain('Nur Programme auf diesem Rechner')
  })
})

// ── CORS-Erlaubnisliste ─────────────────────────────────────────────────────
//
// Aus dem Kunden-Testbericht vom 02.09.2026, Fund 3. Die Liste ist eine
// Sicherheitsentscheidung; sie gehoert deshalb hierher und nicht in ein `.tsx`,
// das kein Test dieses Hauses je rendert.

describe('die CORS-Liste laesst nur herein, was benannt wurde', () => {
  it('nimmt Herkuenfte, entdoppelt und normalisiert', () => {
    expect(parseCorsOrigins('http://localhost:3000')).toEqual(['http://localhost:3000'])
    // Komma, Leerzeichen und Zeilenumbruch trennen alle gleich.
    expect(parseCorsOrigins('http://localhost:3000, https://app.example\nhttp://127.0.0.1:8080'))
      .toEqual(['http://localhost:3000', 'https://app.example', 'http://127.0.0.1:8080'])
    // Gross/klein ist bei Hostnamen bedeutungslos, doppelt ist doppelt.
    expect(parseCorsOrigins('http://LOCALHOST:3000 http://localhost:3000'))
      .toEqual(['http://localhost:3000'])
  })

  it('der Platzhalter faellt weg, statt alles zu oeffnen', () => {
    // Dieselbe Entscheidung wie in cors_erlaubt() in local_api.rs. Hier faellt
    // er schon beim Tippen weg, damit niemand einen Eintrag stehen sieht, der
    // nichts bewirkt.
    expect(parseCorsOrigins('*')).toEqual([])
    expect(parseCorsOrigins('* http://localhost:3000')).toEqual(['http://localhost:3000'])
  })

  it('was keine Herkunft ist, kommt nicht in die Liste', () => {
    // Ein Eintrag mit Pfad trifft NIE zu — der Browser sendet nur Schema, Host
    // und Port. Ihn anzunehmen hiesse, dem Nutzer eine Freigabe vorzuspielen.
    expect(parseCorsOrigins('http://localhost:3000/app')).toEqual([])
    expect(parseCorsOrigins('http://localhost:3000?x=1')).toEqual([])
    expect(parseCorsOrigins('http://user:pw@localhost:3000')).toEqual([])
    expect(parseCorsOrigins('localhost:3000')).toEqual([])
    expect(parseCorsOrigins('file:///etc/passwd')).toEqual([])
    expect(parseCorsOrigins('javascript:alert(1)')).toEqual([])
    expect(parseCorsOrigins('')).toEqual([])
  })

  it('der Satz unter dem Feld sagt den Zustand, nicht die Zahl allein', () => {
    expect(corsText([])).toContain('Closed')
    expect(corsText([])).toContain('unaffected')
    expect(corsText(['http://localhost:3000'])).toBe('Open to http://localhost:3000 only.')
    expect(corsText(['a', 'b'])).toContain('2 origins')
  })
})
