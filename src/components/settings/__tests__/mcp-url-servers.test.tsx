/**
 * @vitest-environment jsdom
 *
 * Settings, Agent, MCP Servers (M1): a server can be added by its URL. The
 * form switches between Local command and URL, the token goes to the vault
 * and never into the store, each row says whether it is connected, how many
 * tools it has or in one sentence why not, and Reconnect tries again.
 *
 * Run: npx vitest run src/components/settings/__tests__/mcp-url-servers.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { MCPServerConfig, MCPToolDefinition } from '../../../api/mcp/types'

const vault = new Map<string, unknown>()
vi.mock('../../../lib/mcp-secrets', async (orig) => {
  const real = await orig<typeof import('../../../lib/mcp-secrets')>()
  return {
    ...real,
    saveMcpAuth: vi.fn(async (id: string, auth: unknown) => { vault.set(id, auth) }),
    loadMcpAuth: vi.fn(async (id: string) => vault.get(id) ?? null),
    deleteMcpAuth: vi.fn(async (id: string) => { vault.delete(id) }),
  }
})

const httpStarts: { config: MCPServerConfig; auth: unknown }[] = []
let httpFails: string | null = null
vi.mock('../../../api/mcp/http-client', () => ({
  MCPHttpClient: class {
    private config: MCPServerConfig
    constructor(config: MCPServerConfig, opts?: { auth?: unknown }) {
      this.config = config
      httpStarts.push({ config, auth: opts?.auth ?? null })
    }
    async connect(): Promise<MCPToolDefinition[]> {
      if (httpFails) throw new Error(`Failed to connect to MCP server "${this.config.name}": ${httpFails}`)
      return [{
        name: 'url_search', description: 'search', inputSchema: { type: 'object', properties: {}, required: [] },
        category: 'mcp', source: 'external', serverId: this.config.id,
      }]
    }
    async disconnect() {}
    async callTool() { return '' }
  },
}))
const stdioStarts: string[] = []
vi.mock('../../../api/mcp/external-client', () => ({
  MCPExternalClient: class {
    constructor(config: MCPServerConfig) { stdioStarts.push(config.id) }
    async connect() { return [] }
    async disconnect() {}
    async callTool() { return '' }
  },
}))

const { MCPServerSettings } = await import('../MCPServerSettings')
const { useMCPStore } = await import('../../../stores/mcpStore')
const { toolRegistry } = await import('../../../api/mcp')

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

beforeEach(() => {
  vault.clear()
  httpStarts.length = 0
  stdioStarts.length = 0
  httpFails = null
  useMCPStore.setState({ servers: [], connectedServers: [], serverTools: {}, serverErrors: {} })
})
afterEach(() => {
  cleanup()
  for (const s of useMCPStore.getState().servers) toolRegistry.unregisterServer(s.id)
})

async function addUrlServer(name: string, url: string, token = '', headers = '') {
  fireEvent.click(screen.getByText('Add MCP Server'))
  fireEvent.click(screen.getByRole('radio', { name: 'URL' }))
  fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: name } })
  fireEvent.change(screen.getByPlaceholderText(/^Server URL/), { target: { value: url } })
  if (token) fireEvent.change(screen.getByPlaceholderText(/^Token/), { target: { value: token } })
  if (headers) fireEvent.change(screen.getByPlaceholderText(/^Extra headers/), { target: { value: headers } })
  fireEvent.click(screen.getByText('Add Server'))
  await flush()
}

describe('MCP servers by URL', () => {
  it('the form starts on Local command and offers URL', () => {
    render(createElement(MCPServerSettings))
    fireEvent.click(screen.getByText('Add MCP Server'))
    expect(screen.getByRole('radio', { name: 'Local command' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByPlaceholderText(/^Command/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'URL' }))
    expect(screen.queryByPlaceholderText(/^Command/)).toBeNull()
    expect(screen.getByPlaceholderText(/^Server URL/)).toBeTruthy()
    // Add stays off until the address is one LU can post to.
    fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'n' } })
    fireEvent.change(screen.getByPlaceholderText(/^Server URL/), { target: { value: 'localhost:8000' } })
    expect((screen.getByText('Add Server') as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves the entry without the token, which goes to the vault', async () => {
    render(createElement(MCPServerSettings))
    await addUrlServer('Notes', 'https://mcp.example.com/mcp', 'tok-9', 'X-Team: blue')
    const [saved] = useMCPStore.getState().servers
    expect(saved).toMatchObject({ name: 'Notes', transport: 'http', url: 'https://mcp.example.com/mcp', hasAuth: true, command: '', args: [] })
    expect(JSON.stringify(useMCPStore.getState())).not.toContain('tok-9')
    expect(vault.get(saved.id)).toEqual({ token: 'tok-9', headers: { 'X-Team': 'blue' } })
    expect(screen.getByText('https://mcp.example.com/mcp')).toBeTruthy()
  })

  it('connects with the saved token and shows the tool count', async () => {
    render(createElement(MCPServerSettings))
    await addUrlServer('Notes', 'http://localhost:8000/mcp', 'tok-1')
    fireEvent.click(screen.getByTitle('Connect'))
    await flush()
    expect(stdioStarts).toEqual([])
    expect(httpStarts[0].auth).toEqual({ token: 'tok-1', headers: {} })
    expect(screen.getByText('1 tools')).toBeTruthy()
    expect(screen.getByTestId('mcp-status-dot').getAttribute('title')).toBe('Connected')
    const id = useMCPStore.getState().servers[0].id
    expect(toolRegistry.displayName('url_search')).toBe('Notes: url_search')
    expect(toolRegistry.getToolByName('url_search')?.serverId).toBe(id)
  })

  it('a failed connect says why on its row, and Reconnect tries again', async () => {
    render(createElement(MCPServerSettings))
    await addUrlServer('Notes', 'http://localhost:8000/mcp')
    httpFails = 'The server refused the sign in. Check the token.'
    fireEvent.click(screen.getByTitle('Connect'))
    await flush()
    expect(screen.getByTestId('mcp-row-error').textContent).toBe('The server refused the sign in. Check the token.')
    expect(screen.getByTestId('mcp-status-dot').getAttribute('title')).toBe('Not connected')

    httpFails = null
    fireEvent.click(screen.getByTitle('Reconnect'))
    await flush()
    expect(httpStarts).toHaveLength(2)
    expect(screen.queryByTestId('mcp-row-error')).toBeNull()
    expect(screen.getByText('1 tools')).toBeTruthy()
  })

  it('remove takes the saved token with it', async () => {
    render(createElement(MCPServerSettings))
    await addUrlServer('Notes', 'http://localhost:8000/mcp', 'tok-2')
    const id = useMCPStore.getState().servers[0].id
    fireEvent.click(screen.getByTitle('Remove server'))
    await flush()
    expect(useMCPStore.getState().servers).toEqual([])
    expect(vault.has(id)).toBe(false)
  })

  it('an edit keeps the saved token unless a new one is typed', async () => {
    render(createElement(MCPServerSettings))
    await addUrlServer('Notes', 'http://localhost:8000/mcp', 'tok-3')
    const id = useMCPStore.getState().servers[0].id
    fireEvent.click(screen.getByTitle('Edit server'))
    expect(screen.getByPlaceholderText(/^Token saved/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(/^Server URL/), { target: { value: 'http://localhost:8001/mcp' } })
    fireEvent.click(screen.getByText('Save Changes'))
    await flush()
    expect(useMCPStore.getState().servers[0]).toMatchObject({ url: 'http://localhost:8001/mcp', hasAuth: true })
    expect(vault.get(id)).toEqual({ token: 'tok-3', headers: {} })
  })

  it('a local command entry still starts the stdio client', async () => {
    useMCPStore.setState({ servers: [{ id: 'loc', name: 'time', command: 'uvx', args: ['mcp-server-time'], enabled: true }] })
    render(createElement(MCPServerSettings))
    fireEvent.click(screen.getByTitle('Connect'))
    await flush()
    expect(stdioStarts).toEqual(['loc'])
    expect(httpStarts).toEqual([])
  })
})
