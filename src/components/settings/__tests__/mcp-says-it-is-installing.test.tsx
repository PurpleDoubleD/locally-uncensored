/**
 * @vitest-environment jsdom
 *
 * Settings, Agent, MCP Servers (box test 31.10.2026, Befund 10): the first
 * Connect of a uvx server downloads its dependencies first. The row showed
 * only a spinner until "Request initialize timed out". While the server is
 * still fetching, the row now says so, and the line goes once the connect
 * is over.
 *
 * Run: npx vitest run src/components/settings/__tests__/mcp-says-it-is-installing.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { MCPServerConfig, MCPToolDefinition } from '../../../api/mcp/types'

const NOTE = 'Installing server dependencies … the first start can take a few minutes.'
let progress: ((note: string | null) => void) | undefined
let finish: () => void = () => {}

vi.mock('../../../api/mcp/external-client', () => ({
  MCPExternalClient: class {
    private config: MCPServerConfig
    private onProgress?: (note: string | null) => void
    constructor(config: MCPServerConfig, opts?: { onProgress?: (note: string | null) => void }) {
      this.config = config
      this.onProgress = opts?.onProgress
      progress = opts?.onProgress
    }
    connect(): Promise<MCPToolDefinition[]> {
      return new Promise((resolve) => {
        finish = () => {
          this.onProgress?.(null)
          resolve([{
            name: 'get_current_time', description: 'time', inputSchema: { type: 'object', properties: {} },
            category: 'mcp', source: 'external', serverId: this.config.id,
          } as MCPToolDefinition])
        }
      })
    }
    async disconnect() {}
    async callTool() { return '' }
  },
}))

const { MCPServerSettings } = await import('../MCPServerSettings')
const { useMCPStore } = await import('../../../stores/mcpStore')
const { toolRegistry } = await import('../../../api/mcp')

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

beforeEach(() => {
  progress = undefined
  useMCPStore.setState({
    servers: [{ id: 's21', name: 'time', command: 'uvx', args: ['mcp-server-time==2026.8.18'], enabled: true }],
    connectedServers: [],
    serverTools: {},
  })
})
afterEach(() => {
  cleanup()
  toolRegistry.unregisterServer('s21')
})

describe('a uvx server that is still installing', () => {
  it('says so on its row while it connects, and not after', async () => {
    render(createElement(MCPServerSettings))
    fireEvent.click(screen.getByTitle('Connect'))
    await flush()
    expect(screen.queryByTestId('mcp-installing-note')).toBeNull()

    act(() => progress?.(NOTE))
    expect(screen.getByTestId('mcp-installing-note').textContent).toBe(NOTE)

    finish()
    await flush()
    expect(screen.queryByTestId('mcp-installing-note')).toBeNull()
    expect(screen.getByText('1 tools')).toBeTruthy()
  })
})
