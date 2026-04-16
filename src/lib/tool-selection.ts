/**
 * Intelligent Tool Selection — reduce token usage by only including relevant tools.
 *
 * Instead of sending all 13 tools in every request (wasting context),
 * analyze the user message and only include tools likely to be needed.
 * Saves up to 80% of tool-definition tokens.
 */

import type { MCPToolDefinition, PermissionMap } from '../api/mcp/types'

interface ToolGroup {
  keywords: string[]
  tools: string[]
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    keywords: ['search', 'find online', 'look up', 'google', 'internet', 'news', 'latest', 'current'],
    tools: ['web_search', 'web_fetch'],
  },
  {
    keywords: ['read', 'open', 'show', 'cat', 'content of', 'what does', 'look at', 'check file'],
    tools: ['file_read'],
  },
  {
    keywords: ['write', 'create', 'save', 'make a file', 'put', 'generate file', 'output to'],
    tools: ['file_write'],
  },
  {
    keywords: ['list', 'ls', 'dir', 'files in', 'directory', 'folder', 'what files', 'tree'],
    tools: ['file_list'],
  },
  {
    keywords: ['search file', 'grep', 'find in', 'contains', 'where is', 'which file'],
    tools: ['file_search'],
  },
  {
    keywords: ['run', 'execute', 'command', 'shell', 'terminal', 'bash', 'powershell', 'npm', 'git', 'pip', 'node', 'python', 'install', 'build', 'test', 'compile'],
    tools: ['shell_execute', 'code_execute'],
  },
  {
    keywords: ['system', 'os', 'cpu', 'ram', 'memory', 'process', 'running', 'hostname'],
    tools: ['system_info', 'process_list'],
  },
  {
    keywords: ['screenshot', 'screen', 'desktop', 'capture', 'see my screen'],
    tools: ['screenshot'],
  },
  {
    keywords: ['image', 'picture', 'generate image', 'draw', 'create image'],
    tools: ['image_generate'],
  },
  {
    keywords: ['workflow', 'run workflow', 'automate'],
    tools: ['run_workflow'],
  },
  {
    keywords: ['time', 'date', 'day', 'today', 'datum', 'heute', 'tag', 'uhrzeit', 'jetzt', 'now', 'clock', 'hour', 'minute', 'timezone', 'zeitzone'],
    tools: ['get_current_time'],
  },
]

// Tools that should always be available regardless of the prompt — they're
// cheap to include, commonly useful, and often needed mid-run (e.g. after
// a tool result reveals the user really wanted a file read). Keeping
// `get_current_time` here means the agent NEVER has to fall back to web
// for a trivial date question just because the keyword list missed.
export const ALWAYS_INCLUDE = ['file_read', 'file_write', 'get_current_time']

/** Tool count at which embedding-based routing becomes worth the round trip. */
export const EMBEDDING_ROUTING_THRESHOLD = 15

import type { EmbeddingFn } from '../api/agents/embedding-router'
import { selectToolsByEmbedding } from '../api/agents/embedding-router'

/**
 * Select relevant tools based on user message content.
 * Returns a filtered list of tool names.
 */
export function selectRelevantTools(
  userMessage: string,
  allTools: MCPToolDefinition[],
  permissions: PermissionMap,
): MCPToolDefinition[] {
  const msg = userMessage.toLowerCase()
  const selectedNames = new Set<string>(ALWAYS_INCLUDE)

  // Match tool groups by keywords
  for (const group of TOOL_GROUPS) {
    if (group.keywords.some(kw => msg.includes(kw))) {
      group.tools.forEach(t => selectedNames.add(t))
    }
  }

  // If very few tools matched, include all (model might need flexibility)
  // This handles generic messages like "help me with this project"
  if (selectedNames.size <= 3) {
    // Include common tools for generic requests
    selectedNames.add('shell_execute')
    selectedNames.add('file_list')
    selectedNames.add('file_search')
    selectedNames.add('web_search')
  }

  // Filter by permissions (blocked categories excluded)
  const available = allTools.filter(t => permissions[t.category] !== 'blocked')

  // Return only selected tools that are available
  const selected = available.filter(t => selectedNames.has(t.name))

  // Safety: if nothing matched at all, return all available tools
  if (selected.length === 0) return available

  return selected
}

/**
 * Embedding-aware variant (Phase 9 v2.4.0). When `embed` is provided AND
 * the permission-filtered tool count exceeds EMBEDDING_ROUTING_THRESHOLD,
 * rank tools by semantic similarity to the user message and union the
 * result with the keyword-based selection (belt + braces). When `embed`
 * is absent, throws, or fails, silently falls back to the keyword-only
 * path.
 */
export async function selectRelevantToolsAsync(
  userMessage: string,
  allTools: MCPToolDefinition[],
  permissions: PermissionMap,
  opts?: { embed?: EmbeddingFn; embeddingThreshold?: number; topN?: number },
): Promise<MCPToolDefinition[]> {
  const threshold = opts?.embeddingThreshold ?? EMBEDDING_ROUTING_THRESHOLD
  const available = allTools.filter((t) => permissions[t.category] !== 'blocked')
  if (!opts?.embed || available.length <= threshold) {
    return selectRelevantTools(userMessage, allTools, permissions)
  }
  try {
    const semanticNames = await selectToolsByEmbedding(
      userMessage,
      available.map((t) => ({ name: t.name, description: t.description })),
      opts.embed,
      { topN: opts.topN ?? 10, alwaysInclude: ALWAYS_INCLUDE },
    )
    const keyword = selectRelevantTools(userMessage, allTools, permissions)
    const union = new Set<string>([...semanticNames, ...keyword.map((t) => t.name)])
    return available.filter((t) => union.has(t.name))
  } catch {
    return selectRelevantTools(userMessage, allTools, permissions)
  }
}
