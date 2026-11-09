// Which agent tools, slash commands and workflows exist on a phone.
//
// One file, because the answer has to be the same in every place that asks:
// the registration (so a tool is in no catalog, no roster, no sub agent and
// no parser), the redirect for retired names (so nobody reaches the shell
// through an old spelling), the slash menu and the workflow list.
//
// Everything here answers "yes, as before" on a desktop.

import type { MCPToolDefinition } from '../api/mcp/types'
import type { AgentWorkflow } from '../types/agent-workflows'
import { isMobile } from './device-kind'

/**
 * Tools of the catalog that have nothing to run on a phone: the shell and the
 * pull request helper built on it, the screen capture, and the two media
 * tools whose executors drive local ComfyUI or MLX. Media on a phone is made
 * in Create through LU Cloud; the agent tools have no cloud branch.
 */
export const MOBILE_REMOVED_TOOLS: ReadonlySet<string> = new Set([
  'shell_execute',
  'pr_resume',
  'screenshot',
  'image_generate',
  'video_generate',
])

/**
 * The two settings tools of 3.0.8 (A11, lib/settings-tool-names.ts). Their
 * catalog is the settings of the desktop app; a phone has its own settings
 * pages, and nothing of A11 was checked on one. Kept apart from the five
 * above, which the audit named.
 */
export const MOBILE_UNBUILT_TOOLS: ReadonlySet<string> = new Set(['get_settings', 'set_setting'])

/** The retired names that still run on a phone. All others end in a shell,
 *  a process list or a repository. */
export const MOBILE_RETIRED_ALLOWED: ReadonlySet<string> = new Set(['get_current_time'])

/** Is this catalog tool registered on this device? */
export function toolExistsOnThisDevice(name: string): boolean {
  return !isMobile() || (!MOBILE_REMOVED_TOOLS.has(name) && !MOBILE_UNBUILT_TOOLS.has(name))
}

/** Does this retired name still redirect on this device? */
export function retiredToolRunsOnThisDevice(name: string): boolean {
  return !isMobile() || MOBILE_RETIRED_ALLOWED.has(name)
}

/** The local image and video tools can be offered, synthesized or routed to.
 *  False on a phone whatever the app mode says. */
export function localMediaToolsExist(): boolean {
  return !isMobile()
}

const MOBILE_DESCRIPTIONS: Record<string, string> = {
  file_read:
    'Read a file from the working folder of this app. Use paths relative to that folder. '
    + 'Omitting offset/limit returns the whole file. For LARGE files pass offset (1-based start line) and limit '
    + '(number of lines): the response names the window, the total line count and the offset of the next page. '
    + 'A very long whole-file read gets its middle truncated, so page large files. '
    + 'DO NOT re-read a file you just wrote, the write response already confirmed it.',
  file_write:
    'Write a WHOLE file in the working folder of this app: use it to CREATE a new file or fully replace one, and PREFER file_edit to change part of an existing one. '
    + 'Creates parent directories if missing. OVERWRITES existing content, there is no append mode. '
    + 'Use paths relative to the working folder.',
  file_list:
    'List directory contents inside the working folder of this app. Returns name, isDir, size and full path per entry. '
    + 'Supports recursive=true and a glob pattern ("*.md", "**/*.txt"). '
    + 'For content search use file_search.',
  run_workflow:
    'Execute a saved agent workflow by name. Runs a nested ReAct with a pre-built step chain. '
    + 'USE for repeatable multi-step tasks: "Research Topic", "Summarize URL", plus any user-created workflows. '
    + 'DO NOT call from inside another workflow tool, depth is capped at 5. '
    + 'input answers the first user_input step or fails fast; else seeds user_input/last_output.',
}

/**
 * The definition a tool is registered with on this device. A desktop gets the
 * very object that was passed in. A phone gets a copy whose description no
 * longer prefers absolute paths or names a workflow that is not offered there.
 */
export function toolDefinitionForThisDevice(tool: MCPToolDefinition): MCPToolDefinition {
  if (!isMobile()) return tool
  const description = MOBILE_DESCRIPTIONS[tool.name]
  if (!description) return tool
  const properties = tool.inputSchema?.properties
  const path = properties?.path
  if (path && typeof path.description === 'string' && /relative to the workspace|absolute preferred/.test(path.description)) {
    return {
      ...tool,
      description,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...properties,
          path: { ...path, description: 'Path to the file, relative to the working folder' },
        },
      },
    }
  }
  return { ...tool, description }
}

/** The slash commands offered on a phone. The rest of the list expands to
 *  instructions that need a shell, git or a repository. */
export const MOBILE_SLASH_COMMANDS: ReadonlySet<string> = new Set(['compact', 'goal', 'loop'])

export function slashCommandExistsOnThisDevice(name: string): boolean {
  return !isMobile() || MOBILE_SLASH_COMMANDS.has(name)
}

/** The built in workflows offered on a phone. "Code Review" asks for a file
 *  path on a device where the user has no file tree to name one from. */
export const MOBILE_BUILTIN_WORKFLOWS: ReadonlySet<string> = new Set([
  'builtin-research-topic',
  'builtin-summarize-url',
])

/** May this workflow be listed and run on this device? A built in one has to
 *  be on the list; a user's own has to use only tools that exist here. */
export function workflowRunsOnThisDevice(workflow: AgentWorkflow): boolean {
  if (!isMobile()) return true
  if (workflow.isBuiltIn) return MOBILE_BUILTIN_WORKFLOWS.has(workflow.id)
  // Only a tool STEP decides: it names the one tool it runs. A prompt step's
  // allow list that mentions a missing tool simply offers one tool fewer.
  for (const step of workflow.steps ?? []) {
    const name = step.toolName
    if (name && (MOBILE_REMOVED_TOOLS.has(name) || RETIRED_SHELL_NAMES.has(name))) return false
  }
  return true
}

/** The workflows of the store as this device may list and run them. */
export function workflowsForThisDevice<T extends AgentWorkflow>(workflows: readonly T[]): T[] {
  return workflows.filter(workflowRunsOnThisDevice)
}

// A frozen copy of the retired names, not an import of lib/retired-tools.ts:
// that module imports this one for the redirect gate.
const RETIRED_SHELL_NAMES: ReadonlySet<string> = new Set([
  'git_status', 'git_log', 'git_diff', 'git_commit', 'git_push', 'run_tests', 'gh_pr_create',
  'project_init', 'code_execute', 'system_info', 'process_list', 'shell_execute_background',
  'shell_task_status', 'shell_task_kill', 'shell_task_list',
])

// Lives in a file of its own so api/mcp/types.ts can use it without a circle.
export { mobilePermissionDefaults } from './mobile-permission-defaults'
