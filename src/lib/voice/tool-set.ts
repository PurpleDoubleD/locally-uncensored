// Which tools a voice session offers.
//
// The agent chat routes its catalog per message. A voice session fixes its
// tools at the start, and every one of them is part of every request. With a
// local model that is the cost of the first answer: the whole catalog is
// about 6100 prompt tokens, which Qwen3.5-9B on an M5 Pro takes 13.7 s to
// read, and which does not fit a 4096 token window at all. The short set
// below is about 2900 tokens and 6.3 s (measured 06.10.2026).
//
// So a local model gets the short set: what people ask for by voice (look
// something up, read and write files, run a command, do something on the
// screen). A cloud model reads the long catalog in well under a second and
// keeps all of it.
//
// In both cases `computer_use` stays out when `computer_task` is offered. A
// voice session gets tool results as text, so a tool that answers with a
// screenshot is of no use to it; the task tool does the looking.

import type { MCPToolDefinition } from '../../api/mcp/types'
import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from '../computer/prompt'

export const LOCAL_VOICE_TOOLS: ReadonlySet<string> = new Set([
  'web_search', 'web_fetch', 'web_research',
  'file_read', 'file_write', 'file_edit', 'file_list', 'file_search',
  'shell_execute',
  COMPUTER_TASK_TOOL_NAME,
])

export function voiceToolSet(defs: readonly MCPToolDefinition[], localModel: boolean): MCPToolDefinition[] {
  const hasTask = defs.some((tool) => tool.name === COMPUTER_TASK_TOOL_NAME)
  return defs.filter((tool) => {
    if (hasTask && tool.name === COMPUTER_USE_TOOL_NAME) return false
    // A tool from an MCP server is one the user added on purpose. It stays.
    if (localModel && tool.source === 'builtin' && !LOCAL_VOICE_TOOLS.has(tool.name)) return false
    return true
  })
}

/** How many tokens of conversation a session keeps before it summarizes. */
export function voiceContextLimit(localModel: boolean): number {
  // A local server answers through its OpenAI endpoint with whatever window
  // it loaded the model with, often 4096 or 8192, and does not say which.
  // 3000 tokens of talk plus the short tool set stays inside 8192.
  return localModel ? 3000 : 16_000
}
