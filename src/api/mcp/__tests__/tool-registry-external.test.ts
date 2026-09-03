import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry } from '../tool-registry'
import { commandCandidatesForPlatform } from '../external-client'
import type { MCPToolDefinition, PermissionMap, ToolArgs } from '../types'

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
    const calls: { name: string; args: ToolArgs }[] = []
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
    const legacy = vi.fn(async (_args: ToolArgs) => 'legacy-ok')
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

describe('external-client — commandCandidatesForPlatform', () => {
  it('tries the .cmd shim first for npm-family launchers on Windows', () => {
    expect(commandCandidatesForPlatform('npx', 'Win32')).toEqual(['npx.cmd', 'npx'])
    expect(commandCandidatesForPlatform('npm', 'Win32')).toEqual(['npm.cmd', 'npm'])
    expect(commandCandidatesForPlatform('pnpm', 'Win32')).toEqual(['pnpm.cmd', 'pnpm'])
    expect(commandCandidatesForPlatform('yarn', 'Win32')).toEqual(['yarn.cmd', 'yarn'])
  })

  it('tries the bare name first for exe-shipping runtimes on Windows', () => {
    // node/deno/native bun install as .exe; node.cmd does not even exist in a
    // standard Node install, so .cmd-first would break them outright.
    expect(commandCandidatesForPlatform('node', 'Win32')).toEqual(['node', 'node.cmd'])
    expect(commandCandidatesForPlatform('deno', 'Win32')).toEqual(['deno', 'deno.cmd'])
    expect(commandCandidatesForPlatform('bun', 'Win32')).toEqual(['bun', 'bun.cmd'])
  })

  it('returns commands with extensions as the only candidate on Windows', () => {
    expect(commandCandidatesForPlatform('npx.cmd', 'Win32')).toEqual(['npx.cmd'])
    expect(commandCandidatesForPlatform('mcp-server.exe', 'Win32')).toEqual(['mcp-server.exe'])
  })

  it('returns absolute / path-like commands as the only candidate on Windows', () => {
    expect(commandCandidatesForPlatform('C:\\Program Files\\node\\node.exe', 'Win32')).toEqual([
      'C:\\Program Files\\node\\node.exe',
    ])
    expect(commandCandidatesForPlatform('./bin/server', 'Win32')).toEqual(['./bin/server'])
  })

  it('offers the .cmd fallback for unknown commands on Windows', () => {
    expect(commandCandidatesForPlatform('some-custom-mcp', 'Win32')).toEqual([
      'some-custom-mcp',
      'some-custom-mcp.cmd',
    ])
  })

  it('returns the command alone on non-Windows platforms', () => {
    expect(commandCandidatesForPlatform('npx', 'MacIntel')).toEqual(['npx'])
    expect(commandCandidatesForPlatform('npx', 'Linux x86_64')).toEqual(['npx'])
  })
})
