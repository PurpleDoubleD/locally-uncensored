// Did this run read foreign content? (C60 S3, 3.1.0)
//
// David's hard rule (24.10.2026): web pages, files and tool output are data,
// never orders. A run that changes LU itself is the target of exactly that
// kind of order ("summarise this page" → the page says "turn on the local
// API"). So the executor marks the run the moment a tool hands back content
// from outside, and the self-control tools read the mark:
//  - a normal card still comes, with a line that says what was read before;
//  - a strong card (local API, phone remote, a download by link) does not come
//    at all in such a run. The user asks again in a message of their own.
//
// Fail closed: a tool counts as foreign unless it is on the short list below
// of tools whose output is LU's own (a status line, a value LU just wrote).
// A new tool, an MCP tool, a sub-agent: foreign until someone decides
// otherwise here.

import type { AgentRunContext } from '../api/agent-context'

const OWN_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  'todo_write', 'file_write', 'file_edit',
  'get_settings', 'set_setting', 'set_settings', 'lu_models', 'lu_service', 'lu_download', 'lu_open_settings',
  'image_generate', 'video_generate', 'create_options', 'create_order',
  // C60 S5: LU's own structured workflow report. Names from a source are cut
  // to letters, digits and ._-+()/ (at most 80), descriptions, notes and
  // prompt texts never reach the model, only their length (workflow-tools.ts,
  // tested there).
  'workflow_find', 'workflow_inspect', 'workflow_install', 'workflow_assign',
])

/** True when this tool's output is content from outside LU. */
export function toolTaints(toolName: string): boolean {
  return !OWN_OUTPUT_TOOLS.has(toolName)
}

/** Called by the executor after every dispatched call. The first foreign
 *  source stays; later ones do not overwrite it. */
export function markRunTaint(run: AgentRunContext | undefined, toolName: string): void {
  if (!run || !toolTaints(toolName) || run.taint) return
  run.taint = { tool: toolName, at: Date.now() }
}

/** For the card and the refusal: what the run read, in a few words. */
export function taintLabel(run: AgentRunContext | undefined): string | undefined {
  const t = run?.taint
  if (!t) return undefined
  const what: Record<string, string> = {
    web_fetch: 'a web page', web_search: 'web search results', file_read: 'a file', file_search: 'file contents',
    file_list: 'a folder listing', shell_execute: 'command output', delegate_task: 'a sub-agent\'s answer',
    check_tasks: 'a background task\'s answer', run_workflow: 'a workflow\'s output', screenshot: 'a screenshot',
  }
  return `${what[t.tool] ?? 'output of the tool'} (${t.tool})`
}
