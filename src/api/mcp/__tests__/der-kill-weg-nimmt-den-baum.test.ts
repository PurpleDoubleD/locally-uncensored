/**
 * T-68, Nachzug im Frontend — "erst der Baum, dann gar nichts mehr".
 *
 * `tauri-plugin-shell`s `CommandChild::kill` (`src/process/mod.rs:78`) schickt
 * EIN Signal an das direkte Kind. Ein MCP-Server, der als `npx -y <paket>`
 * startet, ist damit nicht gemeint: das direkte Kind ist der Starter, der
 * eigentliche `node`-Server ist ein Enkel. `child.kill()` erlegte den Starter
 * und liess den Server laufen — und zwar unerreichbar, weil der JS-Handle
 * mit dem Starter verschwand.
 *
 * Seit `c5773322` gibt es dafür `kill_process_tree` auf der Rust-Seite. Der
 * Haken, den dieser Test festnagelt, ist die REIHENFOLGE: die Rust-Wache
 * (`may_kill_pid`) lässt nur pids aus dem eigenen Teilbaum durch, und genau
 * den zerstört der Tod des direkten Kindes — sobald der Starter weg ist,
 * hängen seine Kinder an init, sind keine Nachfahren dieser App mehr, und die
 * Wache verweigert zu Recht. `kill_process_tree` muss deshalb ANSTELLE von
 * `child.kill()` laufen, nie danach. Ein Kommentar hält das nicht; die Tests
 * unten tun es.
 *
 * Lauf: npx vitest run src/api/mcp/__tests__/der-kill-weg-nimmt-den-baum.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCPExternalClient } from '../external-client'
import type { MCPServerConfig } from '../types'

// ── ein Protokoll, das die Reihenfolge behält ──────────────────────────────
//
// Beide Wege schreiben in dieselbe Liste, damit "danach" ein Testfehler wird
// und nicht bloss eine andere Zählung.
let events: string[] = []

/** Was der Rust-Aufruf tun soll: auflegen, ablehnen, oder gar nicht da sein. */
type InvokeBehaviour = 'ok' | 'refused' | 'missing'
let invokeBehaviour: InvokeBehaviour = 'ok'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    // Sobald `isTauri()` wahr ist, geht auch der Logger durch diese IPC.
    // Protokolliert wird nur, worum es hier geht.
    if (cmd !== 'kill_process_tree') return undefined
    if (invokeBehaviour === 'missing') {
      // Was Tauri für ein unbekanntes Kommando meldet (ältere Rust-Seite).
      throw new Error(`Command ${cmd} not found`)
    }
    events.push(`${cmd}:${String(args?.pid)}`)
    if (invokeBehaviour === 'refused') {
      // Der Wortlaut von `may_kill_pid`, gekürzt.
      throw new Error(`refused: pid ${String(args?.pid)} is not a process this app started`)
    }
    return { killed: true, pid: args?.pid, processes: 2 }
  },
}))

// ── der Shell-Fake, gleiche Form wie in external-client.test.ts ────────────

class Emitter {
  private handlers: Record<string, ((data: string) => void)[]> = {}
  on(event: string, fn: (data: string) => void) { (this.handlers[event] ||= []).push(fn) }
  emit(event: string, data = '') { for (const fn of this.handlers[event] || []) fn(data) }
}

interface FakeRequest { id?: number; method?: string }
type Responder = (req: FakeRequest) => string | null

let lastServer: FakeServer | null = null

/** Die pid, die der Plugin-Spawn zurückgibt — das ist der Starter, nicht der Server. */
const LAUNCHER_PID = 4242

/** Setzt ein Test, wenn auch der Rückfall scheitern soll (Prozess schon tot). */
let childKillThrows = false

class FakeChild {
  pid = LAUNCHER_PID
  private server: FakeServer
  constructor(server: FakeServer) { this.server = server }
  async write(data: string) { this.server.receive(data) }
  async kill() {
    events.push(`child.kill:${this.pid}`)
    if (childKillThrows) throw new Error('No such process')
    this.server.killed = true
  }
}

class FakeServer extends Emitter {
  stdout = new Emitter()
  stderr = new Emitter()
  killed = false
  written: string[] = []
  async spawn() { return new FakeChild(this) }
  receive(data: string) {
    this.written.push(data)
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      const out = responder(JSON.parse(line))
      if (out !== null) this.stdout.emit('data', out + '\n')
    }
  }
}

let responder: Responder = () => null

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: () => (lastServer = new FakeServer()) },
}))

const config: MCPServerConfig = {
  id: 'srv-1', name: 'weather', command: 'npx', args: ['-y', 'weather-mcp'], enabled: true,
}

const goodServer: Responder = (req) => {
  if (req.method === 'initialize') {
    return JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } })
  }
  if (req.method === 'tools/list') {
    return JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [] } })
  }
  return null
}

/** Ein Server, der den Handshake verweigert — der zweite Kill-Weg. */
const refusingServer: Responder = (req) => {
  if (req.method === 'initialize') {
    return JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope' } })
  }
  return null
}

/**
 * Der Kill-Weg fragt die Rust-Seite nur, wenn es eine gibt: `isTauri()` prüft
 * `window.__TAURI_INTERNALS__`. Ohne das wäre der ganze Baum-Kill unter vitest
 * unerreichbar — und der Test würde nur beweisen, dass das direkte Kind noch
 * stirbt.
 */
function pretendTauri() {
  Object.defineProperty(globalThis, 'window', {
    value: { __TAURI_INTERNALS__: {} },
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  responder = goodServer
  lastServer = null
  events = []
  invokeBehaviour = 'ok'
  childKillThrows = false
  pretendTauri()
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('der Abbau nimmt den Prozessbaum', () => {
  it('disconnect ruft den Baum-Kill statt child.kill', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    await client.disconnect()
    expect(events).toEqual([`kill_process_tree:${LAUNCHER_PID}`])
  })

  it('der Baum-Kill bekommt die pid des gespawnten Kindes', async () => {
    // Die pid ist das einzige Argument, und eine falsche pid wäre auf der
    // Rust-Seite entweder eine Ablehnung oder — schlimmer — ein Fremdkill.
    const client = new MCPExternalClient(config)
    await client.connect()
    await client.disconnect()
    expect(events[0]).toBe(`kill_process_tree:${LAUNCHER_PID}`)
  })

  it('ein gescheiterter Handshake nimmt denselben Weg', async () => {
    // Der Server läuft schon, wenn `initialize` scheitert; niemand ausser
    // connect() hält je einen Handle darauf.
    responder = refusingServer
    const client = new MCPExternalClient(config)
    await expect(client.connect()).rejects.toThrow(/Failed to connect/)
    expect(events).toEqual([`kill_process_tree:${LAUNCHER_PID}`])
  })

  it('zwei gleichzeitige disconnects schicken einen Kill, nicht zwei', async () => {
    // Die Abbau-Sichtung beim Seitenwechsel und ein Klick im Panel können
    // sich überholen, und ein Kill ist hier eine asynchrone IPC-Runde: wer
    // den Handle erst NACH dem await fallen lässt, schickt zwei. Eine
    // inzwischen neu vergebene pid wäre dann ein Fremdkill.
    // Deshalb wirklich nebenläufig, nicht nacheinander — sequenziell sähe
    // auch die kaputte Reihenfolge grün aus.
    const client = new MCPExternalClient(config)
    await client.connect()
    await Promise.all([client.disconnect(), client.disconnect()])
    expect(events).toEqual([`kill_process_tree:${LAUNCHER_PID}`])
  })
})

describe('lehnt der Baum-Kill ab, läuft der Server trotzdem nicht weiter', () => {
  it('die Ablehnung fällt auf das direkte Kind zurück', async () => {
    invokeBehaviour = 'refused'
    const client = new MCPExternalClient(config)
    await client.connect()
    await client.disconnect()
    expect(lastServer?.killed).toBe(true)
  })

  it('der Rückfall kommt NACH dem Baum-Kill, nie davor', async () => {
    // Das ist der ganze Witz: umgekehrt wäre der Baum-Kill garantiert
    // sinnlos, weil die Enkel dann schon an init hängen.
    invokeBehaviour = 'refused'
    const client = new MCPExternalClient(config)
    await client.connect()
    await client.disconnect()
    expect(events).toEqual([`kill_process_tree:${LAUNCHER_PID}`, `child.kill:${LAUNCHER_PID}`])
  })

  it('fehlt das Kommando ganz, greift derselbe Rückfall', async () => {
    // Eine Rust-Seite vor c5773322 kennt `kill_process_tree` nicht.
    invokeBehaviour = 'missing'
    const client = new MCPExternalClient(config)
    await client.connect()
    await client.disconnect()
    expect(events).toEqual([`child.kill:${LAUNCHER_PID}`])
  })

  it('scheitern beide Wege, meldet disconnect trotzdem nicht durch', async () => {
    // disconnect() hängt an einem Seiten-Unload; eine Ablehnung dort wäre
    // eine unbehandelte.
    invokeBehaviour = 'refused'
    childKillThrows = true
    const client = new MCPExternalClient(config)
    await client.connect()
    await expect(client.disconnect()).resolves.toBeUndefined()
    expect(events).toEqual([`kill_process_tree:${LAUNCHER_PID}`, `child.kill:${LAUNCHER_PID}`])
  })
})

describe('ohne Tauri gibt es keinen Baum-Kill zu holen', () => {
  it('der Browser-Lauf fragt gar nicht erst und nimmt direkt das Kind', async () => {
    // Unter reinem `npm run dev` gibt es keine IPC — und damit auch keinen
    // Server, weil der Spawn durch dieselbe IPC läuft. Ein Baum-Kill-Versuch
    // wäre dort eine Warnung über etwas, das niemand wollen konnte, und ein
    // dynamischer Import mitten im Seiten-Unload.
    const client = new MCPExternalClient(config)
    await client.connect()
    Reflect.deleteProperty(globalThis, 'window')
    await client.disconnect()
    expect(events).toEqual([`child.kill:${LAUNCHER_PID}`])
  })
})

describe('es gibt genau eine Stelle, die tötet', () => {
  it('external-client ruft child.kill() nur aus killServerProcess', () => {
    // Zwei Aufrufstellen waren der Ausgangszustand, und eine dritte würde
    // die Reihenfolge oben ohne einen roten Test verletzen können.
    const src = readFileSync(join(__dirname, '..', 'external-client.ts'), 'utf8')
    // Der Kommentarblock über `killServerProcess` erklärt `child.kill()` und
    // nennt es dabei mehrfach — gezählt wird der Code, nicht die Prosa.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code.match(/\bchild\.kill\(\)/g) ?? []).toHaveLength(1)
    expect(code).toMatch(/invoke\('kill_process_tree', \{ pid \}\)/)
  })
})
