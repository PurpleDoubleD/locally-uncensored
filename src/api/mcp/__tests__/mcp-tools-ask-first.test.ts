/**
 * B12 (28.10.2026): every tool of an external MCP server was filed under
 * 'workflow'. "Workflows: Auto" therefore ran a shell or file MCP server
 * without a card, and "Terminal: Blocked" did not touch it. External tools
 * now sit in a row of their own, 'mcp', that asks first by default.
 */
import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../tool-registry'
import { DEFAULT_PERMISSIONS, type MCPToolDefinition, type PermissionMap } from '../types'
import { resolveApprovalLevel } from '../../../lib/agent-approval-policy'

// What a server hands over, including a definition that claims a category.
const shellTool = (category: MCPToolDefinition['category']): MCPToolDefinition => ({
  name: 'start_process',
  description: 'run a shell command',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  category,
  source: 'external',
})

// The report's matrix: Workflows on Auto, Terminal blocked, MCP left at its default.
const reported: PermissionMap = {
  ...DEFAULT_PERMISSIONS,
  workflow: 'auto',
  terminal: 'blocked',
  filesystem: 'confirm',
  mcp: 'confirm',
}

function levelInAgentChat(registry: ToolRegistry, permissions: PermissionMap): string {
  return resolveApprovalLevel('start_process', {
    categoryLevel: registry.getPermissionLevelWithOverrides('start_process', permissions, {}),
    codexMode: null,
    readOnlyRun: false,
  })
}

describe('external MCP tools have their own permission row', () => {
  it('a new install asks before any MCP tool', () => {
    expect(DEFAULT_PERMISSIONS.mcp).toBe('confirm')
  })

  it('Workflows on Auto does not run an MCP tool unattended', () => {
    const registry = new ToolRegistry()
    registry.registerExternal('srv-shell', [shellTool('workflow')], async () => 'ran')
    expect(registry.getToolByName('start_process')?.category).toBe('mcp')
    expect(levelInAgentChat(registry, reported)).toBe('confirm')
  })

  it('a server cannot file its tool under a row the user set to Auto', () => {
    const registry = new ToolRegistry()
    registry.registerExternal('srv-shell', [shellTool('web')], async () => 'ran')
    expect(levelInAgentChat(registry, { ...reported, web: 'auto' })).toBe('confirm')
  })

  it('the MCP row decides: Blocked hides the tool, Auto runs it', () => {
    const registry = new ToolRegistry()
    registry.registerExternal('srv-shell', [shellTool('workflow')], async () => 'ran')
    const blocked = { ...reported, mcp: 'blocked' as const }
    expect(registry.getAvailableTools(blocked).map((t) => t.name)).not.toContain('start_process')
    expect(levelInAgentChat(registry, blocked)).toBe('blocked')
    expect(levelInAgentChat(registry, { ...reported, mcp: 'auto' })).toBe('auto')
  })

  it('a permission map without the new key still asks', () => {
    const registry = new ToolRegistry()
    registry.registerExternal('srv-shell', [shellTool('workflow')], async () => 'ran')
    const { mcp: _gone, ...old } = reported
    expect(levelInAgentChat(registry, old as PermissionMap)).toBe('confirm')
  })

  it('Code mode keeps its presets: Ask asks, Bypass runs', () => {
    const d = { categoryLevel: 'confirm' as const, readOnlyRun: false, external: true }
    expect(resolveApprovalLevel('start_process', { ...d, codexMode: 'ask' })).toBe('confirm')
    expect(resolveApprovalLevel('start_process', { ...d, codexMode: 'bypass' })).toBe('auto')
  })
})
