// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MCPServerSettings } from '../MCPServerSettings'
import { useMCPStore } from '../../../stores/mcpStore'
import { parallelSearchConfig } from '../../../api/mcp/presets'

vi.mock('../../../api/mcp', () => ({ toolRegistry: {} }))
beforeEach(() => useMCPStore.setState({ servers: [], connectedServers: [], serverTools: {} }))
afterEach(cleanup)

it('adds the preset only on request, preserves saved entries, and prevents duplicate additions', () => {
  const saved = { id: 'saved', name: 'My server', command: 'uvx', args: ['mcp-server-time'], enabled: true }
  useMCPStore.getState().addServer(saved)
  render(<MCPServerSettings />)
  expect(useMCPStore.getState().servers).toEqual([saved])
  const add = screen.getByRole('button', { name: 'Add Parallel Search' })
  fireEvent.click(add)
  const state = useMCPStore.getState()
  expect(state.servers[0]).toEqual(saved)
  expect(state.servers[1]).toEqual(parallelSearchConfig(state.servers[1].id))
  expect(state.connectedServers).toEqual([])
  expect((add as HTMLButtonElement).disabled).toBe(true)
  expect(JSON.parse(localStorage.getItem('locally-uncensored-mcp-servers')!).state.servers).toEqual(state.servers)
})
