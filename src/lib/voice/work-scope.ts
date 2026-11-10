// What a voice session may do on the computer, and where.
//
// Two switches sit at the top of the Voice surface. "Agent" decides whether
// the model may work on the computer. Off, it still looks things up on the
// web, as the plain chat does since 3.0.7 (GitHub #187: a voice question
// about today got an answer from the training data). "Where it may work"
// decides how far the agent reaches:
//
//   workspace  Files only inside the folder of the session (the file tools
//              are held there by the path jail on the Rust side), commands
//              start in that folder and ask every time, no screen.
//   computer   Files and commands anywhere the user's own permissions allow,
//              plus the screen.
//
// A third level, a sandbox that really isolates commands, is not here
// because LU has none: a command is a program on this computer, and nothing
// in the app can fence in what it does once it runs. That is also why the
// workspace level asks before every command and refuses one that names a
// place outside the folder: the refusal is a tripwire for the honest case,
// the question is the boundary.
//
// This file decides, the executor enforces: the session asks it which tools
// to offer, and the tool bridge asks it again before every single call. No
// React, no store, no network.

import type { PermissionLevel } from '../../api/mcp/types'
import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from '../computer/prompt'
import { compareKey, isAbsolutePath, lexicalNormalize } from '../dev-fs-jail'
import type { AgentWorkspace } from '../../types/agent-workspace'

export type VoiceWorkScope = 'workspace' | 'computer'

export interface VoiceWork {
  /** The model gets the tools of the agent. Off, only the web tools. */
  agent: boolean
  scope: VoiceWorkScope
}

/** How long a thought may get, in tokens. The steps of the slider. */
export const THINKING_BUDGET_STEPS = [128, 256, 512, 1024, 2048, 4096] as const
export const DEFAULT_THINKING_BUDGET = 512

/** What a fresh installation starts with: tools on, the narrowest reach, no thinking. */
export const VOICE_WORK_DEFAULTS = {
  loopAgent: true,
  loopScope: 'workspace' as VoiceWorkScope,
  loopWorkspace: null as AgentWorkspace | null,
  loopComputerConfirmed: false,
  loopThinking: false,
  loopThinkingBudget: DEFAULT_THINKING_BUDGET,
}

/** The nearest step of the slider for a stored value. */
export function thinkingBudgetStep(tokens: number): number {
  if (!Number.isFinite(tokens)) return DEFAULT_THINKING_BUDGET
  return THINKING_BUDGET_STEPS.reduce((best, step) => (Math.abs(step - tokens) < Math.abs(best - tokens) ? step : best))
}

// `screenshot` is the older tool of the long catalog that captures the display.
const SCREEN_TOOLS: ReadonlySet<string> = new Set([COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME, 'screenshot'])
const SHELL_TOOLS: ReadonlySet<string> = new Set(['shell_execute'])
/**
 * What a session has with the agent off: the web pair of the plain chat's
 * tools (lib/chat-tool-intent.ts CHAT_TOOLS). Both only read, nothing on this
 * computer changes. The chat's other three write a file or start a render,
 * which a spoken conversation does not do without the agent.
 */
export const CONVERSATION_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch', 'web_research'])

export const AGENT_OFF_REFUSAL =
  'With the agent off this voice session can only look things up on the web. Tell the user that the Agent switch at the top of Voice lets it work with files, commands and the screen.'
export const SCREEN_REFUSAL =
  'This voice session may only work in its folder, not on the screen. Tell the user to set "Where it may work" at the top of Voice to "Whole computer" for that.'

/** A tool the model is shown under these switches. */
export function toolInScope(name: string, work: VoiceWork): boolean {
  if (!work.agent) return CONVERSATION_TOOLS.has(name)
  if (work.scope === 'workspace' && SCREEN_TOOLS.has(name)) return false
  return true
}

/**
 * The level a tool has under these switches, given the level the user's own
 * permissions gave it. The switches only ever narrow: a blocked tool stays
 * blocked, and "Whole computer" changes nothing about a permission.
 */
export function levelInScope(name: string, level: PermissionLevel, work: VoiceWork): PermissionLevel {
  if (!toolInScope(name, work)) return 'blocked'
  if (!work.agent) return level
  // A command cannot be held inside a folder, so the user sees each one.
  if (work.scope === 'workspace' && SHELL_TOOLS.has(name) && level === 'auto') return 'confirm'
  return level
}

function unquote(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, '')
}

/** Words of a command that can name a place: split at blanks and shell punctuation. */
function words(command: string): string[] {
  return command
    .split(/[\s;|&<>()]+/)
    .map(unquote)
    // `--out=/tmp/x` and `VAR=/tmp/x` name a place after the equals sign.
    .map((word) => (/^[-\w]+=/.test(word) ? unquote(word.slice(word.indexOf('=') + 1)) : word))
    .filter(Boolean)
}

/** Ways of naming the home folder or another folder of the system without writing its path. */
const HOME_WORD = /^~|\$\{?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP)\b|%(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|TEMP)%|\$env:/i
/** Places every command may name: they hold nothing. */
const NOWHERE = new Set(['/dev/null', 'nul', 'NUL', '/dev/stdin', '/dev/stdout', '/dev/stderr'])

function inside(root: string, path: string): boolean {
  const base = compareKey(lexicalNormalize(root))
  const target = compareKey(lexicalNormalize(path))
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

function join(base: string, relative: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${relative}`
}

/**
 * The first place a command names that lies outside the folder, or null.
 *
 * `root` is the folder of the session when the user picked one. A session
 * without one works in its own folder under the app's workspace directory,
 * whose path this side does not know: then every absolute path is outside.
 *
 * Read from the text of the command, so it catches what a model writes when
 * it means to leave (`cat ~/.ssh/id_rsa`, `cd ..`, `ls /etc`) and not what a
 * program does once it runs. The executable itself may live anywhere.
 */
export function placeOutsideWorkspace(command: string, cwd: string | undefined, root: string | null): string | null {
  // Judged against the real folder when it is known, else against a stand-in:
  // a relative path can be followed either way.
  const anchor = root ?? '/w'
  const start = cwd && cwd.trim() ? cwd.trim() : null
  let base = anchor
  if (start) {
    if (isAbsolutePath(start)) {
      if (!root || !inside(root, start)) return start
      base = start
    } else {
      base = lexicalNormalize(join(anchor, start))
      if (!inside(anchor, base)) return start
    }
  }
  for (const segment of command.split(/[;|&\n\r]+/)) {
    let executable = true
    for (const word of words(segment)) {
      const first = executable
      executable = false
      if (NOWHERE.has(word)) continue
      if (HOME_WORD.test(word)) return word
      if (isAbsolutePath(word)) {
        // The program itself may live anywhere.
        if (first) continue
        if (!root || !inside(root, word)) return word
        continue
      }
      if (!/(^|[\\/])\.\.([\\/]|$)/.test(word)) continue
      if (!inside(anchor, lexicalNormalize(join(base, word)))) return word
    }
  }
  return null
}

export interface ScopeCall {
  name: string
  args: Record<string, unknown>
}

/**
 * Why this call may not run under these switches, in words for the model, or
 * null when it may. Asked by the tool bridge before every call, whatever the
 * model was shown: a model can call a tool it was offered a minute ago.
 */
export function scopeRefusal(call: ScopeCall, work: VoiceWork, workspaceRoot: string | null): string | null {
  if (!work.agent) return CONVERSATION_TOOLS.has(call.name) ? null : AGENT_OFF_REFUSAL
  if (work.scope !== 'workspace') return null
  if (SCREEN_TOOLS.has(call.name)) return SCREEN_REFUSAL
  if (call.name === 'shell_execute') {
    const command = typeof call.args.command === 'string' ? call.args.command : ''
    const cwd = typeof call.args.cwd === 'string' ? call.args.cwd : undefined
    const outside = placeOutsideWorkspace(command, cwd, workspaceRoot)
    if (outside) {
      return `This voice session may only work in its folder, and this command names a place outside it (${outside.slice(0, 200)}). ` +
        'It was not run. Tell the user to set "Where it may work" at the top of Voice to "Whole computer" for that.'
    }
  }
  return null
}

/** The line of the instructions that tells the model where it stands. */
export function scopePromptLine(work: VoiceWork): string {
  if (!work.agent) return 'You can look things up on the web. You cannot work with files, commands or the screen; if the user asks for that, say that the Agent switch at the top of Voice turns it on.'
  return work.scope === 'workspace'
    ? 'You may only work inside the workspace folder of this session. Use relative paths. You cannot use the screen. If the user asks for something outside the folder, say that "Where it may work" at the top of Voice has to be set to "Whole computer".'
    : 'You may work on the whole computer: files by absolute path, commands in any folder, and the screen when a screen tool is offered.'
}
