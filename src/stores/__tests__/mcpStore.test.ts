import { describe, it, expect, beforeEach } from 'vitest'
import { useMCPStore } from '../mcpStore'
import type { MCPServerConfig, MCPToolDefinition } from '../../api/mcp/types'

function makeServer(id: string, overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id,
    name: `Server ${id}`,
    command: 'node',
    args: ['server.js'],
    enabled: true,
    ...overrides,
  }
}

function makeTool(name: string): MCPToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'web',
    source: 'external',
  }
}

describe('mcpStore', () => {
  beforeEach(() => {
    useMCPStore.setState({
      servers: [],
      connectedServers: [],
      serverTools: {},
    })
  })

  // ── addServer ──────────────────────────────────────────────

  describe('addServer', () => {
    it('appends a server to the list', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      expect(useMCPStore.getState().servers).toHaveLength(1)
      expect(useMCPStore.getState().servers[0].id).toBe('s1')
    })

    it('appends multiple servers', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().addServer(makeServer('s2'))
      expect(useMCPStore.getState().servers).toHaveLength(2)
    })

    it('preserves existing servers', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().addServer(makeServer('s2'))
      expect(useMCPStore.getState().servers[0].id).toBe('s1')
    })
  })

  // ── updateServer ───────────────────────────────────────────

  describe('updateServer', () => {
    it('merges updates by id', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().updateServer('s1', { name: 'Updated', enabled: false })
      const s = useMCPStore.getState().servers[0]
      expect(s.name).toBe('Updated')
      expect(s.enabled).toBe(false)
      expect(s.command).toBe('node') // unchanged
    })

    it('does not affect other servers', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().addServer(makeServer('s2'))
      useMCPStore.getState().updateServer('s1', { name: 'Changed' })
      expect(useMCPStore.getState().servers[1].name).toBe('Server s2')
    })

    it('is a no-op for non-existent id', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().updateServer('nonexistent', { name: 'X' })
      expect(useMCPStore.getState().servers[0].name).toBe('Server s1')
    })
  })

  // ── removeServer ───────────────────────────────────────────

  describe('removeServer', () => {
    it('removes the server from the list', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().removeServer('s1')
      expect(useMCPStore.getState().servers).toHaveLength(0)
    })

    it('cascades removal to connectedServers', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().setConnected('s1', true)
      expect(useMCPStore.getState().connectedServers).toContain('s1')
      useMCPStore.getState().removeServer('s1')
      expect(useMCPStore.getState().connectedServers).not.toContain('s1')
    })

    it('cascades removal to serverTools', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().setServerTools('s1', [makeTool('t1')])
      expect(useMCPStore.getState().serverTools['s1']).toBeDefined()
      useMCPStore.getState().removeServer('s1')
      expect(useMCPStore.getState().serverTools['s1']).toBeUndefined()
    })

    it('does not affect other servers on removal', () => {
      useMCPStore.getState().addServer(makeServer('s1'))
      useMCPStore.getState().addServer(makeServer('s2'))
      useMCPStore.getState().setConnected('s1', true)
      useMCPStore.getState().setConnected('s2', true)
      useMCPStore.getState().setServerTools('s1', [makeTool('t1')])
      useMCPStore.getState().setServerTools('s2', [makeTool('t2')])
      useMCPStore.getState().removeServer('s1')
      expect(useMCPStore.getState().servers).toHaveLength(1)
      expect(useMCPStore.getState().connectedServers).toEqual(['s2'])
      expect(useMCPStore.getState().serverTools['s2']).toHaveLength(1)
    })
  })

  // ── setConnected ───────────────────────────────────────────

  describe('setConnected', () => {
    it('adds server id to connectedServers when connected=true', () => {
      useMCPStore.getState().setConnected('s1', true)
      expect(useMCPStore.getState().connectedServers).toContain('s1')
    })

    it('removes server id from connectedServers when connected=false', () => {
      useMCPStore.getState().setConnected('s1', true)
      useMCPStore.getState().setConnected('s1', false)
      expect(useMCPStore.getState().connectedServers).not.toContain('s1')
    })

    it('does not create duplicates when called twice with true', () => {
      useMCPStore.getState().setConnected('s1', true)
      useMCPStore.getState().setConnected('s1', true)
      const count = useMCPStore.getState().connectedServers.filter(s => s === 's1').length
      expect(count).toBe(1)
    })

    it('is safe to disconnect an already disconnected server', () => {
      useMCPStore.getState().setConnected('s1', false)
      expect(useMCPStore.getState().connectedServers).toEqual([])
    })

    it('handles multiple servers independently', () => {
      useMCPStore.getState().setConnected('s1', true)
      useMCPStore.getState().setConnected('s2', true)
      useMCPStore.getState().setConnected('s1', false)
      expect(useMCPStore.getState().connectedServers).toEqual(['s2'])
    })
  })

  // ── setServerTools ─────────────────────────────────────────

  describe('setServerTools', () => {
    it('replaces the entire tool list for a server', () => {
      useMCPStore.getState().setServerTools('s1', [makeTool('t1'), makeTool('t2')])
      expect(useMCPStore.getState().serverTools['s1']).toHaveLength(2)
    })

    it('overwrites previous tools for the same server', () => {
      useMCPStore.getState().setServerTools('s1', [makeTool('t1')])
      useMCPStore.getState().setServerTools('s1', [makeTool('t2'), makeTool('t3')])
      expect(useMCPStore.getState().serverTools['s1']).toHaveLength(2)
      expect(useMCPStore.getState().serverTools['s1'][0].name).toBe('t2')
    })

    it('does not affect other servers tools', () => {
      useMCPStore.getState().setServerTools('s1', [makeTool('t1')])
      useMCPStore.getState().setServerTools('s2', [makeTool('t2')])
      expect(useMCPStore.getState().serverTools['s1']).toHaveLength(1)
      expect(useMCPStore.getState().serverTools['s2']).toHaveLength(1)
    })
  })

  // ── clearServerTools ───────────────────────────────────────

  describe('clearServerTools', () => {
    it('removes tools for the specified server', () => {
      useMCPStore.getState().setServerTools('s1', [makeTool('t1')])
      useMCPStore.getState().clearServerTools('s1')
      expect(useMCPStore.getState().serverTools['s1']).toBeUndefined()
    })

    it('does not affect other servers tools', () => {
      useMCPStore.getState().setServerTools('s1', [makeTool('t1')])
      useMCPStore.getState().setServerTools('s2', [makeTool('t2')])
      useMCPStore.getState().clearServerTools('s1')
      expect(useMCPStore.getState().serverTools['s2']).toHaveLength(1)
    })

    it('is a no-op for server with no tools', () => {
      useMCPStore.getState().clearServerTools('nonexistent')
      expect(useMCPStore.getState().serverTools).toEqual({})
    })
  })
})
