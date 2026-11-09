// The names of the tools through which LU runs itself from the chat: the
// settings pair (A11, 3.0.8) and, since C60 (3.1.0), the batch change and the
// actions. Apart from their executors so the catalog filters (sub-agent,
// voice, workflow, agent chat, tool search) can know them without importing
// the stores behind api/mcp/settings-tools.ts and self-control-tools.ts.
import { catalogWords } from './settings-catalog'
import { WORKFLOW_TOOL_NAMES, WORKFLOW_GATE_WORDS } from './workflow-tool-names'

export const GET_SETTINGS = 'get_settings'
export const SET_SETTING = 'set_setting'
export const SET_SETTINGS = 'set_settings'
export const LU_MODELS = 'lu_models'
export const LU_SERVICE = 'lu_service'
export const LU_DOWNLOAD = 'lu_download'
export const LU_OPEN_SETTINGS = 'lu_open_settings'

/** Most changes on one set_settings card. */
export const SET_SETTINGS_MAX = 8

/** The pair plain chat keeps (C60 decision 9: actions only in Agent and Code). */
export const SETTINGS_TOOL_NAMES = [GET_SETTINGS, SET_SETTING] as const

/** Everything that reads or changes LU itself. Agent and Code get them all on
 *  a turn about settings; sub-agents, voice, workflows and the local API never. */
export const SELF_CONTROL_TOOL_NAMES = [
  GET_SETTINGS, SET_SETTING, SET_SETTINGS, LU_MODELS, LU_SERVICE, LU_DOWNLOAD, LU_OPEN_SETTINGS,
  // C60-S5: find, check, install and assign ComfyUI workflows.
  ...WORKFLOW_TOOL_NAMES,
] as const

/** The actions, which only Agent and Code get. */
export const SELF_CONTROL_ACTION_NAMES = [SET_SETTINGS, LU_MODELS, LU_SERVICE, LU_DOWNLOAD, LU_OPEN_SETTINGS] as const

export function isSettingsToolName(name: string): boolean {
  return name === GET_SETTINGS || name === SET_SETTING
}

export function isSelfControlToolName(name: string): boolean {
  return (SELF_CONTROL_TOOL_NAMES as readonly string[]).includes(name)
}

/** The one line the system prompt gets on a turn that carries the pair. */
export const SETTINGS_PROMPT_LINE = 'LU app settings: read them with get_settings, change one with set_setting. '
  + 'The user confirms every change on a card; locked settings only the user changes.'

/** The line for Agent and Code, which also carry the actions (C60). */
export const SELF_CONTROL_PROMPT_LINE = 'You can run LU itself. get_settings (by area or query), then set_setting or set_settings '
  + '(several at once, one card). lu_models switches, loads or unloads models; lu_service starts and stops ComfyUI, '
  + 'the engine, the local API and the phone remote; lu_download fetches models from the LU catalog; '
  + 'lu_open_settings shows the user the place for what only they may change. '
  + 'Change only what the user asked for: every change waits for their card. Never ask twice after a no.'

/** Words a request about the app itself uses, beyond the settings' own names:
 *  "stell … auf", "schalt … an", "switch to", "turn on", "lade … herunter". */
const ACTION_WORDS = [
  'setting', 'einstellung', 'preference', 'option', 'konfigur', 'configure',
  'stell', 'schalt', 'turn on', 'turn off', 'switch to', 'switch on', 'switch off', 'enable', 'disable',
  'aktivier', 'deaktivier', 'wechsel', 'umstell',
  'model', 'modell', 'lade', 'load', 'unload', 'entlade',
  'download', 'herunterlad', 'runterlad', 'herunter', 'install',
  'comfyui', 'comfy', 'neustart', 'restart', 'starte', 'stoppe', 'start comfy', 'stop comfy',
  'local api', 'lokale api', 'localapi', 'api server', 'api-server',
  'remote', 'handy', 'phone', 'smartphone', 'fernzugriff',
  ...WORKFLOW_GATE_WORDS,
  ...SELF_CONTROL_TOOL_NAMES,
]

let cachedGateWords: string[] | null = null

/**
 * Every word that opens the self-control tools for a turn: the catalog's
 * labels, synonyms and area words, plus the action words above. Generated, so
 * a new catalog entry opens its own gate. A false positive costs a few hundred
 * tokens on one turn and changes nothing: every change waits for a card.
 */
export function settingsGateWords(): string[] {
  if (!cachedGateWords) {
    const words = new Set<string>([...ACTION_WORDS.map((w) => w.toLowerCase()), ...catalogWords()])
    // Words that are everywhere in normal talk would open the gate on every
    // turn; they still count inside the intent check of a single setting.
    for (const w of ['code', 'bild', 'image', 'video', 'size', 'such', 'search', 'wait', 'enter', 'design', 'hell', 'light', 'option', 'lade', 'load', 'starte', 'card', 'karte', 'cache', 'layer', 'block', 'allow', 'erlaub', 'merk', 'review', 'edits', 'command', 'befehl', 'agent', 'loop', 'werkzeug', 'clip', 'frames', 'batch', 'denk', 'think', 'budget', 'lokal', 'cloud', 'render', 'cpu', 'flash', 'idle', 'farbe', 'random', 'zufall', 'kreativ', 'creative', 'stell', 'install', 'record', 'confirm']) {
      words.delete(w)
    }
    cachedGateWords = [...words]
  }
  return cachedGateWords
}

/** True when a chat message is about LU itself. */
export function asksAboutSelfControl(userMessage: string): boolean {
  const msg = (userMessage || '').toLowerCase()
  return settingsGateWords().some((k) => msg.includes(k))
}

/**
 * For a tool profile that trims the list (small models, tool search): put the
 * self-control tools back on a turn about LU itself, past any cap, as the
 * Agent tab does with withCreateTools. Off such a turn the list is unchanged.
 */
export function withSelfControlTools<T extends { name: string }>(chosen: T[], all: T[], userMessage: string): T[] {
  if (!asksAboutSelfControl(userMessage)) return chosen
  const missing = all.filter((t) => isSelfControlToolName(t.name) && !chosen.some((c) => c.name === t.name))
  return missing.length ? [...chosen, ...missing] : chosen
}
