// The self-control tools as the registry sees them (C60, 3.1.0): schemas, the
// mark an action leaves under its result, and the registration. Nothing heavy
// is imported here: the tool registry loads this with the app, and the stores,
// the engine and the downloader behind the tools would pull half the app, with
// code that runs at import time, into every module that only registers tools.
// The executors load on the first call (self-control-tools.ts, settings-tools.ts).

import type { MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import {
  SET_SETTINGS, SET_SETTINGS_MAX, LU_MODELS, LU_SERVICE, LU_DOWNLOAD, LU_OPEN_SETTINGS,
} from '../../lib/settings-tool-names'

// ── Schemas ──────────────────────────────────────────────────────

// Defined here, not in settings-tools.ts: this module registers it, and a
// definition imported across the settings-tools ↔ stores ↔ mcp cycle can be
// undefined at registration time when settings-tools is loaded first.
const SET_SETTINGS_TOOL: MCPToolDefinition = {
  name: SET_SETTINGS,
  description: `Change up to ${SET_SETTINGS_MAX} LU app settings on one confirmation card, instead of several set_setting calls.`,
  brief: 'Change several LU app settings on one confirmation card.',
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'e.g. [{"key":"temperature","value":0.6}].',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key from get_settings.' },
            value: { type: ['string', 'number', 'boolean'], description: 'New value.' },
          },
          required: ['key', 'value'],
        },
      },
    },
    required: ['changes'],
  },
  category: 'system',
  source: 'builtin',
}


const LU_MODELS_TOOL: MCPToolDefinition = {
  name: LU_MODELS,
  description: 'LU chat models: list, status, or switch (after the user confirms, when this answer is done).',
  brief: 'List LU chat models or switch the active chat model.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'status', 'switch'], description: 'What to do.' },
      name: { type: 'string', description: 'For switch: a model name from list.' },
    },
    required: ['action'],
  },
  category: 'system',
  source: 'builtin',
}

const LU_SERVICE_TOOL: MCPToolDefinition = {
  name: LU_SERVICE,
  description: 'Start, stop, restart or check a part of LU: comfyui, engine (LU Engine), local_api (this computer only), remote (phone, home network). The user confirms on a card.',
  brief: 'Start, stop or restart ComfyUI, LU Engine, the local API or the phone remote.',
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: ['comfyui', 'engine', 'local_api', 'remote'], description: 'Which part.' },
      action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], description: 'What to do.' },
    },
    required: ['service', 'action'],
  },
  category: 'system',
  source: 'builtin',
}

const LU_DOWNLOAD_TOOL: MCPToolDefinition = {
  name: LU_DOWNLOAD,
  description: 'Create models from the LU catalog: search, start (an id from search), status. '
    + 'start_link: a huggingface.co or civitai.com link the user pasted, into a ComfyUI model folder. The user confirms on a card.',
  brief: 'Search the LU model catalog and download a model, after the user confirms.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'start', 'status', 'start_link'], description: 'What to do.' },
      query: { type: 'string', description: 'Search words.' },
      id: { type: 'string', description: 'An id from search.' },
      url: { type: 'string', description: 'The link as the user sent it.' },
      folder: { type: 'string', description: 'Model folder, e.g. checkpoints, loras, vae.' },
      filename: { type: 'string', description: 'File name if the link lacks it.' },
    },
    required: ['action'],
  },
  category: 'system',
  source: 'builtin',
}

const LU_OPEN_SETTINGS_TOOL: MCPToolDefinition = {
  name: LU_OPEN_SETTINGS,
  description: 'Open LU Settings where the user changes what only they may (keys, looser permissions, paths, MCP). Changes nothing.',
  brief: 'Open LU Settings at a given area for the user.',
  inputSchema: {
    type: 'object',
    properties: {
      area: { type: 'string', description: 'e.g. keys, permissions, remote, local_api, mcp, comfyui, voice.' },
    },
    required: ['area'],
  },
  category: 'system',
  source: 'builtin',
}

export const SELF_CONTROL_TOOLS: MCPToolDefinition[] = [SET_SETTINGS_TOOL, LU_MODELS_TOOL, LU_SERVICE_TOOL, LU_DOWNLOAD_TOOL, LU_OPEN_SETTINGS_TOOL]

// ── Shared ───────────────────────────────────────────────────────

export { parseSelfControlAction, markOf, type SelfControlAction } from './self-control-mark'



// ── Registration ─────────────────────────────────────────────────

const tools = () => import('./self-control-tools')
const settings = () => import('./settings-tools')

export function registerSelfControlTools(registry: ToolRegistry): void {
  registry.registerBuiltin(SET_SETTINGS_TOOL, async (a, run, signal) => (await settings()).executeSetSettings(a, run, signal))
  registry.registerBuiltin(LU_MODELS_TOOL, async (a, run, signal) => (await tools()).executeLuModels(a, run, signal))
  registry.registerBuiltin(LU_SERVICE_TOOL, async (a, run, signal) => (await tools()).executeLuService(a, run, signal))
  registry.registerBuiltin(LU_DOWNLOAD_TOOL, async (a, run, signal) => (await tools()).executeLuDownload(a, run, signal))
  registry.registerBuiltin(LU_OPEN_SETTINGS_TOOL, async (a) => (await tools()).executeLuOpenSettings(a))
}
