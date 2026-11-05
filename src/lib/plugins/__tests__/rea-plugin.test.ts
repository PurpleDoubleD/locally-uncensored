/**
 * REA as a plugin of the agents (3.0.7): the switch under Plugins starts one
 * local MCP server, and what starts is the official package of one version,
 * checked against its registry checksum (commands/plugin_rea.rs). Never a
 * package name npx would resolve on the registry, never REA's own `setup`
 * (it writes the settings of other apps), no install scripts, and it works
 * in its own folder.
 *
 * Run: npx vitest run src/lib/plugins/__tests__/rea-plugin.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { REA_PLUGIN, REA_TOOLS_NOTE, REA_FIRST_START_TIMEOUT_MS, reaNotStartable, reaServerConfig, type ReaStatus } from '../rea'

const ready: ReaStatus = {
  version: '6.5.0',
  ready: true,
  tarball: '/data/plugins/rea/rea-agents-6.5.0.tgz',
  workDir: '/data/plugins/rea/work',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  node: 'v24.11.0',
  nodeOk: true,
  nodeRange: '22.19 or newer within 22, 24.11 or newer within 24, or 26 and later',
}

describe('the server LU starts for REA', () => {
  it('is npx with the checked tarball, its MCP command, in its own folder', () => {
    const c = reaServerConfig(ready)
    expect(c.id).toBe(REA_PLUGIN.serverId)
    expect(c.command).toBe('npx')
    expect(c.args).toEqual(['--yes', '--package=/data/plugins/rea/rea-agents-6.5.0.tgz', '--', 'rea', 'mcp'])
    expect(c.cwd).toBe('/data/plugins/rea/work')
  })

  it('never names the package on the registry, never runs setup, runs no install scripts', () => {
    const c = reaServerConfig(ready)
    expect(c.args.some((a) => /^rea-agents(@|$)/.test(a))).toBe(false)
    expect(c.args).not.toContain('setup')
    expect(c.env?.npm_config_ignore_scripts).toBe('true')
    // Its log goes to stderr, and only what LU keeps (the static review of 6.5.0).
    expect(c.env?.REA_LOG_LEVEL).toBe('warn')
  })

  it('gives the first start time to install its packages (d307-k: about two minutes on a slow line)', () => {
    const c = reaServerConfig(ready)
    expect(c.initializeTimeoutMs).toBe(REA_FIRST_START_TIMEOUT_MS)
    expect(REA_FIRST_START_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000)
    // The general request time of an MCP server is 30 s (api/mcp/external-client).
    expect(REA_FIRST_START_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('takes the PATH the status names, so a Finder start finds Node', () => {
    expect(reaServerConfig(ready).env?.PATH).toBe(ready.path)
    expect(reaServerConfig({ ...ready, path: null }).env?.PATH).toBeUndefined()
  })

  it('does not start without Node, with an old Node, or without the checked package', () => {
    expect(reaNotStartable(ready)).toBeNull()
    expect(reaNotStartable({ ...ready, node: null, nodeOk: false })).toMatch(/needs Node\.js .* none was found/)
    expect(reaNotStartable({ ...ready, node: 'v20.18.0', nodeOk: false })).toMatch(/this computer has v20\.18\.0/)
    expect(reaNotStartable({ ...ready, ready: false, tarball: null })).toMatch(/not on this computer yet, or it was changed/)
    expect(() => reaServerConfig({ ...ready, ready: false, tarball: null })).toThrow(/official one/)
  })
})

describe('what the row says about the models REA suits', () => {
  it('names the size it was proven with, not every model', () => {
    expect(REA_TOOLS_NOTE).toMatch(/about 27B and a context window of 64K or more/)
    expect(REA_TOOLS_NOTE).not.toMatch(/large context window get furthest/)
  })
})

// ── Start and stop ──────────────────────────────────────────────────────

const fake = vi.hoisted(() => ({
  status: null as unknown,
  connects: 0,
  disconnects: 0,
  exit: null as null | ((id: string) => void),
  calls: [] as Array<[string, unknown]>,
  connectError: null as Error | null,
  reply: 'ok',
  /** What the Rust guard answers; the strings it was asked about. */
  guard: null as string | null,
  guardAsked: [] as string[][],
}))

vi.mock('../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isTauri: () => true,
  backendCall: vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === 'plugin_rea_fetch' || cmd === 'plugin_rea_status') return fake.status
    if (cmd === 'plugin_rea_guard') {
      fake.guardAsked.push((args as { strings: string[] }).strings)
      return fake.guard
    }
    throw new Error(`unexpected ${cmd}`)
  }),
}))

vi.mock('../../../api/mcp/external-client', () => ({
  MCPExternalClient: class {
    constructor(_c: unknown, opts?: { onExit?: (id: string) => void }) { fake.exit = opts?.onExit ?? null }
    async connect() {
      fake.connects++
      if (fake.connectError) throw fake.connectError
      return [
        { name: 'rea_inspect', description: 'x', inputSchema: { type: 'object', properties: {}, required: [] }, category: 'workflow', source: 'external', serverId: 'plugin:rea' },
        { name: 'rea_asar_list', description: 'y', inputSchema: { type: 'object', properties: {}, required: [] }, category: 'workflow', source: 'external', serverId: 'plugin:rea' },
        { name: 'rea_trace', description: 'z', category: 'workflow', source: 'external', serverId: 'plugin:rea', inputSchema: {
          type: 'object', required: ['application'], properties: { application: { anyOf: [
            { type: 'object', properties: { evidence_id: { type: 'string' }, normalized_result: {} } },
            { type: 'object', properties: { kind: { type: 'string', const: 'retained-evidence' }, evidence_id: { type: 'string' } } },
          ] } } } },
      ]
    }
    async callTool(name: string, args: unknown) { fake.calls.push([name, args]); return fake.reply }
    async disconnect() { fake.disconnects++ }
  },
}))

import { startRea, stopRea, useReaRuntime, REA_NODE_RETRY } from '../rea-runtime'
import { toolRegistry } from '../../../api/mcp/tool-registry'

const reaTools = () => toolRegistry.getAll().filter((t) => t.serverId === REA_PLUGIN.serverId)

describe('the REA switch', () => {
  beforeEach(async () => {
    await stopRea()
    Object.assign(fake, { status: ready, connects: 0, disconnects: 0, exit: null, calls: [], connectError: null, reply: 'ok', guard: null, guardAsked: [] })
  })

  it('on gives the agents its tools, as external tools behind a confirmation', async () => {
    await startRea()
    expect(useReaRuntime.getState()).toMatchObject({ phase: 'on', tools: 3, error: null })
    expect(reaTools().map((t) => t.name)).toEqual(['rea_inspect', 'rea_asar_list', 'rea_trace'])
    expect(reaTools().every((t) => t.source === 'external' && t.category === 'mcp')).toBe(true)
    await toolRegistry.execute('rea_inspect', { path: '/tmp/app.asar' })
    expect(fake.calls).toEqual([['rea_inspect', { path: '/tmp/app.asar' }]])
  })

  it('the model gets earlier records by reference and results as their facts (lib/plugins/rea-model)', async () => {
    await startRea()
    const application = toolRegistry.getToolByName('rea_trace')?.inputSchema.properties.application as unknown as Record<string, unknown>
    expect(application.anyOf).toBeUndefined()
    expect(application.properties).toHaveProperty('kind', { type: 'string', const: 'retained-evidence' })
    fake.reply = JSON.stringify({ evidence_id: `ev_${'1'.repeat(64)}`, subject: { digest: { sha256: 'f'.repeat(64) } }, normalized_result: { channels: ['notes:save'] } })
    // The kind the model wrote on the real run; REA takes only the reference.
    const out = await toolRegistry.execute('rea_trace', { application: { kind: 'evidence', evidence_id: `ev_${'1'.repeat(64)}` } })
    expect(fake.calls.at(-1)).toEqual(['rea_trace', { application: { kind: 'retained-evidence', evidence_id: `ev_${'1'.repeat(64)}` } }])
    expect(out).toContain('notes:save')
    expect(out).not.toContain('f'.repeat(64))
  })

  it('LU itself is refused before REA runs anything (David, 27.10.2026)', async () => {
    await startRea()
    fake.guard = 'REA does not analyze Locally Uncensored itself'
    const out = await toolRegistry.execute('rea_inspect', { path: '/Applications/LU.app', nested: { also: ['https://lu-labs.ai'] } })
    expect(out).toContain('does not analyze Locally Uncensored')
    expect(fake.calls).toEqual([])
    expect(fake.guardAsked.at(-1)).toEqual(['/Applications/LU.app', 'https://lu-labs.ai'])
  })

  it('any other target goes through to REA', async () => {
    await startRea()
    await toolRegistry.execute('rea_inspect', { path: '/tmp/a37probe' })
    expect(fake.guardAsked.at(-1)).toEqual(['/tmp/a37probe'])
    expect(fake.calls).toEqual([['rea_inspect', { path: '/tmp/a37probe' }]])
  })

  it('off takes the tools away and ends the process', async () => {
    await startRea()
    await stopRea()
    expect(reaTools()).toHaveLength(0)
    expect(fake.disconnects).toBe(1)
    expect(useReaRuntime.getState().phase).toBe('off')
  })

  it('says why it cannot start and starts nothing', async () => {
    fake.status = { ...ready, node: 'v20.18.0', nodeOk: false }
    await startRea()
    expect(useReaRuntime.getState()).toMatchObject({ phase: 'error', tools: 0 })
    expect(useReaRuntime.getState().error).toMatch(/v20\.18\.0/)
    expect(fake.connects).toBe(0)
    expect(reaTools()).toHaveLength(0)
  })

  it('a process that dies on its own takes its tools with it and says so', async () => {
    await startRea()
    fake.exit?.(REA_PLUGIN.serverId)
    expect(reaTools()).toHaveLength(0)
    expect(useReaRuntime.getState().phase).toBe('error')
    expect(useReaRuntime.getState().error).toMatch(/stopped on its own/)
  })

  it('a start that finds no Node looks again before it gives up (A37: on at app start)', async () => {
    const saved = { ...REA_NODE_RETRY }
    REA_NODE_RETRY.delayMs = 1
    let looks = 0
    fake.status = { ...ready, node: null, nodeOk: false }
    const backend = await import('../../../api/backend')
    vi.mocked(backend.backendCall).mockImplementation(async (cmd: string) => {
      looks++
      // The first look comes too early; the second finds the user's Node.
      if (cmd === 'plugin_rea_status' && looks >= 2) return { ...ready, node: 'v24.22.0', nodeOk: true }
      return fake.status
    })
    try {
      await startRea()
      expect(useReaRuntime.getState()).toMatchObject({ phase: 'on', error: null })
      expect(fake.connects).toBe(1)
    } finally {
      Object.assign(REA_NODE_RETRY, saved)
      vi.mocked(backend.backendCall).mockImplementation(async (cmd: string) => {
        if (cmd === 'plugin_rea_fetch' || cmd === 'plugin_rea_status') return fake.status
        if (cmd === 'plugin_rea_guard') return fake.guard
        throw new Error(`unexpected ${cmd}`)
      })
    }
  })

  it('a Node that is not there at all still ends in the message, after the second look', async () => {
    const saved = { ...REA_NODE_RETRY }
    REA_NODE_RETRY.delayMs = 1
    fake.status = { ...ready, node: null, nodeOk: false }
    try {
      await startRea()
      expect(useReaRuntime.getState().phase).toBe('error')
      expect(useReaRuntime.getState().error).toMatch(/start LU from that terminal/)
      expect(fake.connects).toBe(0)
    } finally {
      Object.assign(REA_NODE_RETRY, saved)
    }
  })

  it('a start that a stop overtook leaves nothing running', async () => {
    const starting = startRea()
    await stopRea()
    await starting
    expect(reaTools()).toHaveLength(0)
    expect(useReaRuntime.getState().phase).toBe('off')
  })
})
