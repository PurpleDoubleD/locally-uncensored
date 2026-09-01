/**
 * MCPExternalClient against a stand-in for @tauri-apps/plugin-shell that
 * mirrors the real API exactly: the Command carries stdout/stderr/close, and
 * ONLY the Child returned by spawn() has write() and kill().
 *
 * The client used to keep the Command and reach for `command.stdin.write`,
 * which is undefined there — so the initialize handshake threw on the very
 * first request and every external MCP server failed to connect with
 * "Cannot read properties of undefined (reading 'write')". The fake below
 * makes that a hard failure again: touching `stdin` throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPExternalClient } from '../external-client'
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

/** One JSON-RPC request line as the fake server sees it. */
interface FakeRequest {
  jsonrpc?: string
  id?: number
  method?: string
  params?: { arguments?: Record<string, unknown> }
}

/** Server behaviour a single test wants: id/method → response line. */
type Responder = (req: FakeRequest) => string | null

let lastServer: FakeServer | null = null
let killCount = 0

class FakeChild {
  server: FakeServer
  constructor(server: FakeServer) {
    this.server = server
  }
  async write(data: string) {
    this.server.receive(data)
  }
  async kill() {
    killCount++
    this.server.killed = true
  }
}

class FakeServer extends Emitter {
  stdout = new Emitter()
  stderr = new Emitter()
  killed = false
  spawned = false
  written: string[] = []
  /** Set `stdin` so any code reading it fails the way the real API would. */
  get stdin(): never {
    throw new Error('the real Command has no stdin — write() lives on the Child')
  }
  constructor() {
    super()
    // Not the `const self = this` idiom the rule is aimed at (that one is
    // fixed by an arrow function). This hands the freshly built fake to the
    // test file so assertions can reach the instance the code under test
    // constructed — there is no other handle on it, and no arrow function
    // would produce one.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastServer = this
  }
  async spawn() {
    this.spawned = true
    return new FakeChild(this)
  }
  receive(data: string) {
    this.written.push(data)
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      const out = responder(JSON.parse(line))
      // Tauri's line reader hands the newline through with the line.
      if (out !== null) this.stdout.emit('data', out + '\n')
    }
  }
}

let responder: Responder = () => null

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (_cmd: string, _args?: string[], _opts?: unknown) => new FakeServer(),
  },
}))

const config: MCPServerConfig = {
  id: 'srv-1',
  name: 'weather',
  command: 'npx',
  args: ['-y', 'weather-mcp'],
  enabled: true,
}

/** A well-behaved MCP server: handshake, one tool, echoing tools/call. */
const goodServer: Responder = (req) => {
  if (req.method === 'initialize') {
    return JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05' } })
  }
  if (req.method === 'tools/list') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: [{ name: 'get_forecast', description: 'forecast', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }] },
    })
  }
  if (req.method === 'tools/call') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `sunny in ${String(req.params?.arguments?.city)}` }] },
    })
  }
  return null
}

beforeEach(() => {
  responder = goodServer
  lastServer = null
  killCount = 0
})

/** connect() dynamically imports the shell plugin, so the fake appears a few
 *  ticks in. Wait for the condition instead of guessing a tick count. */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const serverStarted = () => until(() => lastServer !== null, 'the server to spawn')
const wroteRequests = (n: number) => until(() => (lastServer?.written.length ?? 0) >= n, `${n} requests`)

describe('connecting to an external server', () => {
  it('completes the handshake and returns the discovered tools', async () => {
    const client = new MCPExternalClient(config)
    const tools = await client.connect()

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'get_forecast', source: 'external', serverId: 'srv-1' })
    expect(client.isConnected()).toBe(true)
  })

  it('writes the JSON-RPC requests through the child, newline-framed', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()

    expect(lastServer!.written).toHaveLength(2)
    for (const msg of lastServer!.written) expect(msg.endsWith('\n')).toBe(true)
    expect(JSON.parse(lastServer!.written[0]).method).toBe('initialize')
    expect(JSON.parse(lastServer!.written[1]).method).toBe('tools/list')
  })

  it('calls a tool and flattens the content array', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()

    expect(await client.callTool('get_forecast', { city: 'Berlin' })).toBe('sunny in Berlin')
  })

  it('surfaces a JSON-RPC error as a rejection', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    responder = (req) => JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unknown city' } })

    await expect(client.callTool('get_forecast', { city: 'Atlantis' })).rejects.toThrow('unknown city')
  })

  /**
   * A server that does not follow JSON-RPC still FAILED, and the only wrong
   * answer is to call it a success.
   *
   * `if (response.error)` was true for any truthy value, so a bare-string error
   * was at least rejected (with an unusable `Error: undefined`). Narrowing the
   * field to a record turned exactly those lines into `resolve(undefined)` —
   * the model was told the tool had run. The rule pinned here: any PRESENT
   * error rejects, and the server's own text is what comes out.
   */
  it('rejects when `error` is a bare string, not a record', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    responder = (req) => JSON.stringify({ jsonrpc: '2.0', id: req.id, error: 'server exploded' })

    await expect(client.callTool('get_forecast', { city: 'Atlantis' })).rejects.toThrow('server exploded')
  })

  it('rejects when `error` is a non-string primitive', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    responder = (req) => JSON.stringify({ jsonrpc: '2.0', id: req.id, error: 500 })

    await expect(client.callTool('get_forecast', { city: 'Atlantis' })).rejects.toThrow('500')
  })

  it('rejects when `error` is a record without a message, naming what came back', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    responder = (req) => JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601 } })

    await expect(client.callTool('get_forecast', { city: 'Atlantis' })).rejects.toThrow('-32601')
  })

  it('NEGATIVE CONTROL: `error: null` is not an error — the result still resolves', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    responder = (req) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: null,
        result: { content: [{ type: 'text', text: 'still fine' }] },
      })

    expect(await client.callTool('get_forecast', { city: 'Berlin' })).toBe('still fine')
  })

  it('refuses to call a tool before connecting', async () => {
    await expect(new MCPExternalClient(config).callTool('get_forecast', {})).rejects.toThrow('Not connected')
  })
})

describe('a server that misbehaves does not leave a process behind', () => {
  it('kills the child when the handshake is refused', async () => {
    responder = (req) =>
      req.method === 'initialize'
        ? JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'nope' } })
        : null

    const client = new MCPExternalClient(config)
    await expect(client.connect()).rejects.toThrow(/Failed to connect to MCP server "weather".*nope/)
    // The caller never receives a client it could disconnect, so connect has
    // to clean up after itself or the server process stays alive forever.
    expect(lastServer!.spawned).toBe(true)
    expect(killCount).toBe(1)
    expect(client.isConnected()).toBe(false)
  })

  it('fails every pending request when the process exits', async () => {
    responder = (req) => (req.method === 'initialize' ? JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) : null)
    const client = new MCPExternalClient(config)
    const connecting = client.connect()
    // tools/list gets no answer; the process dies instead.
    await wroteRequests(2)
    lastServer!.emit('close')

    await expect(connecting).rejects.toThrow(/Server process exited/)
    expect(client.isConnected()).toBe(false)
  })
})

describe('response framing', () => {
  it('reassembles a response split across two stdout events', async () => {
    responder = () => null
    const client = new MCPExternalClient(config)
    const connecting = client.connect()
    await wroteRequests(1)
    const server = lastServer!
    const id = JSON.parse(server.written[0]).id
    server.stdout.emit('data', `{"jsonrpc":"2.0","id":${id},"resu`)
    server.stdout.emit('data', 'lt":{"ok":true}}\n')
    // The handshake resolved; tools/list is now outstanding, so answer it too.
    await wroteRequests(2)
    const listId = JSON.parse(server.written[1]).id
    server.stdout.emit('data', `{"jsonrpc":"2.0","id":${listId},"result":{"tools":[]}}\n`)

    await expect(connecting).resolves.toEqual([])
  })

  it('ignores non-JSON chatter on stdout', async () => {
    const client = new MCPExternalClient(config)
    const connecting = client.connect()
    await serverStarted()
    lastServer!.stdout.emit('data', 'Debugger listening on ws://127.0.0.1:9229\n')

    await expect(connecting).resolves.toHaveLength(1)
  })
})

describe('disconnect', () => {
  it('kills the child and refuses further calls', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    await client.disconnect()

    expect(killCount).toBe(1)
    expect(client.isConnected()).toBe(false)
    await expect(client.callTool('get_forecast', {})).rejects.toThrow('Not connected')
  })
})

describe('a server that dies on its own', () => {
  it('tells its owner, so the tools can leave the registry and the UI can stop lying', async () => {
    // Before this the close event only flipped a private boolean. The tools
    // stayed registered and the settings panel stayed green, so the model was
    // still offered a tool whose process was gone and every call came back
    // "Not connected" for as long as the app stayed open.
    const exits: string[] = []
    const client = new MCPExternalClient(config, { onExit: (id) => exits.push(id) })
    await client.connect()

    lastServer!.emit('close')

    expect(exits).toEqual(['srv-1'])
    expect(client.isConnected()).toBe(false)
  })

  it('fails the in-flight calls instead of leaving them to time out', async () => {
    const client = new MCPExternalClient(config)
    await client.connect()
    responder = () => null                       // the server answers nothing
    const call = client.callTool('get_forecast', { city: 'Berlin' })

    lastServer!.emit('close')

    await expect(call).rejects.toThrow(/Server process exited/)
  })

  it('NEGATIVE CONTROL: our own disconnect is not reported as a death', async () => {
    const exits: string[] = []
    const client = new MCPExternalClient(config, { onExit: (id) => exits.push(id) })
    await client.connect()

    await client.disconnect()
    lastServer!.emit('close')                    // the real plugin emits this too

    expect(exits).toEqual([])
  })

  it('NEGATIVE CONTROL: a close before the handshake finished reports nothing', async () => {
    const exits: string[] = []
    const client = new MCPExternalClient(config, { onExit: (id) => exits.push(id) })
    responder = () => null
    const connecting = client.connect()
    await serverStarted()
    lastServer!.emit('close')

    await expect(connecting).rejects.toThrow()
    expect(exits).toEqual([])
  })
})

describe('the settings panel is what acts on that', () => {
  it('unregisters the dead server\'s tools and turns its light off', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const panel = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../components/settings/MCPServerSettings.tsx'),
      'utf8',
    )
    expect(panel).toContain('onExit: (id) => {')
    expect(panel).toContain('toolRegistry.unregisterServer(id)')
    expect(panel).toContain('setConnected(id, false)')
    expect(panel).toContain('clearServerTools(id)')
  })
})
