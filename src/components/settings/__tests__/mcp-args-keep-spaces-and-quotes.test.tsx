/**
 * @vitest-environment jsdom
 *
 * Settings, Agent, MCP Servers (Jaeger B, B8): the Arguments field was split
 * on single spaces. A path with spaces could not be passed at all (the quotes
 * became part of two broken arguments) and a double space produced an empty
 * argument, so the server exited on Connect while the row looked right. Edit
 * joined with spaces and Save split again, repeating the damage.
 *
 * Run: npx vitest run src/components/settings/__tests__/mcp-args-keep-spaces-and-quotes.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../../../api/mcp/external-client', () => ({ MCPExternalClient: class {} }))

const { MCPServerSettings } = await import('../MCPServerSettings')
const { useMCPStore } = await import('../../../stores/mcpStore')

const argsInput = () => screen.getByPlaceholderText(/^Args/) as HTMLInputElement
const savedArgs = () => useMCPStore.getState().servers.map((s) => s.args)

function addServer(args: string) {
  fireEvent.click(screen.getByText('Add MCP Server'))
  fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'fs' } })
  fireEvent.change(screen.getByPlaceholderText(/^Command/), { target: { value: 'npx' } })
  fireEvent.change(argsInput(), { target: { value: args } })
  fireEvent.click(screen.getByText('Add Server'))
}

beforeEach(() => {
  useMCPStore.setState({ servers: [], connectedServers: [], serverTools: {} })
})
afterEach(() => cleanup())

describe('MCP server arguments', () => {
  it('double quotes keep a path with spaces in one argument', () => {
    render(createElement(MCPServerSettings))
    addServer('--yes "/Users/me/Application Support/pkg space" 0')
    expect(savedArgs()).toEqual([['--yes', '/Users/me/Application Support/pkg space', '0']])
  })

  it('single quotes group too, and runs of whitespace give no empty argument', () => {
    render(createElement(MCPServerSettings))
    addServer("  --yes   '/My Tools/pkg'\t0  ")
    expect(savedArgs()).toEqual([['--yes', '/My Tools/pkg', '0']])
  })

  it('a Windows path keeps its backslashes', () => {
    render(createElement(MCPServerSettings))
    addServer('-y C:\\Tools\\server.js')
    expect(savedArgs()).toEqual([['-y', 'C:\\Tools\\server.js']])
  })

  it('Edit then Save keeps the saved list unchanged', () => {
    const args = ['--yes', '/My Tools/pkg', "it's", 'say "hi"', '', 'plain']
    useMCPStore.setState({ servers: [{ id: 'e1', name: 'fs', command: 'npx', args, enabled: true }] })
    render(createElement(MCPServerSettings))
    fireEvent.click(screen.getByTitle('Edit server'))
    fireEvent.click(screen.getByText('Save Changes'))
    expect(savedArgs()).toEqual([args])
  })
})
