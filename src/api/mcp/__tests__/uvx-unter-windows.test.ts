/**
 * MCP-Server mit uvx unter Windows (Discord help-chat, kjraidse32, 27.10.2026:
 * "program not allowed on the configured shell scope: uvx.cmd").
 *
 * Zwei Fehler steckten darin. Der Startweg probierte nach `uvx` den Namen
 * `uvx.cmd`, den `shell:allow-spawn` nicht kannte. Und weil nur der LETZTE
 * Fehlversuch geworfen wurde, sah der Nutzer diese Bereichsablehnung statt des
 * echten Grundes: uvx wurde unter dem PATH, mit dem LU lief, nicht gefunden.
 *
 * uv liefert unter Windows `uvx.exe` (docs.astral.sh/uv, Installation:
 * `rm $HOME\.local\bin\uvx.exe`), nie ein `.cmd`. Der blanke Name genuegt also,
 * sobald der Ordner im PATH steht; der Shim und der feste Installer-Ort sind
 * Rueckfaelle fuer denselben uvx.
 *
 * Run: npx vitest run src/api/mcp/__tests__/uvx-unter-windows.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Die Scope-Namen, die die Capability kennt, mit ihrem Programm. */
const CAP = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../src-tauri/capabilities/default.json'), 'utf8'),
) as { permissions: unknown[] }
const SCOPE: { name: string; cmd: string }[] = (CAP.permissions.find(
  (p) => typeof p === 'object' && p !== null && (p as { identifier?: string }).identifier === 'shell:allow-spawn',
) as { allow: { name: string; cmd: string }[] }).allow

/** Welche Scope-Namen auf diesem gespielten Rechner wirklich ein Programm finden. */
let vorhanden = new Set<string>()
const versucht: string[] = []

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    // So verhaelt sich tauri-plugin-shell 2.3: ein Name ausserhalb des Scopes
    // wird abgelehnt, ein erlaubter, dessen Programm fehlt, scheitert in Rusts
    // spawn mit "program not found".
    create: (name: string) => {
      const leer = { on: () => {} }
      return {
        stdout: leer,
        stderr: leer,
        on: () => {},
        spawn: async () => {
          versucht.push(name)
          if (!SCOPE.some((e) => e.name === name)) {
            throw `program not allowed on the configured shell scope: ${name}`
          }
          if (!vorhanden.has(name)) throw 'program not found'
          // Gestartet. Der Handshake danach ist nicht Gegenstand dieses Tests:
          // write scheitert, und der Fall endet mit einem anderen Fehler.
          return { pid: 1, write: async () => { throw new Error('handshake not played here') }, kill: async () => {} }
        },
      }
    },
  },
}))

import { MCPExternalClient, commandCandidatesForPlatform, spawnFailureMessage } from '../external-client'

const klient = () =>
  new MCPExternalClient({ id: 'time', name: 'time', command: 'uvx', args: ['mcp-server-time==2026.8.18'], enabled: true })

beforeEach(() => {
  versucht.length = 0
  vorhanden = new Set()
  vi.stubGlobal('navigator', { platform: 'Win32' })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('jeder Name, den der Startweg probiert, steht im Scope', () => {
  it.each(['uvx', 'npx'])('%s unter Windows', (cmd) => {
    for (const name of commandCandidatesForPlatform(cmd, 'Win32')) {
      expect(SCOPE.map((e) => e.name), `${name} fehlt in shell:allow-spawn`).toContain(name)
    }
  })

  it('und jeder uvx-Eintrag startet uvx, nichts anderes', () => {
    // Die Erlaubnisliste wird breiter, nicht weicher: drei Eintraege, ein
    // Programm. Ein vierter mit anderem Programmnamen faellt hier auf.
    for (const e of SCOPE.filter((x) => x.name.startsWith('uvx'))) {
      expect(e.cmd.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe)$/, ''), e.name).toBe('uvx')
    }
    expect(SCOPE.find((e) => e.name === 'uvx-local-bin')?.cmd).toBe('$HOME/.local/bin/uvx.exe')
  })
})

describe('was der Nutzer liest', () => {
  it('fehlt uv ganz, steht da, wie man es bekommt, und keine Bereichsmeldung', async () => {
    const err = await klient().connect().catch((e: Error) => e)
    expect(versucht).toEqual(['uvx', 'uvx.cmd', 'uvx-local-bin'])
    expect(String(err)).not.toMatch(/shell scope/)
    expect(String(err)).toMatch(/`uvx` was not found/)
    expect(String(err)).toContain('docs.astral.sh/uv')
  })

  it('der offizielle Installer-Ort wird gefunden, wenn der PATH alt ist', async () => {
    vorhanden = new Set(['uvx-local-bin'])
    const err = await klient().connect().catch((e: Error) => e)
    expect(versucht.at(-1)).toBe('uvx-local-bin')
    expect(String(err)).toMatch(/handshake not played here/)
  })

  it('ein uvx.cmd-Shim startet auch', async () => {
    vorhanden = new Set(['uvx.cmd'])
    const err = await klient().connect().catch((e: Error) => e)
    expect(versucht).toEqual(['uvx', 'uvx.cmd'])
    expect(String(err)).toMatch(/handshake not played here/)
  })

  it('ein anderer echter Fehler wird nicht zur Installationsanleitung', () => {
    const satz = spawnFailureMessage('uvx', ['Access is denied. (os error 5)', 'program not found'])
    expect(satz).toBe('Access is denied. (os error 5)')
  })

  it('auf dem Mac bleibt es beim blanken Namen', () => {
    expect(commandCandidatesForPlatform('uvx', 'MacIntel')).toEqual(['uvx'])
  })
})
