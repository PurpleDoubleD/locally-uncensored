/**
 * Tool calls in words. A phone shows "Search the web" and what for, not a
 * function name with a JSON object. The technical name stays available in the
 * details for anyone who wants it.
 */
import type { AgentToolCall, ToolCallStatus } from '../../../../types/agent-mode'
import { AGENT_STRINGS as T } from '../../../strings/agent'
import { PERMISSION_GROUPS, type PermissionGroupId } from './permission-groups'

type Args = Record<string, unknown>

function text(args: Args, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** The last part of a path: the user thinks in file names, the folder is always this chat. */
export function fileName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return at >= 0 ? clean.slice(at + 1) : clean
}

/** "example.com" from an address, or the address itself when it cannot be read. */
export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host || url
  } catch {
    return url
  }
}

/**
 * Does this path climb out of the folder of this chat: "../../x.txt".
 * Such a call is refused, and its row must say what was asked. "x.txt in this
 * chat" would name a file nobody asked for (r6 Nachpruefung Android, N10).
 * An absolute path keeps the short form: a row never shows a path of the device.
 */
export function leavesChat(path: string): boolean {
  return path.split(/[\\/]+/).includes('..')
}

/** A file of this chat by its name, a path out of the chat as it was written. */
function fileTarget(path: string): string {
  return leavesChat(path) ? path : T.tools.inThisChat(fileName(path))
}

const TOOL_NAMES: Record<string, string> = T.tools.names

/** What the tool does, in words ("Write a file"). An unknown tool keeps its own name. */
export function toolTitle(name: string): string {
  return TOOL_NAMES[name] ?? name.replace(/_/g, ' ')
}

/** What it acts on ("notes.md in this chat", "example.com"). Empty when the call names nothing. */
export function toolTarget(name: string, rawArgs: unknown): string {
  const args: Args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Args) : {}
  switch (name) {
    case 'web_search':
    case 'web_research':
      return text(args, 'query', 'q')
    case 'web_fetch':
      return hostOf(text(args, 'url'))
    case 'file_read':
    case 'file_write':
    case 'file_edit': {
      const path = text(args, 'path', 'file', 'filename')
      return path ? fileTarget(path) : ''
    }
    case 'file_list': {
      const path = text(args, 'path')
      return path && path !== '.' ? fileTarget(path) : T.tools.filesOfChat
    }
    case 'file_search':
      return text(args, 'pattern', 'query')
    case 'run_workflow':
      return text(args, 'name', 'workflow')
    case 'delegate_task':
      return text(args, 'goal', 'task')
    case 'message_agent':
      return text(args, 'message')
    default:
      return ''
  }
}

export type CallState = 'waiting' | 'running' | 'done' | 'failed' | 'denied' | 'stopped'

export function callState(status: ToolCallStatus): CallState {
  switch (status) {
    case 'pending_approval':
      return 'waiting'
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'rejected':
      return 'denied'
    case 'stopped':
      return 'stopped'
    default:
      return 'done'
  }
}

export const CALL_STATE_TEXT: Record<CallState, string> = T.tools.state

/** "1.2 s" or "340 ms". Empty when the call has no duration yet. */
export function callDuration(call: Pick<AgentToolCall, 'duration' | 'startedAt' | 'completedAt'>): string {
  const ms = typeof call.duration === 'number' ? call.duration : call.startedAt && call.completedAt ? call.completedAt - call.startedAt : null
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/** Accessible name of a tool row: what, on what, how it went, how long. */
export function callName(call: AgentToolCall): string {
  const target = toolTarget(call.toolName, call.args)
  const parts = [toolTitle(call.toolName), target, CALL_STATE_TEXT[callState(call.status)], callDuration(call)]
  return parts.filter(Boolean).join(', ')
}

/** The line a failed call shows: "web_search failed: no internet" (DESIGN.md 5.1). */
export function callFailure(call: AgentToolCall): string {
  const reason = (call.error || call.result || '').replace(/^Error:\s*/i, '').trim()
  return reason ? T.tools.failedWith(call.toolName, reason.slice(0, 240)) : T.tools.failed(call.toolName)
}

/** The arguments as readable lines for the details. Long values are cut, the cut is said. */
export function argLines(rawArgs: unknown, max = 600): Array<{ key: string; value: string }> {
  if (!rawArgs || typeof rawArgs !== 'object') return []
  return Object.entries(rawArgs as Args).map(([key, value]) => {
    const full = typeof value === 'string' ? value : JSON.stringify(value)
    const shown = full === undefined ? '' : full
    return { key, value: shown.length > max ? `${shown.slice(0, max)} ${T.tools.cut(shown.length - max)}` : shown }
  })
}

const TOOL_GROUP: Record<string, PermissionGroupId> = {
  web_search: 'web',
  web_fetch: 'web',
  web_research: 'web',
  file_read: 'files',
  file_write: 'files',
  file_edit: 'files',
  file_list: 'files',
  file_search: 'files',
  run_workflow: 'workflows',
  delegate_task: 'subagents',
}

/** The permission group "Always allow in this chat" would switch for this tool, or null when it has none. */
export function groupOfTool(name: string): PermissionGroupId | null {
  const id = TOOL_GROUP[name]
  return id && PERMISSION_GROUPS.some((g) => g.id === id) ? id : null
}
