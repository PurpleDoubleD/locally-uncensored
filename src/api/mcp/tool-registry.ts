// Dynamic Tool Registry — MCP-shaped, replaces hardcoded AGENT_TOOL_DEFS

import type { MCPToolDefinition, PermissionMap, PermissionLevel } from './types'
import type { OllamaTool } from '../../types/agent-mode'
import type { ToolDefinition } from '../providers/types'

type ToolExecutor = (args: Record<string, any>) => Promise<string>
/**
 * External-tool executor gets the tool name too, because one MCP server
 * owns many tools and routes by name. The registry wraps it into a
 * per-tool ToolExecutor closure so the Map lookup stays {name → executor}.
 */
type ExternalToolExecutor = (toolName: string, args: Record<string, any>) => Promise<string>

interface RegisteredTool {
  definition: MCPToolDefinition
  executor: ToolExecutor
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  // ── Registration ──────────────────────────────────────────────

  registerBuiltin(tool: MCPToolDefinition, executor: ToolExecutor) {
    this.tools.set(tool.name, { definition: tool, executor })
  }

  /**
   * Register all tools from an external MCP server. The executor receives
   * both the tool name and args, letting one MCP client back many tools
   * (which is how MCP servers actually work — one `tools/call` endpoint,
   * dispatched by name).
   *
   * Also accepts the legacy single-arg executor shape for backward compat
   * — tests and older callers can still pass `(args) => ...` and the
   * registry will call it unchanged. Prefer the two-arg shape in new code.
   */
  registerExternal(
    serverId: string,
    tools: MCPToolDefinition[],
    executor: ExternalToolExecutor | ToolExecutor
  ) {
    const isTwoArg = executor.length >= 2
    for (const tool of tools) {
      const name = tool.name
      const bound: ToolExecutor = isTwoArg
        ? (args: Record<string, any>) =>
            (executor as ExternalToolExecutor)(name, args)
        : (executor as ToolExecutor)
      this.tools.set(name, {
        definition: { ...tool, source: 'external', serverId },
        executor: bound,
      })
    }
  }

  unregisterServer(serverId: string) {
    for (const [name, entry] of this.tools) {
      if (entry.definition.serverId === serverId) {
        this.tools.delete(name)
      }
    }
  }

  // ── Query ─────────────────────────────────────────────────────

  getAll(): MCPToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  getAvailableTools(permissions: PermissionMap): MCPToolDefinition[] {
    return this.getAll().filter(t => permissions[t.category] !== 'blocked')
  }

  getToolByName(name: string): MCPToolDefinition | undefined {
    return this.tools.get(name)?.definition
  }

  getPermissionLevel(toolName: string, permissions: PermissionMap): PermissionLevel {
    const tool = this.tools.get(toolName)?.definition
    if (!tool) return 'confirm'
    return permissions[tool.category]
  }

  /**
   * Phase 12 — resolve the effective permission for a tool with a per-tool
   * override map layered on top of category defaults. The override map is
   * typically sourced from permissionStore.perToolOverrides and takes
   * precedence over the category permission; when no override exists we
   * fall back to getPermissionLevel() semantics.
   */
  getPermissionLevelWithOverrides(
    toolName: string,
    permissions: PermissionMap,
    perToolOverrides: Record<string, PermissionLevel>
  ): PermissionLevel {
    const override = perToolOverrides[toolName]
    if (override) return override
    return this.getPermissionLevel(toolName, permissions)
  }

  // ── Execution ─────────────────────────────────────────────────

  async execute(name: string, args: Record<string, any>, maxRetries = 1): Promise<string> {
    const entry = this.tools.get(name)
    if (!entry) return `Error: Unknown tool "${name}"`

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await entry.executor(args)
        // If result is an error and we have retries left, retry
        if (result.startsWith('Error:') && attempt < maxRetries) {
          // Only retry on transient errors (timeout, network)
          const isTransient = result.includes('timed out') || result.includes('ECONNREFUSED') || result.includes('fetch failed')
          if (isTransient) continue
        }
        return result
      } catch (err) {
        if (attempt < maxRetries) continue
        const message = err instanceof Error ? err.message : String(err)
        return `Error: ${message}`
      }
    }
    return `Error: Max retries exceeded for "${name}"`
  }

  // ── Format Conversion ─────────────────────────────────────────

  toOllamaTools(permissions: PermissionMap): OllamaTool[] {
    return this.getAvailableTools(permissions).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }

  toOpenAITools(permissions: PermissionMap): ToolDefinition[] {
    return this.getAvailableTools(permissions).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }

  toHermesToolDefs(permissions: PermissionMap): { name: string; description: string; parameters: any }[] {
    return this.getAvailableTools(permissions).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }))
  }
}

// ── Singleton ────────────────────────────────────────────────────

export const toolRegistry = new ToolRegistry()
