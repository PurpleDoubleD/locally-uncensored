/**
 * What a tool call row says, in words (CA U1).
 *
 * The row used to print the tool's internal name in 9 px italics
 * (`shell_execute`, `file_edit`) and hide what it did behind a click. The large
 * coding tools all show a short sentence instead: "Ran `npm test`", "Edited
 * `src/math.ts`", "Read 3 files". The internal name stays in the row's
 * tooltip and `data-tool`, for support and for tests.
 *
 * Pure: (name, args, status) → title parts. The row decides how to draw them.
 */
import type { ToolCallStatus } from '../types/agent-mode'

export interface ToolCallTitle {
  /** "Ran", "Running", "Wants to run". */
  verb: string
  /** What it acted on: a path, a command, a query. Drawn in monospace when `mono`. */
  target?: string
  mono?: boolean
}

interface Verbs { past: string; now: string; ask: string }

const V = (past: string, now: string, ask: string): Verbs => ({ past, now, ask })

const VERBS: Record<string, Verbs> = {
  file_read: V('Read', 'Reading', 'Wants to read'),
  file_write: V('Wrote', 'Writing', 'Wants to write'),
  file_edit: V('Edited', 'Editing', 'Wants to edit'),
  file_list: V('Listed', 'Listing', 'Wants to list'),
  file_search: V('Searched for', 'Searching for', 'Wants to search for'),
  shell_execute: V('Ran', 'Running', 'Wants to run'),
  code_execute: V('Ran code', 'Running code', 'Wants to run code'),
  web_search: V('Searched the web for', 'Searching the web for', 'Wants to search the web for'),
  web_research: V('Researched', 'Researching', 'Wants to research'),
  web_fetch: V('Opened', 'Opening', 'Wants to open'),
  browser_open: V('Opened', 'Opening', 'Wants to open'),
  todo_write: V('Updated the plan', 'Updating the plan', 'Wants to update the plan'),
  delegate_task: V('Handed off', 'Handing off', 'Wants to hand off'),
  check_tasks: V('Checked the helpers', 'Checking the helpers', 'Wants to check the helpers'),
  message_agent: V('Messaged a helper', 'Messaging a helper', 'Wants to message a helper'),
  image_generate: V('Made a picture', 'Making a picture', 'Wants to make a picture'),
  video_generate: V('Made a video', 'Making a video', 'Wants to make a video'),
  screenshot: V('Took a screenshot', 'Taking a screenshot', 'Wants to take a screenshot'),
  tool_search: V('Looked for a tool', 'Looking for a tool', 'Wants to look for a tool'),
  memory: V('Memory', 'Memory', 'Wants to change memory'),
  session_search: V('Searched earlier chats for', 'Searching earlier chats for', 'Wants to search earlier chats for'),
  skill_view: V('Read the skill', 'Reading the skill', 'Wants to read the skill'),
  pr_resume: V('Looked at the pull request', 'Looking at the pull request', 'Wants to look at the pull request'),
  run_workflow: V('Ran a workflow', 'Running a workflow', 'Wants to run a workflow'),
}

const MAX_TARGET = 90

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function clip(s: string): string {
  const line = s.split('\n')[0]
  const more = s.includes('\n') ? ' …' : ''
  return line.length > MAX_TARGET ? `${line.slice(0, MAX_TARGET - 1)}…` : line + more
}

function urlTarget(u: string): string {
  try {
    const url = new URL(u)
    return clip(url.host + (url.pathname === '/' ? '' : url.pathname))
  } catch {
    return clip(u)
  }
}

/** `git_status` → "Git status"; `mcp-server: tool_name` keeps its server. */
function humanName(name: string): string {
  const s = name.replace(/_/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : name
}

function targetOf(name: string, args: Record<string, unknown>): { target?: string; mono?: boolean } {
  switch (name) {
    case 'file_read': case 'file_write': case 'file_edit': case 'file_list': {
      const p = str(args.path) || (name === 'file_list' ? '.' : '')
      return p ? { target: clip(p), mono: true } : {}
    }
    case 'file_search': {
      const q = str(args.pattern) || str(args.query) || str(args.regex)
      return q ? { target: clip(q), mono: true } : {}
    }
    case 'shell_execute': {
      const c = str(args.command)
      if (str(args.task)) return { target: `task ${str(args.task)}${str(args.id) ? ` ${str(args.id)}` : ''}`, mono: true }
      return c ? { target: clip(c), mono: true } : {}
    }
    case 'web_search': case 'web_research': case 'session_search': case 'tool_search': {
      const q = str(args.query) || str(args.q)
      return q ? { target: clip(q) } : {}
    }
    case 'web_fetch': case 'browser_open': {
      const u = str(args.url)
      return u ? { target: urlTarget(u), mono: true } : {}
    }
    case 'delegate_task': {
      const g = str(args.goal)
      return g ? { target: clip(g) } : {}
    }
    case 'image_generate': case 'video_generate': {
      const p = str(args.prompt)
      return p ? { target: clip(p) } : {}
    }
    case 'memory': {
      const a = str(args.action)
      return a ? { target: a } : {}
    }
    case 'skill_view': {
      const n = str(args.name)
      return n ? { target: n, mono: true } : {}
    }
    default:
      return {}
  }
}

export function toolCallTitle(
  name: string,
  args: Record<string, unknown> | undefined,
  status: ToolCallStatus,
  displayName?: string,
): ToolCallTitle {
  // A workflow step carries its own label as its name ("Step 2 of 6: …").
  if (name.startsWith('Step ') || name.startsWith('Workflow')) return { verb: name }
  const a = args ?? {}
  const verbs = VERBS[name]
  if (!verbs) {
    // External (MCP) tools keep "<server>: <tool>"; everything else reads as words.
    const label = displayName && displayName !== name ? displayName : humanName(name)
    return { verb: status === 'pending_approval' ? `Wants to use ${label}` : label }
  }
  const verb = status === 'pending_approval'
    ? verbs.ask
    : status === 'running'
      ? verbs.now
      : status === 'rejected'
        ? `Declined: ${verbs.ask.replace(/^Wants to /, '')}`
        : verbs.past
  return { verb, ...targetOf(name, a) }
}

/** "+3 −1" from a unified diff, or null. */
export function diffStat(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return added || removed ? { added, removed } : null
}

/** The exit code of a shell result ("Error (2):" first line), or null for success/unknown. */
export function shellExitCode(result: string | undefined): number | null {
  const m = /^Error \((-?\d+)\):/.exec(result ?? '')
  return m ? Number(m[1]) : null
}

/** True when the title already says what the call does (no raw-args block needed). */
export function hasToolTitle(name: string): boolean {
  return name in VERBS
}

/** Terminal colour codes out of shell output (they show as `[32m` otherwise). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')
}
