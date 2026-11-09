import { getBlockToolCalls } from '../../api/agents/block-helpers'
import type { AgentBlock } from '../../types/agent-mode'
import type { StatusKind } from './glyph-motifs'

/** What a surface knows about a run right now. Everything is optional: a surface passes what it has. */
export interface RunSignals {
  /** A call waits for the user's decision. Beats everything else. */
  awaitingApproval?: boolean
  /** A local model is being loaded and has not produced a token yet. */
  loadingModel?: boolean
  /**
   * What the run itself reports: a tool call the model is still writing (the
   * default), or a named state such as a context summary or a wait before a
   * retry.
   */
  activity?: { label: string; detail?: string; kind?: 'compacting' | 'retrying' | 'reading' | 'thinking' }
  /** The assistant message the run is filling. */
  message?: { content?: string; thinking?: string; agentBlocks?: AgentBlock[] }
}

export interface RunStatus {
  kind: StatusKind
  /** The status word, in English. */
  word: string
  detail?: string
}

const WAITING = 'Waiting for your approval'

interface ToolFace {
  kind: StatusKind
  /** While the tool runs: "Searching". */
  word: string
  /** While the model is still writing the call: "Preparing to search". */
  preparing: string
  /** In the question before it runs, after "wants to": "use the web". */
  asking: string
}

/** Tool name to the face the mark shows while that tool runs. Names not listed get the generic face. */
const TOOL_FACES: Record<string, ToolFace> = {}
const face = (kind: StatusKind, word: string, preparing: string, asking: string, names: string[]) => {
  for (const name of names) TOOL_FACES[name] = { kind, word, preparing, asking }
}
face('reading', 'Reading', 'Preparing to read', 'read files', ['file_read', 'file_list', 'file_search'])
face('writing', 'Writing', 'Preparing to write', 'change a file', ['file_write', 'file_edit'])
face('running', 'Running', 'Preparing to run', 'run a command', [
  'shell_execute', 'shell_execute_background', 'shell_task_status', 'shell_task_kill', 'shell_task_list',
  'code_execute', 'run_tests', 'pr_resume', 'git_status', 'git_log', 'git_diff', 'git_commit', 'git_push', 'gh_pr_create',
])
face('searching', 'Searching', 'Preparing to search', 'use the web', ['web_search', 'web_fetch', 'web_research', 'browser_open', 'browser_snapshot', 'browser_scroll', 'browser_click_link', 'browser_screenshot'])
face('looking', 'Looking', 'Preparing to look', 'look at the screen', ['screenshot'])
// Computer control clicks and types as well as looks. The mark keeps the
// viewfinder; the word says that the work happens on the screen.
face('looking', 'Working on the screen', 'Preparing to work on the screen', 'work on the screen', ['computer_use', 'computer_task'])
face('creating', 'Creating', 'Preparing to create', 'create a picture or a video', ['image_generate', 'video_generate'])
face('delegating', 'Delegating', 'Preparing to delegate', 'hand work to another agent', ['delegate_task', 'check_tasks', 'message_agent'])

const GENERIC_FACE: ToolFace = { kind: 'tool', word: 'Using tool', preparing: 'Preparing a tool', asking: 'use a tool' }

/**
 * What the status says while the model is still writing a call to this tool.
 * In words, never the tool's internal name: "Preparing web_search" read like
 * a debug line (found in the Windows run of 07.10.2026).
 */
export function preparingWord(toolName: string): string {
  return (TOOL_FACES[toolName] ?? GENERIC_FACE).preparing
}

/**
 * What a tool is about to do, for the question before it runs: the words
 * after "wants to". As with the status, never the tool's internal name.
 */
export function askingWord(toolName: string): string {
  return (TOOL_FACES[toolName] ?? GENERIC_FACE).asking
}

/** A single call of computer control that only reads the screen. */
const SCREEN_READS = new Set(['screenshot', 'read_tree'])

export function toolFace(toolName: string, args?: Record<string, unknown>): { kind: StatusKind; word: string } {
  if (toolName === 'computer_use' && typeof args?.action === 'string' && SCREEN_READS.has(args.action)) {
    return { kind: 'looking', word: 'Looking' }
  }
  const { kind, word } = TOOL_FACES[toolName] ?? GENERIC_FACE
  return { kind, word }
}

function runningTool(blocks: AgentBlock[] | undefined): { name: string; args?: Record<string, unknown> } | null {
  if (!blocks) return null
  for (const block of blocks) {
    for (const call of getBlockToolCalls(block)) if (call.status === 'running') return { name: call.toolName, args: call.args }
  }
  return null
}

/**
 * The one state a run is in, from what the stores already hold. Order is the
 * order of urgency: a wait for the user first, then what is being done right
 * now, then what is streaming, and "Working" for the gaps between steps.
 */
export function deriveRunStatus(signals: RunSignals): RunStatus {
  if (signals.awaitingApproval) return { kind: 'approval', word: WAITING }
  if (signals.loadingModel) return { kind: 'loading', word: 'Loading model' }

  const message = signals.message
  const tool = runningTool(message?.agentBlocks)
  const hasContent = !!message?.content?.trim()
  const hasThinking = !!message?.thinking?.trim()
  // The first wait of a turn (A7) gives way as soon as the model shows
  // anything: its text, a thought or a call outrank "Reading the
  // conversation", and the line never falls back to "Starting" in between.
  const firstWait = signals.activity?.kind === 'reading' || signals.activity?.kind === 'thinking'
  if (signals.activity && !(firstWait && (tool || hasContent || hasThinking))) {
    return { kind: signals.activity.kind ?? 'preparing', word: signals.activity.label, detail: signals.activity.detail }
  }

  if (tool) return toolFace(tool.name, tool.args)
  if (hasThinking && !hasContent) return { kind: 'thinking', word: 'Thinking' }
  if (hasContent) return { kind: 'responding', word: 'Responding' }
  // Nothing has come back at all: the first wait of a run. Later rounds of an
  // agent run already carry blocks, and their waits are the gaps between steps.
  if (message && !message.agentBlocks?.length) return { kind: 'starting', word: 'Starting' }
  return { kind: 'working', word: 'Working' }
}
