/**
 * T-53, zweite Hälfte — nichts trennte die externen MCP-Server, wenn die App
 * (oder auch nur ihre Seite) verschwand. Die Kindprozesse blieben.
 *
 * Die Grenze zu Tauri ist hier dieselbe wie in `external-client.test.ts`:
 * `@tauri-apps/plugin-shell` braucht die Tauri-IPC und einen Rust-Host, beides
 * gibt es unter vitest nicht. Der Ersatz spiegelt die echte API genau —
 * `Command` trägt stdout/stderr/close, nur das `Child` aus `spawn()` hat
 * `write()` und `kill()`. Alles diesseits dieser Grenze ist der echte Code.
 *
 * `window` ist hier Nodes eigener `EventTarget`, keine nachgebaute
 * Ereignisschleife: der Aufräumpfad hängt an `pagehide`/`beforeunload`, und
 * genau diese Registrierung soll geprüft werden.
 *
 * Lauf: npx vitest run src/api/mcp/__tests__/mcp-trennt-beim-app-ende.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MCPExternalClient,
  disconnectAllExternalServers,
  liveExternalServerCount,
} from '../external-client'
import { installMcpShutdown, sweepMcpServers, __resetMcpShutdownForTests } from '../shutdown'
import type { MCPServerConfig } from '../types'

class Emitter {
  private handlers: Record<string, ((data: string) => void)[]> = {}
  on(event: string, fn: (data: string) => void) {
    ;(this.handlers[event] ||= []).push(fn)
  }
  emit(event: string, data = '') {
    for (const fn of this.handlers[event] || []) fn(data)
  }
}

interface FakeRequest {
  jsonrpc?: string
  id?: number
  method?: string
}

const spawned: FakeServer[] = []

class FakeChild {
  readonly server: FakeServer
  constructor(server: FakeServer) {
    this.server = server
  }
  async write(data: string) {
    this.server.receive(data)
  }
  async kill() {
    if (this.server.killThrows) throw new Error('kill refused')
    this.server.killed = true
    // The real plugin's close event follows the kill.
    this.server.emit('close')
  }
}

class FakeServer extends Emitter {
  stdout = new Emitter()
  stderr = new Emitter()
  killed = false
  killThrows = false
  /** Set `stdin` so any code reading it fails the way the real API would. */
  get stdin(): never {
    throw new Error('the real Command has no stdin — write() lives on the Child')
  }
  constructor() {
    super()
    spawned.push(this)
  }
  async spawn() {
    return new FakeChild(this)
  }
  receive(data: string) {
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      const out = respond(JSON.parse(line) as FakeRequest)
      if (out !== null) this.stdout.emit('data', out + '\n')
    }
  }
}

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (_cmd: string, _args?: string[], _opts?: unknown) => new FakeServer(),
  },
}))

/** A well-behaved MCP server: handshake plus one tool. */
function respond(req: FakeRequest): string | null {
  if (req.method === 'initialize') {
    return JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } })
  }
  if (req.method === 'tools/list') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [{
          name: 'get_forecast',
          description: 'forecast',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    })
  }
  return null
}

const configFor = (id: string): MCPServerConfig => ({
  id,
  name: `server-${id}`,
  command: 'npx',
  args: ['-y', `${id}-mcp`],
  enabled: true,
})

async function connectOne(id: string) {
  const client = new MCPExternalClient(configFor(id))
  const tools = await client.connect()
  expect(tools).toHaveLength(1)
  return client
}

beforeEach(async () => {
  spawned.length = 0
  __resetMcpShutdownForTests()
  // The live set is module state shared with the rest of the suite; start
  // every test from an empty one.
  await disconnectAllExternalServers()
  spawned.length = 0
})

afterEach(async () => {
  await disconnectAllExternalServers()
  __resetMcpShutdownForTests()
  Reflect.deleteProperty(globalThis, 'window')
})

describe('die App weiß, welche Serverprozesse ihr gehören', () => {
  it('ein verbundener Server steht in der Liste', async () => {
    expect(liveExternalServerCount()).toBe(0)
    await connectOne('a')
    expect(liveExternalServerCount()).toBe(1)
  })

  it('GEGENPROBE: ein Server, der von selbst stirbt, steht nicht mehr drin', async () => {
    await connectOne('a')
    expect(liveExternalServerCount()).toBe(1)
    spawned[0].emit('close')
    expect(liveExternalServerCount()).toBe(0)
  })

  it('GEGENPROBE: ein einzeln getrennter Server ebenso', async () => {
    const client = await connectOne('a')
    await client.disconnect()
    expect(liveExternalServerCount()).toBe(0)
  })
})

describe('disconnectAllExternalServers', () => {
  it('nimmt jeden laufenden Server mit — nicht nur den ersten', async () => {
    await connectOne('a')
    await connectOne('b')
    await connectOne('c')
    expect(liveExternalServerCount()).toBe(3)

    const count = await disconnectAllExternalServers()

    expect(count).toBe(3)
    expect(spawned.map((s) => s.killed)).toEqual([true, true, true])
    expect(liveExternalServerCount()).toBe(0)
  })

  it('ein Server, dessen kill scheitert, hält die anderen nicht auf und bleibt nicht liegen', async () => {
    // Was hier bewiesen wird, ist die Schleife und die Buchführung, NICHT das
    // try/catch im Sweep: `disconnect()` schluckt seinen eigenen kill-Fehler
    // ("Process may already be dead"), der Sweep sieht ihn also gar nicht.
    // Das steht so auch an der Fundstelle; hier steht es, damit dieser Test
    // nicht mehr zu behaupten scheint, als er misst.
    await connectOne('a')
    await connectOne('b')
    spawned[0].killThrows = true

    await expect(disconnectAllExternalServers()).resolves.toBe(2)

    expect(spawned[0].killed).toBe(false)
    expect(spawned[1].killed).toBe(true)
    // Entscheidend: der widerspenstige Server ist trotzdem aus der Liste, sonst
    // liefe jeder weitere Sweep endlos auf denselben Prozess.
    expect(liveExternalServerCount()).toBe(0)
  })

  it('GEGENPROBE: ein zweiter Durchlauf tötet nichts noch einmal', async () => {
    await connectOne('a')
    await disconnectAllExternalServers()
    spawned[0].killed = false

    await expect(disconnectAllExternalServers()).resolves.toBe(0)

    expect(spawned[0].killed).toBe(false)
  })
})

describe('der Aufräumpfad hängt am Verschwinden der Seite', () => {
  /** Nodes eigener EventTarget als `window` — echte Listener-Semantik. */
  function installFakeWindow(): EventTarget {
    const target = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      value: target,
      writable: true,
      configurable: true,
    })
    return target
  }

  it('pagehide trennt die laufenden Server', async () => {
    const target = installFakeWindow()
    installMcpShutdown()
    await connectOne('a')

    target.dispatchEvent(new Event('pagehide'))
    // Der Handler kann nicht awaiten; der Kill ist eine Mikrotask weiter.
    await Promise.resolve()
    await Promise.resolve()

    expect(spawned[0].killed).toBe(true)
    expect(liveExternalServerCount()).toBe(0)
  })

  it('beforeunload ist derselbe Pfad, nicht ein zweiter', async () => {
    const target = installFakeWindow()
    installMcpShutdown()
    await connectOne('a')

    target.dispatchEvent(new Event('beforeunload'))
    await Promise.resolve()
    await Promise.resolve()

    expect(spawned[0].killed).toBe(true)
  })

  it('GEGENPROBE: zweimal verdrahten hängt keinen zweiten Listener an', async () => {
    const target = installFakeWindow()
    installMcpShutdown()
    installMcpShutdown()
    await connectOne('a')

    let sweeps = 0
    target.addEventListener('pagehide', () => sweeps++)
    target.dispatchEvent(new Event('pagehide'))

    expect(sweeps).toBe(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned[0].killed).toBe(true)
  })

  it('GEGENPROBE: ohne window fällt die Verdrahtung folgenlos aus', () => {
    Reflect.deleteProperty(globalThis, 'window')
    expect(() => installMcpShutdown()()).not.toThrow()
  })

  it('ein Durchlauf ohne Server meldet ehrlich null', async () => {
    await expect(sweepMcpServers()).resolves.toBe(0)
  })
})

describe('die bewusste Entscheidung ist im Code festgehalten', () => {
  const SRC = resolve(__dirname, '..', '..', '..')
  const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

  it('main.tsx verdrahtet den Aufräumpfad wirklich', () => {
    const main = read('main.tsx')
    expect(main).toContain("from './api/mcp/shutdown'")
    expect(main).toContain('installMcpShutdown()')
  })

  it('NICHT an onCloseRequested — das X versteckt in die Tray, es beendet nicht', () => {
    // main.rs:549 ruft api.prevent_close() und versteckt das Fenster. Ein
    // Teardown an dieser Stelle würde jeden verbundenen Server killen, sobald
    // der Nutzer das Fenster schließt und die App weiterlaufen soll. Wer das
    // später "nachrüstet", soll hier auflaufen.
    const shutdown = read('api', 'mcp', 'shutdown.ts')
    const codeOnly = shutdown
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(codeOnly).not.toContain('onCloseRequested')
    expect(codeOnly).not.toContain('getCurrentWindow')
  })

  it('ein Aufräumpfad, kein Pfad je Modus', () => {
    const shutdown = read('api', 'mcp', 'shutdown.ts')
    // Beide Trigger münden in dieselbe Funktion; es gibt genau einen Aufruf
    // der eigentlichen Implementierung.
    const calls = shutdown.match(/disconnectAllExternalServers\(\)/g) ?? []
    expect(calls).toHaveLength(1)
  })
})
