/**
 * Ein Mac-LU aus dem Finder hat den launchd-PATH, und ein installiertes uvx in
 * ~/.local/bin wurde nicht gefunden: im gebauten Testbau am 28.10.2026 kam
 * "`uvx` was not found", obwohl uv dort lag. REA bekam den PATH der
 * Login-Shell schon, jeder andere Server nicht. Jetzt startet jeder Server mit
 * dem PATH, den `mcp_child_path` liefert, ausser der Nutzer hat selbst einen
 * eingetragen.
 *
 * Run: npx vitest run src/api/mcp/__tests__/ein-finder-start-findet-uvx.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOGIN_PATH = '/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin'
const gestartet: { name: string; env?: Record<string, string> }[] = []
let antwort: string | null = LOGIN_PATH

vi.mock('../../in-tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'mcp_child_path') return antwort
    throw new Error(`unexpected ${cmd}`)
  },
}))
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (name: string, _args: string[], opts: { env?: Record<string, string> }) => {
      gestartet.push({ name, env: opts.env })
      const leer = { on: () => {} }
      return { stdout: leer, stderr: leer, on: () => {}, spawn: async () => { throw 'program not found' } }
    },
  },
}))

import { MCPExternalClient, spawnEnv } from '../external-client'

beforeEach(() => { gestartet.length = 0; antwort = LOGIN_PATH; vi.stubGlobal('navigator', { platform: 'MacIntel' }) })

describe('ein MCP-Server startet mit dem PATH der Login-Shell', () => {
  it('der Start bekommt ihn', async () => {
    const k = new MCPExternalClient({ id: 't', name: 'time', command: 'uvx', args: ['mcp-server-time==2026.8.18'], enabled: true })
    await k.connect().catch(() => {})
    expect(gestartet).toHaveLength(1)
    expect(gestartet[0].env?.PATH).toBe(LOGIN_PATH)
  })

  it('andere Variablen des Eintrags bleiben', async () => {
    expect(await spawnEnv({ TZ: 'Asia/Tokyo' })).toEqual({ TZ: 'Asia/Tokyo', PATH: LOGIN_PATH })
  })

  it('ein selbst eingetragener PATH bleibt seiner', async () => {
    expect(await spawnEnv({ Path: 'C:\\mine' })).toEqual({ Path: 'C:\\mine' })
  })

  it('wo Rust keinen liefert (Windows, Linux), bleibt die Umgebung der App', async () => {
    antwort = null
    expect(await spawnEnv(undefined)).toBeUndefined()
  })
})
