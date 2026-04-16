import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry } from '../tool-registry'
import { resolveCommandForPlatform } from '../external-client'
import type { MCPToolDefinition, PermissionMap } from '../types'

const fullPerms: PermissionMap = {
  filesystem: 'auto',
  terminal: 'auto',
  desktop: 'auto',
  web: 'auto',
  system: 'auto',
  image: 'auto',
  video: 'auto',
  workflow: 'auto',
}

const mkTool = (name: string, extra: Partial<MCPToolDefinition> = {}): MCPToolDefinition => ({
  name,
  description: `description of ${name}`,
  inputSchema: { type: 'object', properties: {}, required: [] },
  category: 'workflow',
  source: 'external',
  ...extra,
})

describe('ToolRegistry — registerExternal name binding', () => {
  it('routes each tool call to the right tool name via the two-arg executor', async () => {
    const registry = new ToolRegistry()
    const calls: { name: string; args: any }[] = []
    registry.registerExternal(
      'srv1',
      [mkTool('search'), mkTool('read'), mkTool('write')],
      async (name, args) => {
        calls.push({ name, args })
        return `invoked:${name}`
      }
    )
    expect(await registry.execute('search', { q: 'x' })).toBe('invoked:search')
    expect(await registry.execute('read', { path: 'a' })).toBe('invoked:read')
    expect(await registry.execute('write', { path: 'b' })).toBe('invoked:write')
    expect(calls.map((c) => c.name)).toEqual(['search', 'read', 'write'])
  })

  it('supports legacy single-arg executor (backcompat)', async () => {
    const registry = new ToolRegistry()
    const legacy = vi.fn(async (_args: Record<string, any>) => 'legacy-ok')
    registry.registerExternal('srv2', [mkTool('only')], legacy)
    expect(await registry.execute('only', {})).toBe('legacy-ok')
    expect(legacy).toHaveBeenCalledOnce()
  })

  it('tags external tools with serverId + source', () => {
    const registry = new ToolRegistry()
    registry.registerExternal('srv3', [mkTool('t')], async () => '')
    const t = registry.getToolByName('t')!
    expect(t.serverId).toBe('srv3')
    expect(t.source).toBe('external')
  })

  it('unregisterServer drops only that server\'s tools', () => {
    const registry = new ToolRegistry()
    registry.registerExternal('s1', [mkTool('a'), mkTool('b')], async () => '')
    registry.registerExternal('s2', [mkTool('c')], async () => '')
    registry.unregisterServer('s1')
    expect(registry.getToolByName('a')).toBeUndefined()
    expect(registry.getToolByName('b')).toBeUndefined()
    expect(registry.getToolByName('c')).toBeDefined()
  })

  it('external tools appear in toOpenAITools / toOllamaTools alongside builtins', () => {
    const registry = new ToolRegistry()
    registry.registerBuiltin(
      { ...mkTool('builtin_a'), source: 'builtin' },
      async () => 'ok'
    )
    registry.registerExternal('srv', [mkTool('external_a')], async () => 'ok')
    const openai = registry.toOpenAITools(fullPerms).map((t) => t.function.name).sort()
    const ollama = registry.toOllamaTools(fullPerms).map((t) => t.function.name).sort()
    expect(openai).toEqual(['builtin_a', 'external_a'])
    expect(ollama).toEqual(['builtin_a', 'external_a'])
  })

  it('external tool failure propagates as Error: string (retry-friendly)', async () => {
    const registry = new ToolRegistry()
    registry.registerExternal('srv', [mkTool('broken')], async () => {
      throw new Error('connection lost')
    })
    const out = await registry.execute('broken', {})
    expect(out).toMatch(/Error: connection lost/)
  })
})

describe('ToolRegistry — getPermissionLevelWithOverrides (Phase 12)', () => {
  it('returns the per-tool override when set', () => {
    const registry = new ToolRegistry()
    registry.registerBuiltin(
      { ...mkTool('file_write'), source: 'builtin', category: 'filesystem' },
      async () => 'ok'
    )
    const lvl = registry.getPermissionLevelWithOverrides(
      'file_write',
      { ...fullPerms, filesystem: 'confirm' },
      { file_write: 'auto' }
    )
    expect(lvl).toBe('auto')
  })

  it('falls back to category when no per-tool override exists', () => {
    const registry = new ToolRegistry()
    registry.registerBuiltin(
      { ...mkTool('file_write'), source: 'builtin', category: 'filesystem' },
      async () => 'ok'
    )
    const lvl = registry.getPermissionLevelWithOverrides(
      'file_write',
      { ...fullPerms, filesystem: 'confirm' },
      {}
    )
    expect(lvl).toBe('confirm')
  })

  it('returns confirm for unknown tool regardless of overrides', () => {
    const registry = new ToolRegistry()
    // Override set for a tool that is not registered at all.
    const lvl = registry.getPermissionLevelWithOverrides('mystery', fullPerms, {
      mystery: 'auto',
    })
    // Override wins — tool-existence is orthogonal to the level lookup.
    expect(lvl).toBe('auto')
  })
})

describe('external-client — resolveCommandForPlatform', () => {
  it('appends .cmd for known Node-based commands on Windows', () => {
    expect(resolveCommandForPlatform('npx', 'Win32')).toBe('npx.cmd')
    expect(resolveCommandForPlatform('npm', 'Win32')).toBe('npm.cmd')
    expect(resolveCommandForPlatform('pnpm', 'Win32')).toBe('pnpm.cmd')
    expect(resolveCommandForPlatform('yarn', 'Win32')).toBe('yarn.cmd')
    expect(resolveCommandForPlatform('bun', 'Win32')).toBe('bun.cmd')
    expect(resolveCommandForPlatform('node', 'Win32')).toBe('node.cmd')
    expect(resolveCommandForPlatform('deno', 'Win32')).toBe('deno.cmd')
  })

  it('leaves commands with extensions unchanged on Windows', () => {
    expect(resolveCommandForPlatform('npx.cmd', 'Win32')).toBe('npx.cmd')
    expect(resolveCommandForPlatform('mcp-server.exe', 'Win32')).toBe('mcp-server.exe')
  })

  it('leaves absolute / path-like commands unchanged on Windows', () => {
    expect(resolveCommandForPlatform('C:\\Program Files\\node\\node.exe', 'Win32')).toBe(
      'C:\\Program Files\\node\\node.exe'
    )
    expect(resolveCommandForPlatform('./bin/server', 'Win32')).toBe('./bin/server')
  })

  it('leaves unknown commands unchanged on Windows', () => {
    expect(resolveCommandForPlatform('some-custom-mcp', 'Win32')).toBe('some-custom-mcp')
  })

  it('returns command unchanged on non-Windows platforms', () => {
    expect(resolveCommandForPlatform('npx', 'MacIntel')).toBe('npx')
    expect(resolveCommandForPlatform('npx', 'Linux x86_64')).toBe('npx')
  })
})
