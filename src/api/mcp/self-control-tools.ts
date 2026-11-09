// LU runs itself from the chat: the actions beside the settings (C60, 3.1.0).
//
//   set_settings     several settings on one card (settings-tools.ts)
//   lu_models        list, status, switch the chat model
//   lu_service       ComfyUI, LU Engine, the local API, the phone remote
//   lu_download      the LU model catalog; a link only when the user sent it
//   lu_open_settings the place in Settings for what only the user changes
//
// Agent and Code only (plain chat keeps get_settings / set_setting, David's
// decision 9 of 09.11.2026). Every change waits for a card the app draws from
// this structured request (stores/settingsConfirmStore.ts), and before the
// card comes lib/self-control-policy.ts decides whether one may come at all:
// the user's own words must ask for it, and the strong actions (local API,
// phone remote, a download by link) never come after foreign content in the
// same run.
//
// What never happens here, whatever the model or a page asks: show or set a
// key or token, open the local API to the network, a tunnel or "anywhere" for
// the remote, delete anything, install a custom node, MCP server or plugin.

import { v4 as uuid } from 'uuid'
import type { MCPToolDefinition, ToolArgs } from './types'
import type { ToolRegistry } from './tool-registry'
import { afterAgentRun, type AgentRunContext } from '../agent-context'
import {
  SET_SETTINGS, SET_SETTINGS_MAX, LU_MODELS, LU_SERVICE, LU_DOWNLOAD, LU_OPEN_SETTINGS,
} from '../../lib/settings-tool-names'
import { executeSetSettings } from './settings-tools'
import { useSettingsConfirmStore } from '../../stores/settingsConfirmStore'
import { useSettingsAuditStore } from '../../stores/settingsAuditStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useLocalApiStore } from '../../stores/localApiStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { useDownloadStore } from '../../stores/downloadStore'
import { useUIStore } from '../../stores/uiStore'
import { backendCall, isTauri } from '../backend'
import { activateBuiltinModel, stopBundledEngine } from '../engine'
import { checkDownloadSpace, installBundleComplete, startChatLinkDownload } from '../discover'
import {
  getAudioBundles, getImageBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles, getVideoBundles,
  type ModelBundle,
} from '../model-bundles'
import { getProviderIdFromModel } from '../providers/model-name'
import { isManagedBuiltinSlot } from '../builtin-ensure'
import { checkSelfControl, noteCard, turnTextOf } from '../../lib/self-control-policy'
import { taintLabel } from '../../lib/run-taint'
import { SETTINGS_AREAS, isArea, type SettingsArea } from '../../lib/settings-catalog'
import type { SettingsTab } from '../../lib/settings-reset'

// ── Schemas ──────────────────────────────────────────────────────

// Defined here, not in settings-tools.ts: this module registers it, and a
// definition imported across the settings-tools ↔ stores ↔ mcp cycle can be
// undefined at registration time when settings-tools is loaded first.
const SET_SETTINGS_TOOL: MCPToolDefinition = {
  name: SET_SETTINGS,
  description: `Change several LU app settings at once (up to ${SET_SETTINGS_MAX}) on one card; the user can untick each. `
    + 'Use it instead of several set_setting calls.',
  brief: 'Change several LU app settings on one confirmation card.',
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'The changes, e.g. [{"key":"temperature","value":0.6},{"key":"builtinEngine.ctx","value":16384}].',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: ['string', 'number', 'boolean'] },
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
  description: 'LU chat models. action list: installed chat models. status: the active one. '
    + 'switch: change the chat model (name from list); it happens when this answer is done, after the user confirms.',
  brief: 'List LU chat models or switch the active chat model.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'status', 'switch'], description: 'list, status or switch.' },
      name: { type: 'string', description: 'For switch: the model name, or a unique part of it.' },
    },
    required: ['action'],
  },
  category: 'system',
  source: 'builtin',
}

const LU_SERVICE_TOOL: MCPToolDefinition = {
  name: LU_SERVICE,
  description: 'Start, stop or restart a part of LU: comfyui, engine (LU Engine, e.g. after engine settings), '
    + 'local_api (OpenAI-compatible API on this computer only), remote (phone access in the home network). '
    + 'status needs no card; every other action waits for the user\'s card.',
  brief: 'Start, stop or restart ComfyUI, LU Engine, the local API or the phone remote.',
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', enum: ['comfyui', 'engine', 'local_api', 'remote'] },
      action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'] },
    },
    required: ['service', 'action'],
  },
  category: 'system',
  source: 'builtin',
}

const LU_DOWNLOAD_TOOL: MCPToolDefinition = {
  name: LU_DOWNLOAD,
  description: 'Models from the LU catalog for Create (image, video, audio, upscale). action search: find by words. '
    + 'start: download one by its id from search. status: running downloads. '
    + 'start_link: a .safetensors or .gguf link to huggingface.co or civitai.com that the user pasted in their own message, into a ComfyUI model folder.',
  brief: 'Search the LU model catalog and download a model, after the user confirms.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'start', 'status', 'start_link'] },
      query: { type: 'string', description: 'For search.' },
      id: { type: 'string', description: 'For start: the id search returned.' },
      url: { type: 'string', description: 'For start_link: the link exactly as the user sent it.' },
      folder: { type: 'string', description: 'For start_link: checkpoints, diffusion_models, unet, loras, vae, text_encoders, clip, clip_vision, upscale_models or controlnet.' },
      filename: { type: 'string', description: 'For start_link: the file name, if the link does not end in it.' },
    },
    required: ['action'],
  },
  category: 'system',
  source: 'builtin',
}

const LU_OPEN_SETTINGS_TOOL: MCPToolDefinition = {
  name: LU_OPEN_SETTINGS,
  description: 'Open LU\'s Settings at the place for an area, so the user can change what only they may change '
    + '(keys, permissions looser, remote, paths, MCP). Changes nothing.',
  brief: 'Open LU Settings at a given area for the user.',
  inputSchema: {
    type: 'object',
    properties: {
      area: { type: 'string', description: `An area (${Object.keys(SETTINGS_AREAS).join(', ')}) or one of keys, remote, local_api, mcp, comfyui, models.` },
    },
    required: ['area'],
  },
  category: 'system',
  source: 'builtin',
}

export const SELF_CONTROL_TOOLS: MCPToolDefinition[] = [SET_SETTINGS_TOOL, LU_MODELS_TOOL, LU_SERVICE_TOOL, LU_DOWNLOAD_TOOL, LU_OPEN_SETTINGS_TOOL]

// ── Shared ───────────────────────────────────────────────────────

/** The line an action puts under its answer, for the card that stays. */
const ACTION_MARK = /<!-- lu-action (\{.*?\}) -->/

export interface SelfControlAction {
  kind: 'model' | 'service' | 'download'
  title: string
  /** For a model switch: the model before and after, for Undo. */
  from?: string | null
  to?: string | null
}

export function parseSelfControlAction(result: string | null | undefined): SelfControlAction | null {
  const m = typeof result === 'string' ? ACTION_MARK.exec(result) : null
  if (!m) return null
  try {
    const v = JSON.parse(m[1]) as Partial<SelfControlAction>
    return typeof v.kind === 'string' && typeof v.title === 'string' ? (v as SelfControlAction) : null
  } catch {
    return null
  }
}

const markOf = (a: SelfControlAction) => `<!-- lu-action ${JSON.stringify(a)} -->`

const lower = (s: unknown) => String(s ?? '').toLowerCase()
const has = (text: string, words: readonly string[]) => { const t = lower(text); return words.some((w) => t.includes(w)) }

function auditAction(run: AgentRunContext | undefined, key: string, title: string, outcome: 'applied' | 'declined' | 'timeout' | 'refused' | 'failed', why?: string) {
  useSettingsAuditStore.getState().record({
    conversationId: run?.conversationId ?? null,
    model: useModelStore.getState().activeModel ?? null,
    kind: 'action', key, label: title, from: '', to: '', outcome, why, tainted: taintLabel(run),
  })
}

/** Policy, then the card. Null when the user said yes, else the reply. */
async function confirmAction(
  run: AgentRunContext | undefined,
  signal: AbortSignal | undefined,
  o: { key: string; title: string; details: string[]; strong: boolean; names: (t: string, strict: boolean) => boolean; what: string; riskNote?: string },
): Promise<string | null> {
  const verdict = checkSelfControl(run, { names: o.names, strong: o.strong, what: o.what })
  if (!verdict.ok) { auditAction(run, o.key, o.title, 'refused', verdict.why); return verdict.reply }
  noteCard(run)
  const answer = await useSettingsConfirmStore.getState().askFull({
    id: uuid(),
    toolCallId: run!.toolCallId,
    conversationId: run!.conversationId,
    key: o.key, label: o.title, from: '', to: '',
    action: { title: o.title, details: o.details },
    risk: o.strong ? 'strong' : 'card',
    riskNote: o.riskNote,
    taintedBy: verdict.taintedBy,
  }, signal ?? run!.abortSignal)
  if (answer.allow) return null
  auditAction(run, o.key, o.title, answer.reason === 'timeout' ? 'timeout' : 'declined')
  return answer.reason === 'timeout'
    ? 'No answer on the card for 10 minutes, so no. Nothing changed. Do not ask again unless the user asks.'
    : 'The user declined. Nothing changed. Do not ask again unless the user asks.'
}

// ── lu_models ────────────────────────────────────────────────────

const MODEL_WORDS = ['model', 'modell', 'wechsel', 'switch', 'umstell', 'nimm', 'use ', 'llm']

function chatModels() {
  return useModelStore.getState().models.filter((m) => m.type !== 'image' && m.type !== 'video')
}

export async function executeLuModels(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  const action = lower(args?.action)
  const active = useModelStore.getState().activeModel
  if (action === 'list') {
    const list = chatModels()
    if (list.length === 0) return 'No chat model is installed or listed yet.'
    const shown = list.slice(0, 30).map((m) => `${m.name === active ? '* ' : '  '}${m.name}`)
    return [`Chat models (* = active), ${list.length}:`, ...shown, ...(list.length > 30 ? [`(+${list.length - 30} more)`] : [])].join('\n')
  }
  if (action === 'status') {
    if (!active) return 'No chat model is selected.'
    const provider = getProviderIdFromModel(active)
    const engine = provider === 'openai' && isManagedBuiltinSlot() ? 'LU Engine' : String(provider)
    return `Active chat model: ${active} (${engine}).`
  }
  if (action !== 'switch') return 'Error: action is list, status or switch.'
  const want = lower(args?.name).trim()
  if (!want) return 'Error: name is missing. Call lu_models with action list.'
  const list = chatModels()
  const exact = list.find((m) => m.name.toLowerCase() === want)
  const hits = exact ? [exact] : list.filter((m) => m.name.toLowerCase().includes(want))
  if (hits.length !== 1) {
    return hits.length === 0
      ? `Error: no installed chat model matches "${args?.name}". Call lu_models with action list. Nothing changed.`
      : `Error: "${args?.name}" matches ${hits.length} models: ${hits.slice(0, 6).map((m) => m.name).join(', ')}. Say which. Nothing changed.`
  }
  const target = hits[0].name
  if (target === active) return `${target} is already the chat model. Nothing changed.`
  const title = `Switch the chat model to ${target}`
  const refused = await confirmAction(run, signal, {
    key: 'lu_models switch', title, strong: false, what: 'the chat model',
    details: [`Now: ${active ?? 'none'}`, 'The switch happens when this answer is done; a local model then loads with the next message.'],
    names: (t, strict) => t.toLowerCase().includes(want) || (!strict && has(t, MODEL_WORDS)),
  })
  if (refused) return refused
  // Not now: the run that asked is still answering with the old model, and a
  // local switch takes the engine from under it (modelStore.setActiveModel).
  const when = afterAgentRun(run, () => useModelStore.getState().setActiveModel(target))
  auditAction(run, 'lu_models switch', title, 'applied')
  return `${when === 'now' ? 'Switched' : 'Switching'} the chat model to ${target}${when === 'now' ? '' : ' when this answer is done. Finish your answer now'}. `
    + `The user can undo it on the card.\n${markOf({ kind: 'model', title, from: active, to: target })}`
}

/** Undo of a model switch from the card. */
export function undoModelSwitch(a: SelfControlAction): void {
  if (a.kind === 'model' && a.from) useModelStore.getState().setActiveModel(a.from)
}

// ── lu_service ───────────────────────────────────────────────────

const LOCAL_API_WORDS = ['local api', 'lokale api', 'lokalen api', 'localapi', 'local-api', 'api server', 'api-server', 'openai api', 'openai-api']
const REMOTE_WORDS = ['remote', 'handy', 'phone', 'smartphone', 'fernzugriff', 'fernsteuer', 'mobil']
const COMFY_WORDS = ['comfy']
const ENGINE_WORDS = ['engine', 'llama', 'neustart', 'restart', 'neu start']

async function comfyRunning(): Promise<boolean | null> {
  if (!isTauri()) return null
  try { return !!(await backendCall<{ running?: boolean }>('comfyui_status'))?.running } catch { return null }
}

function luEngineActive(): boolean {
  const active = useModelStore.getState().activeModel
  return !!active && getProviderIdFromModel(active) === 'openai' && isManagedBuiltinSlot()
}

export async function executeLuService(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  const service = lower(args?.service)
  const action = lower(args?.action)
  if (!['comfyui', 'engine', 'local_api', 'remote'].includes(service)) return 'Error: service is comfyui, engine, local_api or remote.'
  if (!['status', 'start', 'stop', 'restart'].includes(action)) return 'Error: action is status, start, stop or restart.'

  if (action === 'status') {
    if (service === 'comfyui') { const r = await comfyRunning(); return r === null ? 'ComfyUI: unknown here.' : `ComfyUI is ${r ? 'running' : 'stopped'}.` }
    if (service === 'engine') return luEngineActive() ? `LU Engine serves the chat model ${useModelStore.getState().activeModel}.` : 'LU Engine does not serve the active chat model.'
    if (service === 'local_api') { const s = useLocalApiStore.getState(); return `Local API is ${s.laeuft ? 'running' : 'stopped'}${s.lan ? ', LAN access is on' : ', this computer only'}.` }
    const r = useRemoteStore.getState()
    return `Phone remote is ${r.enabled ? 'on' : 'off'}${r.tunnelActive ? ', reachable from the internet' : ''}.`
  }

  if (service === 'comfyui') {
    const title = action === 'stop' ? 'Stop ComfyUI' : action === 'start' ? 'Start ComfyUI' : 'Restart ComfyUI'
    const refused = await confirmAction(run, signal, {
      key: `lu_service comfyui ${action}`, title, strong: false, what: 'ComfyUI',
      details: [action === 'stop' ? 'A render that runs now is cut off.' : 'Takes up to a minute; renders wait for it.'],
      names: (t) => has(t, COMFY_WORDS),
    })
    if (refused) return refused
    try {
      if (action !== 'start') { try { await backendCall('stop_comfyui') } catch { /* may already be stopped */ } }
      if (action !== 'stop') await backendCall('start_comfyui')
    } catch (e) {
      auditAction(run, `lu_service comfyui ${action}`, title, 'failed', String(e))
      return `Error: ${title} failed: ${String(e)}`
    }
    auditAction(run, `lu_service comfyui ${action}`, title, 'applied')
    return `${title}: done.\n${markOf({ kind: 'service', title })}`
  }

  if (service === 'engine') {
    if (!luEngineActive()) return 'LU Engine does not serve the active chat model, so there is nothing to restart. Nothing changed.'
    if (action === 'start') return 'LU Engine starts by itself with the next message. Nothing changed.'
    const model = useModelStore.getState().activeModel as string
    const title = action === 'stop' ? 'Stop LU Engine' : 'Restart LU Engine with the current engine settings'
    const refused = await confirmAction(run, signal, {
      key: `lu_service engine ${action}`, title, strong: false, what: 'LU Engine',
      details: [`Model: ${model}`, 'Happens when this answer is done; the model then loads again.'],
      names: (t) => has(t, ENGINE_WORDS),
    })
    if (refused) return refused
    // After the run: this run is answering through that engine.
    afterAgentRun(run, async () => {
      if (action === 'stop') await stopBundledEngine()
      else await activateBuiltinModel(model, useSettingsStore.getState().settings.builtinEngine)
    })
    auditAction(run, `lu_service engine ${action}`, title, 'applied')
    return `${title}: when this answer is done. Finish your answer now.\n${markOf({ kind: 'service', title })}`
  }

  if (service === 'local_api') {
    const s = useLocalApiStore.getState()
    if (action === 'stop') {
      if (!s.laeuft) return 'The local API is not running. Nothing changed.'
      const title = 'Stop the local API'
      const refused = await confirmAction(run, signal, {
        key: 'lu_service local_api stop', title, strong: false, what: 'the local API', details: ['Programs that use it lose the connection.'],
        names: (t) => has(t, LOCAL_API_WORDS),
      })
      if (refused) return refused
      await s.stoppen()
      auditAction(run, 'lu_service local_api stop', title, 'applied')
      return `Local API stopped.\n${markOf({ kind: 'service', title })}`
    }
    if (s.lan) {
      auditAction(run, `lu_service local_api ${action}`, 'Start the local API', 'refused', 'lan')
      return 'Refused: the local API is set to answer the network (LAN). With that on, only the user starts it, in Settings → Voice & Remote → Local API. Nothing changed. Tell the user so.'
    }
    if (!s.token) {
      return 'Refused: the local API has no access token yet. The user creates one in Settings → Voice & Remote → Local API (lu_open_settings area local_api). Nothing changed.'
    }
    const title = action === 'restart' ? 'Restart the local API' : 'Start the local API'
    const refused = await confirmAction(run, signal, {
      key: `lu_service local_api ${action}`, title, strong: true, what: 'The local API',
      details: [`On this computer only, port ${s.port}, with its access token.`, 'Programs on this computer that have the token can use your models.'],
      riskNote: 'Opens a port on this computer.',
      names: (t) => has(t, LOCAL_API_WORDS),
    })
    if (refused) return refused
    if (action === 'restart') await s.stoppen()
    await s.starten()
    const after = useLocalApiStore.getState()
    if (!after.laeuft) {
      auditAction(run, `lu_service local_api ${action}`, title, 'failed', after.fehler ?? undefined)
      return `Error: the local API did not start: ${after.fehler ?? 'unknown reason'}.`
    }
    auditAction(run, `lu_service local_api ${action}`, title, 'applied')
    // The address is fine to say, the token never.
    return `Local API is running at ${after.adresse ?? `port ${after.port}`}, this computer only. The token is in Settings, never in the chat.\n${markOf({ kind: 'service', title })}`
  }

  // remote
  const r = useRemoteStore.getState()
  if (action === 'stop') {
    if (!r.enabled) return 'The phone remote is off. Nothing changed.'
    const title = 'Stop the phone remote'
    const refused = await confirmAction(run, signal, {
      key: 'lu_service remote stop', title, strong: false, what: 'the phone remote', details: ['The phone loses the connection.'],
      names: (t) => has(t, REMOTE_WORDS),
    })
    if (refused) return refused
    await r.stopServer()
    auditAction(run, 'lu_service remote stop', title, 'applied')
    return `Phone remote stopped.\n${markOf({ kind: 'service', title })}`
  }
  if (r.enabled) return 'The phone remote is already on; its code is in the sidebar. Nothing changed.'
  if (r.sealedInfo?.anywhere || r.tunnelActive) {
    auditAction(run, 'lu_service remote start', 'Start the phone remote', 'refused', 'anywhere')
    return 'Refused: "Reach this computer from anywhere" is on, so the remote would reach the internet. Only the user starts it then, in the sidebar. Nothing changed. Tell the user so.'
  }
  const title = 'Start the phone remote (home network)'
  const refused = await confirmAction(run, signal, {
    key: 'lu_service remote start', title, strong: true, what: 'The phone remote',
    details: ['Home network only, never the internet.', 'You pick the work folder next; the QR code and passcode then show in the sidebar.'],
    riskNote: 'A phone in your network can then use this chat after pairing.',
    names: (t) => has(t, REMOTE_WORDS),
  })
  if (refused) return refused
  // The same door as the sidebar's own button: folder picker, the dispatch,
  // the QR code. The passcode never reaches the model.
  useRemoteStore.getState().requestChatDispatch('lan')
  auditAction(run, 'lu_service remote start', title, 'applied')
  return 'The phone remote is starting in the home network. The user picks the folder; the QR code and passcode show in the sidebar, never in the chat.\n'
    + markOf({ kind: 'service', title })
}

// ── lu_download ──────────────────────────────────────────────────

const DOWNLOAD_WORDS = ['download', 'herunterlad', 'runterlad', 'herunter', 'install', 'hol ', 'besorg', 'get ']
const LINK_FOLDERS = ['checkpoints', 'diffusion_models', 'unet', 'loras', 'vae', 'text_encoders', 'clip', 'clip_vision', 'upscale_models', 'controlnet']

function catalog(): { kind: string; b: ModelBundle }[] {
  const out: { kind: string; b: ModelBundle }[] = []
  const add = (kind: string, list: ModelBundle[]) => { for (const b of list) out.push({ kind, b }) }
  add('image', getImageBundles()); add('video', getVideoBundles()); add('audio', getAudioBundles())
  add('lipsync', getLipsyncBundles()); add('motion', getMotionBundles()); add('upscale', getUpscaleBundles())
  return out
}

function findBundle(id: string): { kind: string; b: ModelBundle }[] {
  const want = id.trim().toLowerCase()
  const all = catalog()
  const exact = all.filter((x) => x.b.name.toLowerCase() === want)
  return exact.length ? exact : all.filter((x) => x.b.name.toLowerCase().includes(want))
}

function fileNameOfLink(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return /\.(safetensors|gguf)$/i.test(last) ? last : ''
  } catch { return '' }
}

export async function executeLuDownload(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  const action = lower(args?.action)
  if (action === 'search') {
    const words = lower(args?.query).split(/[^a-z0-9.äöüß]+/).filter((w) => w.length >= 2)
    const hits = catalog().filter(({ b }) => {
      const hay = `${b.name} ${b.tags.join(' ')} ${b.description}`.toLowerCase()
      return words.length === 0 || words.every((w) => hay.includes(w))
    }).slice(0, 10)
    if (hits.length === 0) return `Nothing in the LU catalog matches "${args?.query ?? ''}". Try fewer words.`
    return ['LU catalog (id | kind | size | VRAM):', ...hits.map(({ kind, b }) => `${b.name} | ${kind} | ${b.totalSizeGB} GB | ${b.vramRequired}`)].join('\n')
  }
  if (action === 'status') {
    const rows = Object.entries(useDownloadStore.getState().downloads ?? {})
      .filter(([, d]) => d && (d.status === 'downloading' || d.status === 'connecting' || d.status === 'error' || d.status === 'paused'))
      .slice(0, 12)
    if (rows.length === 0) return 'No download is running.'
    return rows.map(([name, d]) => {
      const pct = d.total ? Math.round((d.progress / d.total) * 100) : null
      return `${name}: ${d.status}${pct !== null ? ` ${pct} %` : ''}`
    }).join('\n')
  }
  if (action === 'start') {
    const id = String(args?.id ?? '').trim()
    if (!id) return 'Error: id is missing. Call lu_download with action search first.'
    const hits = findBundle(id)
    if (hits.length !== 1) {
      return hits.length === 0 ? `Error: no catalog entry "${id}". Call lu_download search. Nothing changed.`
        : `Error: "${id}" matches ${hits.length}: ${hits.slice(0, 5).map((h) => h.b.name).join(', ')}. Say which. Nothing changed.`
    }
    const { b } = hits[0]
    const bytes = Math.round(b.totalSizeGB * 1_073_741_824)
    const files = b.files.filter((f) => f.downloadUrl && f.filename && f.subfolder)
    const space = await checkDownloadSpace({ subfolder: files[0]?.subfolder }, bytes)
    if (space && !space.fits) return `Error: not enough disk space for ${b.name} (${b.totalSizeGB} GB). ${space.message ?? ''} Nothing changed.`
    const title = `Download ${b.name}`
    const refused = await confirmAction(run, signal, {
      key: 'lu_download start', title, strong: false, what: 'a download',
      details: [`${b.totalSizeGB} GB in ${files.length} file${files.length === 1 ? '' : 's'}, into ComfyUI's model folders`, `Needs ${b.vramRequired}`,
        ...(space?.availableBytes ? [`Free: ${Math.round(space.availableBytes / 1_073_741_824)} GB`] : [])],
      names: (t, strict) => t.toLowerCase().includes(b.name.toLowerCase().split(' ')[0]) || (!strict && has(t, DOWNLOAD_WORDS)),
    })
    if (refused) return refused
    const dl = useDownloadStore.getState()
    for (const f of files) {
      dl.setMeta(f.filename!, f.downloadUrl!, f.subfolder!, undefined, {
        expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : undefined, sha256: f.sha256,
      })
    }
    dl.setBundleGroup(b.name, files.map((f) => f.filename!))
    dl.startPolling()
    // Not awaited: a download takes minutes to hours; the tray shows it.
    void installBundleComplete(b).catch((e) => auditAction(run, 'lu_download start', title, 'failed', String(e)))
    auditAction(run, 'lu_download start', title, 'applied')
    return `${title} started. Progress is in the Downloads tray; lu_download status reads it.\n${markOf({ kind: 'download', title })}`
  }
  if (action === 'start_link') {
    const url = String(args?.url ?? '').trim()
    const folder = String(args?.folder ?? '').trim()
    if (!url) return 'Error: url is missing.'
    // The link has to come from the user, word for word. A link from a page,
    // a file or a tool's output is never downloaded.
    const turn = turnTextOf(run?.conversationId ?? null)
    if (!turn || !turn.user.includes(url)) {
      auditAction(run, 'lu_download start_link', `Download ${url}`, 'refused', 'not-from-user')
      return 'Refused: only a link the user pasted in their own message is downloaded, exactly as they sent it. Nothing changed.'
    }
    let host = ''
    try { const u = new URL(url); host = u.protocol === 'https:' ? u.hostname.toLowerCase() : '' } catch { /* below */ }
    if (host !== 'huggingface.co' && host !== 'civitai.com') return 'Refused: from the chat only https links to huggingface.co or civitai.com are downloaded. Nothing changed.'
    if (!LINK_FOLDERS.includes(folder)) return `Error: folder is one of ${LINK_FOLDERS.join(', ')}. Ask the user what the file is if unsure. Nothing changed.`
    const filename = String(args?.filename ?? '').trim() || fileNameOfLink(url)
    if (!/^[^/\\]+\.(safetensors|gguf)$/i.test(filename)) return 'Refused: from the chat only .safetensors and .gguf files are downloaded; give filename if the link does not end in it. Nothing changed.'
    const title = `Download ${filename}`
    const refused = await confirmAction(run, signal, {
      key: 'lu_download start_link', title, strong: true, what: 'A download by link',
      details: [`From ${host}`, `Into ComfyUI ${folder}`, 'No checksum is known for this file.'],
      riskNote: 'A file from the internet; LU only takes safetensors and gguf, never code.',
      names: (t) => t.includes(url),
    })
    if (refused) return refused
    const answer = await startChatLinkDownload(url, folder, filename)
    if (answer?.status === 'error') {
      auditAction(run, 'lu_download start_link', title, 'failed', answer.error)
      return `Error: ${answer.error ?? 'the download did not start'}.`
    }
    useDownloadStore.getState().startPolling()
    auditAction(run, 'lu_download start_link', title, 'applied')
    return `${title} started into ${folder}. Progress is in the Downloads tray.\n${markOf({ kind: 'download', title })}`
  }
  return 'Error: action is search, start, status or start_link.'
}

// ── lu_open_settings ─────────────────────────────────────────────

const OPEN_AT: Record<string, SettingsTab> = {
  keys: 'agent', permissions: 'agent', mcp: 'agent', agent: 'agent', code: 'agent', search: 'agent', memory: 'agent',
  remote: 'voice-remote', local_api: 'voice-remote', voice: 'voice-remote',
  comfyui: 'backends', engine: 'backends', gpu: 'backends', downloads: 'backends', models: 'backends', paths: 'backends',
}

export async function executeLuOpenSettings(args: ToolArgs): Promise<string> {
  const area = lower(args?.area).trim().replace(/[\s-]+/g, '_')
  const tab: SettingsTab = OPEN_AT[area] ?? (isArea(area) ? tabOfArea(area) : 'general')
  useUIStore.getState().openSettingsAt(area === 'comfyui' ? { tab, section: 'comfyui' } : { tab })
  return `Opened Settings → ${tab}. Nothing changed; the user changes it there.`
}

function tabOfArea(a: SettingsArea): SettingsTab {
  if (a === 'engine' || a === 'gpu' || a === 'comfyui' || a === 'downloads') return 'backends'
  if (a === 'voice') return 'voice-remote'
  if (a === 'agent' || a === 'code' || a === 'search' || a === 'memory' || a === 'permissions') return 'agent'
  return 'general'
}

// ── Registration ─────────────────────────────────────────────────

export function registerSelfControlTools(registry: ToolRegistry): void {
  registry.registerBuiltin(SET_SETTINGS_TOOL, (a, run, signal) => executeSetSettings(a, run, signal))
  registry.registerBuiltin(LU_MODELS_TOOL, (a, run, signal) => executeLuModels(a, run, signal))
  registry.registerBuiltin(LU_SERVICE_TOOL, (a, run, signal) => executeLuService(a, run, signal))
  registry.registerBuiltin(LU_DOWNLOAD_TOOL, (a, run, signal) => executeLuDownload(a, run, signal))
  registry.registerBuiltin(LU_OPEN_SETTINGS_TOOL, (a) => executeLuOpenSettings(a))
}
