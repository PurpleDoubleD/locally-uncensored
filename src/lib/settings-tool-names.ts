// The names of the two settings tools (A11), apart from their executors so
// the catalog filters (sub-agent, voice, workflow, agent chat) can know them
// without importing the stores behind api/mcp/settings-tools.ts.
import { WORKFLOW_TOOL_NAMES, isWorkflowToolName } from './workflow-tool-names'

export const GET_SETTINGS = 'get_settings'
export const SET_SETTING = 'set_setting'
/** The settings pair and, since C60-S5, the four workflow tools: they ride on
 *  the same gate and are kept out of the same places (sub-agent, voice,
 *  workflow runs, local API). */
export const SETTINGS_TOOL_NAMES = [GET_SETTINGS, SET_SETTING, ...WORKFLOW_TOOL_NAMES] as const

/** Plain chat keeps the pair only: installing workflows is for Agent and Code
 *  (C60 decision 9). */
export const PLAIN_CHAT_SETTINGS_TOOL_NAMES = [GET_SETTINGS, SET_SETTING] as const

export function isSettingsToolName(name: string): boolean {
  return name === GET_SETTINGS || name === SET_SETTING || isWorkflowToolName(name)
}

/** The one line the system prompt gets on a turn that carries the pair. */
export const SETTINGS_PROMPT_LINE = 'LU app settings: read them with get_settings, change one with set_setting. '
  + 'The user confirms every change on a card; locked settings only the user changes.'
