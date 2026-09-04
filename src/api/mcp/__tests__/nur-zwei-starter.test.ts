/**
 * Welche Programme dieses Fenster starten darf, und dass die App es sagt.
 *
 * Der Design-Strom hat die `shell:allow-spawn`-Liste des Hauptfensters von
 * zwanzig Eintraegen auf zwei geschrumpft (Audit, 2026-09). Das ist richtig:
 * node, deno, bun, python und py nehmen alle einen Einzeiler entgegen
 * (`node -e`, `python -c`), npm/pnpm/yarn fuehren aus, was eine package.json
 * im Arbeitsverzeichnis definiert, und `docker run -v /:/host` haendigt die
 * ganze Platte aus. Mit denen in der Liste war jeder Skriptfehler in der
 * WebView Codeausfuehrung auf dem Rechner des Nutzers.
 *
 * Es hat aber eine Folge, die niemand ausgesprochen hat: wer seinen
 * MCP-Server bisher mit `node meinserver.js` oder `python -m server`
 * eingetragen hatte, dessen Server startet nach dem Update nicht mehr. Ohne
 * eigenen Satz sieht er Tauris Bereichsmeldung und sucht den Fehler bei sich.
 *
 * Hier wird beides festgehalten: dass die Liste klein bleibt, und dass die
 * Kopie im Frontend der Wahrheit in der Capability folgt.
 *
 * Run: npx vitest run src/api/mcp/__tests__/nur-zwei-starter.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MCP_STARTER, isStartableMcpCommand, notStartableMessage, MCPExternalClient,
} from '../external-client'

/** Was `Command.create` zu sehen bekam. Leer heisst: es wurde nie gerufen. */
const erzeugt: string[] = []

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (cmd: string) => {
      erzeugt.push(cmd)
      const leer = { on: () => {} }
      return {
        stdout: leer,
        stderr: leer,
        on: () => {},
        // Ein Start, der scheitert, damit der Fall hier endet und nicht in
        // einen Handshake laeuft, den diese Attrappe nicht spielt.
        spawn: async () => { throw new Error('spawn in the test harness') },
      }
    },
  },
}))

const CAP = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../src-tauri/capabilities/default.json'), 'utf8'),
) as { permissions: unknown[] }

/** Die Befehle, die `shell:allow-spawn` im Hauptfenster wirklich erlaubt. */
function erlaubteBefehle(): string[] {
  const eintrag = CAP.permissions.find(
    (p): p is { identifier: string; allow: { cmd: string }[] } =>
      typeof p === 'object' && p !== null && (p as { identifier?: string }).identifier === 'shell:allow-spawn',
  )
  expect(eintrag, 'shell:allow-spawn fehlt in der Capability').toBeDefined()
  return eintrag!.allow.map((a) => a.cmd)
}

describe('was das Hauptfenster starten darf', () => {
  it('genau zwei Programme, plus den Windows-Shim', () => {
    // Der Shim gehoert dazu, nicht als dritter Starter: unter Windows gibt es
    // npx nur als npx.cmd, und Rusts spawn findet .exe vom blanken Namen, aber
    // nie .cmd.
    expect(erlaubteBefehle().sort()).toEqual(['npx', 'npx.cmd', 'uvx'])
  })

  it('kein allgemeiner Interpreter und keine Containerlaufzeit', () => {
    // Die Negativkontrolle zur Haertung. Waechst die Liste wieder, faellt hier
    // genau der Name auf, der zurueckgekommen ist.
    const gefaehrlich = ['node', 'deno', 'bun', 'python', 'python3', 'py', 'docker', 'npm', 'pnpm', 'yarn', 'sh', 'bash', 'cmd', 'powershell']
    for (const g of gefaehrlich) {
      expect(erlaubteBefehle(), `${g} darf nicht wieder in der Liste stehen`).not.toContain(g)
    }
  })

  it('die Kopie im Frontend nennt dieselben Programme', () => {
    // Zwei Listen fuer dieselbe Sache sind das teuerste Muster im Haus. Die
    // Capability ist die Wahrheit, MCP_STARTER die Kopie fuer die Meldung, und
    // dieser Fall ist die Klammer dazwischen.
    const ohneShim = [...new Set(erlaubteBefehle().map((c) => c.replace(/\.cmd$/, '')))].sort()
    expect([...MCP_STARTER].sort()).toEqual(ohneShim)
  })
})

describe('was ein Nutzer liest, dessen Server nicht mehr startet', () => {
  it('npx und uvx gehen, mit und ohne Windows-Shim', () => {
    expect(isStartableMcpCommand('npx')).toBe(true)
    expect(isStartableMcpCommand('uvx')).toBe(true)
    expect(isStartableMcpCommand('npx.cmd')).toBe(true)
    expect(isStartableMcpCommand('NPX')).toBe(true)
    expect(isStartableMcpCommand(' npx ')).toBe(true)
  })

  it('alles andere geht nicht, und zwar vorher und nicht im Fehlschlag', () => {
    for (const c of ['node', 'python', 'docker', 'bash', '/usr/local/bin/node']) {
      expect(isStartableMcpCommand(c), c).toBe(false)
    }
  })

  it('die Meldung nennt den eigenen Eintrag und einen Weg, den es gibt', () => {
    const satz = notStartableMessage('Meine Werkzeuge', 'node server.js')
    expect(satz).toContain('Meine Werkzeuge')
    expect(satz).toContain('node server.js')
    for (const s of MCP_STARTER) expect(satz).toContain(s)
    // Und sie sagt, was man stattdessen tun kann, statt nur Nein.
    //
    // Hier stand bis zum 04.09.2026 `toContain('connect over its url')`. Der
    // Satz bot also einen URL-Anschluss an, und dieser Test hat ihn
    // festgenagelt. Es gibt ihn nicht: `MCPServerConfig` (api/mcp/types.ts)
    // kennt `command`, `args` und `env` und kein `url`, und unter api/mcp/
    // steht weder ein SSE- noch ein HTTP-Transport. Nachgemessen mit
    // `grep -rn "SSEClientTransport\|StreamableHTTP" src/api/mcp/`: leer.
    // Damit war das eine Wache, die eine Unwahrheit geschuetzt hat, und der
    // Nutzer suchte nach einem Feld, das die App nie hatte.
    //
    // Der Ersatz ist kein weicheres Kriterium, sondern ein anderes: die
    // Meldung muss ein Beispiel nennen, das wirklich startet. Der Fall
    // darunter prueft zusaetzlich, dass sie das Wort URL gar nicht mehr
    // fuehrt, solange die Konfiguration kein solches Feld hat.
    expect(satz.toLowerCase()).toContain('npx -y')
  })

  it('sie ist Englisch', () => {
    // Hausregel: Fehlermeldungen sind Englisch, egal welches System darunter
    // liegt.
    expect(notStartableMessage('x', 'y')).not.toMatch(/[äöüß]/i)
  })
})


describe('der Start wird vorher abgelehnt, nicht im Fehlschlag', () => {
  beforeEach(() => { erzeugt.length = 0 })

  const klient = (command: string) =>
    new MCPExternalClient({ id: 'x', name: 'Meine Werkzeuge', command, args: [], enabled: true })

  it('ein verbotener Befehl kommt gar nicht erst bis zum Start', async () => {
    // DIE VERDRAHTUNG. Ohne diesen Fall waren die Helfer oben gruen, waehrend
    // die App sie nie fragte, und der Nutzer sah weiter Tauris Bereichsmeldung.
    await expect(klient('node').connect()).rejects.toThrow(/only starts MCP servers/)
    expect(erzeugt, 'es wurde trotzdem ein Prozess gebaut').toEqual([])
  })

  it('und die Meldung nennt seinen eigenen Eintrag', async () => {
    await expect(klient('docker').connect()).rejects.toThrow(/docker/)
  })

  // POSITIVKONTROLLE: npx laeuft in den echten Startweg. Ohne sie ginge der
  // Fall oben auch auf einer Fassung durch, die JEDEN Server ablehnt.
  it('npx erreicht den Startweg', async () => {
    await expect(klient('npx').connect()).rejects.not.toThrow(/only starts MCP servers/)
    expect(erzeugt.length, 'npx kam nicht bis Command.create').toBeGreaterThan(0)
  })
})

describe('die Oberflaeche verspricht nur, was die App kann', () => {
  const lies = (...teile: string[]) => readFileSync(resolve(__dirname, '..', '..', '..', ...teile), 'utf8')

  it('der Platzhalter im Eingabefeld wirbt fuer kein Kommando, das nicht startet', () => {
    // Er stand seit 2.6.7 unveraendert auf "Command (e.g. npx, python)". Nach
    // der Kuerzung der Starterliste ist die Haelfte davon eine Anleitung in
    // eine Fehlermeldung: wer `python` eintippt, weil das Feld es vorschlaegt,
    // bekommt notStartableMessage. Ein Vorschlag, den die App ablehnt, ist
    // schlimmer als gar keiner.
    const ui = lies('components', 'settings', 'MCPServerSettings.tsx')
    const platzhalter = ui.match(/placeholder="Command[^"]*"/)?.[0] ?? ''
    expect(platzhalter, 'kein Command-Platzhalter gefunden').not.toBe('')
    for (const tot of ['python', 'node', 'docker', 'bun', 'deno']) {
      expect(platzhalter, `der Platzhalter schlaegt ${tot} vor, das startet nicht mehr`)
        .not.toContain(tot)
    }
  })

  it('die Fehlermeldung nennt keinen Ausweg, den es nicht gibt', () => {
    // Sie endete auf "or run it yourself and connect over its URL". Es gibt
    // keinen URL-Weg: MCPServerConfig (api/mcp/types.ts) kennt nur command,
    // args und env, und unter api/mcp/ steht kein SSE- und kein
    // HTTP-Transport. Der Satz schickte den Nutzer also in eine Sackgasse und
    // liess ihn dort nach einem Feld suchen, das die App nie hatte.
    const typen = lies('api', 'mcp', 'types.ts')
    const hatUrlFeld = /\burl\??\s*:/.test(typen)
    const satz = notStartableMessage('demo', 'node server.js')
    if (!hatUrlFeld) {
      expect(satz, 'die Meldung verspricht einen URL-Weg, den die Konfiguration nicht kennt')
        .not.toMatch(/url/i)
    }
    // Dass sie den Befehl und die zwei Starter nennt, prueft der Fall
    // "die Meldung nennt den eigenen Eintrag und einen Weg, den es gibt"
    // weiter oben. Hier geht es allein um den Weg, den es NICHT gibt.
  })
})
