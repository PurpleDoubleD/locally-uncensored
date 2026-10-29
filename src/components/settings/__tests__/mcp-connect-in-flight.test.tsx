/**
 * @vitest-environment jsdom
 *
 * Settings, Agent, MCP Servers (Jaeger B, B3): a server whose handshake is
 * still running can be removed or connected a second time. Both left a ghost:
 * after Remove the handshake finished anyway and registered the tools of a
 * server that no longer existed, with its process running; a second Connect
 * started a second process, and Disconnect then stopped only one of them.
 *
 * Run: npx vitest run src/components/settings/__tests__/mcp-connect-in-flight.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { MCPServerConfig, MCPToolDefinition } from '../../../api/mcp/types'

interface FakeClient {
  id: string
  disconnected: boolean
  resolve: () => void
}
const started: FakeClient[] = []

vi.mock('../../../api/mcp/external-client', () => ({
  MCPExternalClient: class {
    private config: MCPServerConfig
    private fake: FakeClient
    constructor(config: MCPServerConfig) {
      this.config = config
      this.fake = { id: config.id, disconnected: false, resolve: () => {} }
      started.push(this.fake)
    }
    connect(): Promise<MCPToolDefinition[]> {
      return new Promise((resolve) => {
        this.fake.resolve = () => resolve([{
          name: `${this.config.id}_ping`, description: 'ping', inputSchema: { type: 'object', properties: {} },
          category: 'workflow', source: 'external', serverId: this.config.id,
        } as MCPToolDefinition])
      })
    }
    async disconnect() { this.fake.disconnected = true }
    async callTool() { return '' }
  },
}))

const { MCPServerSettings } = await import('../MCPServerSettings')
const { useMCPStore } = await import('../../../stores/mcpStore')
const { toolRegistry } = await import('../../../api/mcp')

const server = (id: string): MCPServerConfig => ({ id, name: id, command: 'npx', args: ['slow'], enabled: true })
const row = (name: string) => screen.getByText(name).closest('div.px-3') as HTMLElement
const button = (name: string, title: string) => row(name).querySelector(`button[title="${title}"]`) as HTMLButtonElement
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
const registered = () => toolRegistry.getAll().map((t) => t.name)

beforeEach(() => {
  started.length = 0
  // Ids are fresh per test: the panel keeps its clients at module level.
  useMCPStore.setState({ servers: [server('s7'), server('s8'), server('s9')], connectedServers: [], serverTools: {} })
})
afterEach(async () => {
  cleanup()
  for (const id of ['s7', 's8', 's9']) toolRegistry.unregisterServer(id)
})

describe('MCP connect while a handshake is still running', () => {
  it('Remove during Connecting stops the process and registers nothing', async () => {
    render(createElement(MCPServerSettings))
    fireEvent.click(button('s8', 'Connect'))
    await flush()
    expect(started).toHaveLength(1)

    fireEvent.click(button('s8', 'Remove server'))
    await flush()
    started[0].resolve()
    await flush()

    expect(useMCPStore.getState().servers.map((s) => s.id)).toEqual(['s7', 's9'])
    expect(useMCPStore.getState().connectedServers).not.toContain('s8')
    expect(useMCPStore.getState().serverTools.s8).toBeUndefined()
    expect(registered()).not.toContain('s8_ping')
    expect(started[0].disconnected).toBe(true)
  })

  it('a second Connect on the same row while the first runs starts no second process', async () => {
    render(createElement(MCPServerSettings))
    fireEvent.click(button('s8', 'Connect'))
    await flush()
    fireEvent.click(button('s9', 'Connect'))
    await flush()
    // The s8 row is still connecting; a click there must not start anything.
    fireEvent.click(button('s8', 'Connect'))
    await flush()
    expect(started.map((c) => c.id)).toEqual(['s8', 's9'])

    for (const c of started) c.resolve()
    await flush()
    expect(useMCPStore.getState().connectedServers).toEqual(expect.arrayContaining(['s8', 's9']))

    fireEvent.click(button('s8', 'Disconnect'))
    await flush()
    expect(started.filter((c) => c.id === 's8').every((c) => c.disconnected)).toBe(true)
    expect(registered()).not.toContain('s8_ping')
    expect(registered()).toContain('s9_ping')
  })

  it('an edit during Connecting calls the connect off', async () => {
    render(createElement(MCPServerSettings))
    fireEvent.click(button('s7', 'Connect'))
    await flush()
    // The Connect button is busy, so the way in is an edit of the row, which
    // disconnects first; Remove is covered above.
    fireEvent.click(button('s7', 'Edit server'))
    fireEvent.click(screen.getByText('Save Changes'))
    await flush()
    started[0].resolve()
    await flush()
    expect(started[0].disconnected).toBe(true)
    expect(useMCPStore.getState().connectedServers).not.toContain('s7')
    expect(registered()).not.toContain('s7_ping')
  })
})
