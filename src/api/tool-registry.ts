/**
 * Compatibility shim — delegates to new MCP tool registry.
 * Existing imports from this file continue to work.
 */

import { toolRegistry, DEFAULT_PERMISSIONS } from './mcp'
import type { AgentToolDef, OllamaTool } from '../types/agent-mode'
import type { ToolArgs } from './mcp/types'

// ── Legacy exports (delegate to new registry) ─────────────────

/** @deprecated Use toolRegistry.getAll() */
export const AGENT_TOOL_DEFS: AgentToolDef[] = toolRegistry.getAll().map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.inputSchema,
  permission: DEFAULT_PERMISSIONS[t.category] === 'auto' ? 'auto' as const : 'confirm' as const,
}))

/** @deprecated Use toolRegistry.toOllamaTools(permissions) */
export function getOllamaTools(): OllamaTool[] {
  return toolRegistry.toOllamaTools(DEFAULT_PERMISSIONS)
}

/** @deprecated Use toolRegistry.getToolByName(name) */
export function getToolByName(name: string): AgentToolDef | undefined {
  return AGENT_TOOL_DEFS.find((t) => t.name === name)
}

/** @deprecated Use toolRegistry.getPermissionLevel(name, permissions) */
export function getToolPermission(name: string): 'auto' | 'confirm' {
  const level = toolRegistry.getPermissionLevel(name, DEFAULT_PERMISSIONS)
  return level === 'auto' ? 'auto' : 'confirm'
}

/** @deprecated Use toolRegistry.execute(name, args) */
export async function executeAgentTool(
  name: string,
  args: ToolArgs
): Promise<string> {
  return toolRegistry.execute(name, args)
}
