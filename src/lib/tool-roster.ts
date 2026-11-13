/**
 * The tool list a system prompt shows the model, generated from the registry
 * instead of typed out by hand (2026-08-05).
 *
 * Every agent prompt carried its own hand-written "Available tools:" block, and
 * every one of them had fallen behind: the Agent prompt listed 15 of the 30
 * registered builtins. Missing were `file_edit` (so Agent mode rewrote whole
 * files where Code mode edits them), the entire git set, `run_tests`, the
 * background shell, and `todo_write`, a tool the model only ever uses if the
 * prompt tells it to.
 *
 * A name the prompt does not mention is a tool the model does not reach for,
 * whatever the request payload says, so this drift is silent capability loss.
 *
 * The roster is built from the tools the run will actually offer, after the
 * permission filter, so a blocked category is never advertised either.
 */

import type { MCPToolDefinition, ToolCategory } from '../api/mcp/types'

/**
 * Prompt-facing groups. Deliberately coarser than ToolCategory: the permission
 * model needs `terminal` and `desktop` apart, a model reading a prompt does
 * not. Order is the order they appear in the prompt.
 */
const GROUPS: { label: string; categories: ToolCategory[] }[] = [
  { label: 'Files', categories: ['filesystem'] },
  { label: 'Shell and git', categories: ['terminal'] },
  { label: 'Web', categories: ['web'] },
  { label: 'System', categories: ['system', 'desktop'] },
  { label: 'Creative', categories: ['image', 'video', 'workflow'] },
  { label: 'MCP servers', categories: ['mcp'] },
]

/**
 * A grouped roster for the full prompts:
 *   Files: file_read, file_write, …
 *   Shell and git: shell_execute, git_status, …
 *
 * Tools whose category is not in any group still appear, under "Other", so a
 * new ToolCategory can never make a tool invisible to the model.
 */
export function renderToolRoster(tools: MCPToolDefinition[]): string {
  const seen = new Set<string>()
  const lines: string[] = []

  for (const group of GROUPS) {
    const names = tools
      .filter((t) => group.categories.includes(t.category))
      .map((t) => t.name)
    names.forEach((n) => seen.add(n))
    if (names.length > 0) lines.push(`- ${group.label}: ${names.join(', ')}`)
  }

  const rest = tools.map((t) => t.name).filter((n) => !seen.has(n))
  if (rest.length > 0) lines.push(`- Other: ${rest.join(', ')}`)

  return lines.join('\n')
}

/**
 * A flat, comma-separated roster for the lean prompts.
 *
 * Small-Model Mode caps the request at 6 semantically-ranked tools, so listing
 * all 30 in a prompt meant for a 3B model would be both long and mostly untrue.
 * Callers pass the set that is actually guaranteed to be there (ALWAYS_INCLUDE),
 * and the sentence around it tells the model the rest is in its tool list.
 */
export function renderToolNames(tools: MCPToolDefinition[]): string {
  return tools.map((t) => t.name).join(', ')
}
