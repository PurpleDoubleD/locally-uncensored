// The settings the model may read and change on request (A11, 3.0.8:
// "stell Auto Compact auf 80"). One list, used by get_settings and
// set_setting (api/mcp/settings-tools.ts) and by the confirmation card.
//
// Three rules, in this order:
//  1. A key in CATALOG may be changed, always through the card. A few go one
//     way only (towards ask, towards local, towards off for cloud sends).
//  2. Everything security relevant is LOCKED and refused, also under a name
//     the model invents: computer control, remote access, permissions, keys
//     and tokens, paths and executables, plugins and MCP servers, persona
//     texts. The refusal says where the user changes it himself.
//  3. HIDDEN keys are internal and do not exist for the model.
//
// lib/__tests__/settings-catalog.test.ts fails when a key of Settings is in
// none of the three, so a new setting cannot slip through unclassified.

import type { Settings } from '../types/settings'
import type { SettingsTab } from './settings-reset'
import { EFFORT_STEPS } from './effort'
import { normalizeThinkBudget } from './think-budget'
import { normalizeChatFirstReplySeconds } from './chat-reply-timeout'
import { TEMPERATURE_MAX } from './sampling'
import { CONTEXT_WINDOW_MAX, MAX_TOKENS_MAX } from './number-limits'

type Parsed = { ok: true; value: unknown } | { ok: false; error: string }

export interface CatalogEntry {
  /** Settings key, or `builtinEngine.<field>` for the engine tuning. */
  key: string
  label: string
  /** One line for the model. */
  help: string
  /** Allowed values, as the model and the error read them. */
  allowed: string
  tab: SettingsTab
  parse: (v: unknown) => Parsed
  show: (stored: unknown) => string
  /** One-way keys: the only direction the chat may move them. */
  safe?: (next: unknown) => boolean
  safeWhy?: string
}

const TAB_NAME: Record<SettingsTab, string> = {
  general: 'Settings → General',
  backends: 'Settings → Backends',
  agent: 'Settings → Agent',
  'voice-remote': 'Settings → Voice & Remote',
}
export const tabName = (tab: SettingsTab) => TAB_NAME[tab]

// ── Value parsers ───────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/\s*%$/, '').replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

const ON = /^(true|on|yes|1|an|ein|ja|enable|enabled)$/i
const OFF = /^(false|off|no|0|aus|nein|disable|disabled)$/i

function bool(): Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> {
  return {
    allowed: 'on or off',
    parse: (v) => {
      if (typeof v === 'boolean') return { ok: true, value: v }
      const s = String(v ?? '').trim()
      if (ON.test(s)) return { ok: true, value: true }
      if (OFF.test(s)) return { ok: true, value: false }
      return { ok: false, error: 'expects on or off' }
    },
    show: (s) => (s === false ? 'off' : 'on'),
  }
}

function int(min: number, max: number, unit = '', zero?: string): Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> {
  const u = unit ? ` ${unit}` : ''
  return {
    allowed: `${zero ? `0 (${zero}) or ` : ''}${zero && min === 0 ? 1 : min}–${max}${u}`,
    parse: (v) => {
      const n = num(v)
      if (n === null || !Number.isInteger(n)) return { ok: false, error: 'expects a whole number' }
      if (n < min || n > max) return { ok: false, error: 'out of range' }
      return { ok: true, value: n }
    },
    show: (s) => (zero && s === 0 ? `0 (${zero})` : `${String(s)}${u}`),
  }
}

function real(min: number, max: number): Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> {
  return {
    allowed: `${min}–${max}`,
    parse: (v) => {
      const n = num(v)
      if (n === null) return { ok: false, error: 'expects a number' }
      if (n < min || n > max) return { ok: false, error: 'out of range' }
      return { ok: true, value: Math.round(n * 100) / 100 }
    },
    show: (s) => String(s),
  }
}

function oneOf(values: readonly string[]): Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> {
  return {
    allowed: values.join(', '),
    parse: (v) => {
      const s = String(v ?? '').trim().toLowerCase()
      const hit = values.find((x) => x.toLowerCase() === s)
      return hit ? { ok: true, value: hit } : { ok: false, error: `expects one of ${values.join(', ')}` }
    },
    show: (s) => String(s),
  }
}

/**
 * Auto-compact threshold: shown in percent, stored as a fraction, 0 = fit
 * the model. The settings page uses the same rule (SettingsPage.tsx).
 */
export function compactThresholdFromPercent(pct: number): number {
  const p = Math.max(0, Math.min(95, Math.round(pct)))
  return p < 30 ? 0 : p / 100
}

/**
 * One arrow step on the "Compact at" field, in percent. Only 0 and 30 to 95
 * are values, so a step skips the gap: up from 0 is 30, down from 30 is 0.
 * The plain step of 5 went 0 to 5, which the rule above turned back into 0.
 */
export function stepCompactPercent(pct: number, dir: 1 | -1): number {
  const p = Math.max(0, Math.min(95, Math.round(pct)))
  if (dir > 0) return p < 30 ? 30 : Math.min(95, p + 5)
  return p <= 30 ? 0 : p - 5
}

const compactThreshold: Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> = {
  allowed: '0 (auto, fits the model) or 30–95 %',
  parse: (v) => {
    if (typeof v === 'string' && /^auto/i.test(v.trim())) return { ok: true, value: 0 }
    const n = num(v)
    if (n === null) return { ok: false, error: 'expects a percentage' }
    // 0.8 from a model that thinks in fractions is 80 %.
    const pct = n > 0 && n < 1 ? n * 100 : n
    if (pct === 0) return { ok: true, value: 0 }
    if (pct < 30 || pct > 95) {
      return {
        ok: false,
        error: 'auto-compact is set in percent of the context window, not in tokens. Allowed: 0 (auto) or 30–95. Ask the user which percentage they mean',
      }
    }
    return { ok: true, value: compactThresholdFromPercent(pct) }
  },
  show: (s) => (!s ? 'auto' : `${Math.round(Number(s) * 100)} %`),
}

const text = (max: number): Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> => ({
  allowed: `text up to ${max} characters, empty for the default`,
  parse: (v) => {
    const s = String(v ?? '')
    // eslint-disable-next-line no-control-regex
    if (s.length > max || /[\u0000-\u001f\u007f]/.test(s)) return { ok: false, error: `expects one line of at most ${max} characters` }
    return { ok: true, value: s.trim() }
  },
  show: (s) => (s ? `"${String(s)}"` : '(default)'),
})

// ── The whitelist ───────────────────────────────────────────────

const e = (
  key: string, label: string, tab: SettingsTab, help: string,
  kind: Pick<CatalogEntry, 'parse' | 'show' | 'allowed'>,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({ key, label, tab, help, ...kind, ...extra })

export const CATALOG: readonly CatalogEntry[] = [
  // Context. Three different knobs, the help says which is which.
  e('autoCompact', 'Auto-compact', 'general', 'Summarise older turns automatically when the chat nears the context window.', bool()),
  e('autoCompactThreshold', 'Auto-compact at', 'general', 'How full the context window gets before auto-compact runs.', compactThreshold),
  e('contextWindowOverride', 'Context window (Ollama)', 'general', 'num_ctx sent to Ollama, in tokens. Other backends ignore it.', int(0, CONTEXT_WINDOW_MAX, 'tokens', 'auto')),
  e('engineIdleUnloadMinutes', 'Unload the model when unused', 'backends', 'Minutes without use before LU Engine frees the model.', int(0, 1_440, 'min', 'never')),
  e('builtinEngine.ctx', 'Context window (LU Engine)', 'backends', 'Context size of LU Engine, in tokens. Applies on the next engine start.', int(0, 1_048_576, 'tokens', 'default 8192')),
  e('attachmentTokenLimit', 'Attachment limit', 'general', 'Most tokens one attached text file may take.', int(0, 1_048_576, 'tokens', 'no limit')),
  e('contextDecay', 'Context decay', 'agent', 'Shorten old tool results in long agent runs.', bool()),
  e('codexSendWindowTokens', 'Send window (paid models)', 'agent', 'Most tokens one agent step sends to a paid provider.', int(4_096, 2_000_000, 'tokens')),
  // Sampling
  // The ceiling of the slider since A33: above it every model writes noise.
  e('temperature', 'Temperature', 'general', 'Randomness of answers.', real(0, TEMPERATURE_MAX)),
  e('topP', 'Top P', 'general', 'Nucleus sampling.', real(0, 1)),
  e('topK', 'Top K', 'general', 'Sample from the K most likely tokens.', int(1, 100)),
  e('maxTokens', 'Max tokens', 'general', 'Longest answer in tokens.', int(0, MAX_TOKENS_MAX, 'tokens', 'model default')),
  // Thinking
  e('thinkingEnabled', 'Thinking', 'general', 'Let reasoning models think before answering.', bool()),
  e('reasoningEffort', 'Reasoning effort', 'general', 'How hard a reasoning model thinks.', oneOf(EFFORT_STEPS)),
  e('thinkingBudget', 'Think budget', 'general', 'Most tokens a model may spend on thinking.', {
    ...int(0, 1_000_000, 'tokens', 'auto'),
    parse: (v) => { const n = num(v); return n === null ? { ok: false, error: 'expects a whole number' } : { ok: true, value: normalizeThinkBudget(n) } },
  }),
  // Time limits
  e('chatFirstReplyTimeoutSeconds', 'First reply timeout', 'general', 'Seconds a chat waits for the first word of an answer.', {
    ...int(0, 86_400, 's', 'off'),
    parse: (v) => { const n = num(v); return n === null ? { ok: false, error: 'expects seconds' } : { ok: true, value: normalizeChatFirstReplySeconds(n) } },
  }),
  e('imageGenTimeoutMinutes', 'Image timeout', 'general', 'Minutes an image generation may take.', int(1, 480, 'min')),
  e('videoGenTimeoutMinutes', 'Video timeout', 'general', 'Minutes a video generation may take.', int(1, 480, 'min')),
  // Agent limits: read at the start of a run, so a run cannot raise its own.
  e('agentMaxToolCalls', 'Agent tool call limit', 'agent', 'Most tool calls per message. Applies from the next message.', int(0, 10_000, '', 'unlimited')),
  e('agentMaxIterations', 'Agent step limit', 'agent', 'Most steps per message. Applies from the next message.', int(0, 10_000, '', 'unlimited')),
  e('subAgentMaxToolCalls', 'Sub-agent tool call limit', 'agent', 'Most tool calls of one sub-agent.', int(0, 1_000, '', 'default')),
  e('subAgentMaxIterations', 'Sub-agent step limit', 'agent', 'Most steps of one sub-agent.', int(0, 1_000, '', 'default')),
  e('loopMaxPasses', '/loop passes', 'agent', 'How many passes a /loop may run.', int(0, 10_000, '', 'unlimited')),
  // Look and feel
  e('theme', 'Theme', 'general', 'Light or dark app theme.', oneOf(['light', 'dark'])),
  e('emojiAutoReplace', 'Emoji replacement', 'general', 'Turn :) into an emoji while typing.', bool()),
  e('enterKey', 'Enter key', 'general', 'Enter sends the message, or adds a new line (then Ctrl/Cmd+Enter sends).', oneOf(['send', 'newline'])),
  e('backgroundMediaTools', 'Keep chatting while it renders', 'general', 'A long picture or video from the chat goes on in the background.', bool()),
  e('cloudTeasersEnabled', 'Cloud features in Local mode', 'general', 'Show LU Cloud hints in Local mode.', bool()),
  e('cavemanMode', 'Caveman mode', 'general', 'Shorter, terser answers.', oneOf(['off', 'lite', 'full', 'ultra'])),
  e('smallModelMode', 'Small model mode', 'general', 'Lean prompts and fewer tools for 3B–8B models.', bool()),
  e('personasEnabled', 'Personas', 'agent', 'Use the persona system prompt in new chats. Persona texts stay locked.', bool()),
  // Search
  e('searchProvider', 'Search provider', 'agent', 'Which web search the chat uses. Brave and Tavily need a key in Settings → Agent.', oneOf(['auto', 'brave', 'tavily'])),
  e('searchUserAgent', 'Search user agent', 'agent', 'User-Agent of web search and web_fetch.', text(200)),
  // Hardware
  e('builtinEngine.gpuLayers', 'GPU layers (LU Engine)', 'backends', 'Layers offloaded to the GPU, -1 = all. Applies on the next engine start.', int(-1, 999)),
  e('builtinEngine.threads', 'CPU threads (LU Engine)', 'backends', 'CPU threads, -1 = auto. Applies on the next engine start.', int(-1, 256)),
  e('builtinEngine.flashAttn', 'Flash attention (LU Engine)', 'backends', 'Applies on the next engine start.', oneOf(['auto', 'on', 'off'])),
  e('builtinEngine.cacheTypeK', 'KV cache K (LU Engine)', 'backends', 'K cache type, f16 = unquantized.', oneOf(['f16', 'bf16', 'q8_0', 'q4_0'])),
  e('builtinEngine.cacheTypeV', 'KV cache V (LU Engine)', 'backends', 'V cache type; quantized needs flash attention.', oneOf(['f16', 'bf16', 'q8_0', 'q4_0'])),
  e('exclusiveVramMode', 'Free VRAM for images', 'backends', 'Unload the chat model while an image or video renders.', oneOf(['auto', 'always', 'never'])),
  e('comfyGpuMode', 'ComfyUI device', 'backends', 'Run ComfyUI on the GPU or the CPU.', oneOf(['auto', 'cpu', 'gpu'])),
  e('downloadLimitMBps', 'Download limit', 'backends', 'Cap for model downloads.', int(0, 10_000, 'MB/s', 'no limit')),
  // Code
  e('codexRepoMapEnabled', 'Repo map', 'agent', 'Give the coding agent a map of the repository.', bool()),
  e('codexRepoMapLimit', 'Repo map size', 'agent', 'Most files in the repo map.', int(1, 200, 'files')),
  e('codexReviewMode', 'Review mode', 'agent', 'Coding agent only reads, never writes.', bool()),
  e('codexArchitectMode', 'Architect mode', 'agent', 'Plan with one model, edit with another.', bool()),
  // One way only.
  e('codexDefaultMode', 'Default coding mode', 'agent', 'Mode new coding chats start in.', oneOf(['ask', 'plan', 'bypass']), {
    allowed: 'ask or plan (bypass only by hand)',
    safe: (v) => v === 'ask' || v === 'plan',
    safeWhy: 'Bypass runs commands without asking, so only the user can choose it',
  }),
  e('codexConfirmShell', 'Ask before commands', 'agent', 'Coding agent asks before running a command.', bool(), {
    allowed: 'on (off only by hand)', safe: (v) => v === true, safeWhy: 'Turning the question off is the user\'s choice',
  }),
  e('codexCloudConfirmOptIn', 'Ask before cloud commands', 'agent', 'Ask before a cloud model runs a command.', bool(), {
    allowed: 'on (off only by hand)', safe: (v) => v === true, safeWhy: 'Turning the question off is the user\'s choice',
  }),
  e('codexAutoApply', 'Auto-apply edits', 'agent', 'Apply the coding agent\'s edits without review.', bool(), {
    allowed: 'off (on only by hand)', safe: (v) => v === false, safeWhy: 'Applying edits unseen is the user\'s choice',
  }),
  e('appMode', 'App mode', 'general', 'Local runs on this machine, Cloud on LU Cloud.', oneOf(['local', 'cloud']), {
    allowed: 'local (cloud only by hand)', safe: (v) => v === 'local', safeWhy: 'Cloud sends chats off this machine',
  }),
  e('memoryCloudOptIn', 'Memory on LU Cloud', 'agent', 'Extract memories with LU Cloud models.', bool(), {
    allowed: 'off (on only by hand)', safe: (v) => v === false, safeWhy: 'It sends chats to the cloud',
  }),
  e('codexArchitectAllowCloud', 'Architect may use cloud', 'agent', 'Let architect mode plan with a cloud model.', bool(), {
    allowed: 'off (on only by hand)', safe: (v) => v === false, safeWhy: 'It sends code to the cloud',
  }),
]

// ── Locked ──────────────────────────────────────────────────────

export type LockedCategory =
  | 'computer-control' | 'remote-access' | 'permissions' | 'keys' | 'paths' | 'plugins' | 'persona-text'

interface LockRule {
  category: LockedCategory
  what: string
  where: string
  /** Settings keys and names of other stores, compared normalised. */
  names: string[]
  /** Any key that looks like it, under any name the model makes up. */
  pattern: RegExp
}

export const LOCK_RULES: readonly LockRule[] = [
  {
    category: 'computer-control', what: 'Computer control', where: 'the Computer control switch in the composer',
    names: ['computerControl', 'computerUse', 'computerTask', 'screenControl'],
    pattern: /computer|screen(control|access)|mouse|keyboard/,
  },
  {
    category: 'remote-access', what: 'Remote access and the local API', where: 'Settings → Voice & Remote',
    names: ['remotePageTitle', 'remoteAccess', 'shareNewChatsWithPhone', 'remoteEnabled', 'tunnel', 'localApi', 'localApiPort', 'lanAccess', 'cors'],
    pattern: /remote|tunnel|localapi|lan(access)?$|cors|port$|pairing|qr/,
  },
  {
    category: 'permissions', what: 'Permissions', where: 'the permission bar of the chat or Settings → Agent',
    names: ['permissions', 'toolPermissions', 'sandboxLevel', 'bypass', 'autoApprove', 'perToolOverrides'],
    pattern: /permission|sandbox|bypass|autoapprove|allowall|trust/,
  },
  {
    category: 'keys', what: 'API keys and tokens', where: 'Settings → Agent and the provider settings',
    names: ['braveApiKey', 'tavilyApiKey', 'exaApiKey', 'hfToken', 'civitaiToken', 'providerKeys', 'openaiApiKey', 'anthropicApiKey'],
    pattern: /key|token|secret|password|passcode|credential|auth/,
  },
  {
    category: 'paths', what: 'Paths, endpoints and executables', where: 'Settings → Backends',
    names: ['apiEndpoint', 'hfDownloadPathOverride', 'defaultWorkspace', 'comfyPath', 'runtimePath', 'dataFolder'],
    pattern: /path|folder|directory|dir$|endpoint|url|host|workspace|executable|binary|runtime|command|shell/,
  },
  {
    category: 'plugins', what: 'Plugins, MCP servers and custom nodes', where: 'Settings → Agent (MCP) and Plugins in the composer',
    names: ['reaPluginEnabled', 'createEnabled', 'mcpServers', 'customNodes', 'plugins'],
    pattern: /plugin|mcp|customnode|extension|install|rea$/,
  },
  {
    category: 'persona-text', what: 'Persona texts and character cards', where: 'Settings → Agent → Personas',
    names: ['personas', 'systemPrompt', 'personaPrompt', 'characterCard'],
    pattern: /systemprompt|personaprompt|personatext|charactercard|instruction/,
  },
]

/** Internal values the model never sees. */
export const HIDDEN_KEYS: readonly string[] = [
  'onboardingDone', 'localEffortChosen', 'userAvatarDataUrl', 'extraModelIds', 'contextWindowByModel',
  'cloudSendWindowByModel', 'preferredImageModel', 'preferredVideoT2VModel', 'preferredVideoI2VModel',
  'builtinEngine.mlock', 'builtinEngine.noMmap', 'builtinEngine.ctxChosen',
  // Multi-GPU selection lives with its own detection UI, the architect model
  // with the model picker; not offered in v1.
  'gpuVendor', 'gpuIndices', 'gpuRoles', 'codexArchitectModel',
  // Whether a search key lies in the keychain: follows the key, never set on its own.
  'braveKeyStored', 'tavilyKeyStored',
  // Settings of the phone app, which has no settings tools (lib/mobile-tools.ts).
  'mobileDownloadWifiOnly', 'mobileUnloadInBackground',
]

// ── Lookup ──────────────────────────────────────────────────────

export const normKey = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function findEntry(key: string): CatalogEntry | undefined {
  const k = normKey(key)
  if (!k) return undefined
  return CATALOG.find((c) => normKey(c.key) === k || normKey(c.key.replace(/^builtinEngine\./, '')) === k || normKey(c.label) === k)
}

export function lockedRule(key: string): LockRule | undefined {
  const k = normKey(key)
  if (!k) return undefined
  return LOCK_RULES.find((r) => r.names.some((n) => normKey(n) === k))
    ?? LOCK_RULES.find((r) => r.pattern.test(k))
}

export function isHiddenKey(key: string): boolean {
  const k = normKey(key)
  return HIDDEN_KEYS.some((h) => normKey(h) === k || normKey(h.replace(/^builtinEngine\./, '')) === k)
}

/** The three catalog keys closest to an unknown one. */
export function similarKeys(key: string, n = 3): string[] {
  const k = normKey(key)
  const score = (c: CatalogEntry) => {
    const t = normKey(c.key) + normKey(c.label)
    let s = 0
    for (let i = 0; i + 3 <= k.length; i++) if (t.includes(k.slice(i, i + 3))) s++
    return s
  }
  return [...CATALOG].map((c) => [c, score(c)] as const).filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c.key)
}

// ── Read and write ──────────────────────────────────────────────

export function readValue(settings: Settings, key: string): unknown {
  if (key.startsWith('builtinEngine.')) {
    return (settings.builtinEngine as unknown as Record<string, unknown> | undefined)?.[key.slice('builtinEngine.'.length)]
  }
  return (settings as unknown as Record<string, unknown>)[key]
}

/** The partial for updateSettings. */
export function patchFor(settings: Settings, key: string, value: unknown): Partial<Settings> {
  if (key.startsWith('builtinEngine.')) {
    const field = key.slice('builtinEngine.'.length)
    // GH #129: a context the user picked is a choice, not the default.
    const chosen = field === 'ctx' ? { ctxChosen: true } : {}
    return { builtinEngine: { ...settings.builtinEngine, [field]: value, ...chosen } }
  }
  return { [key]: value } as Partial<Settings>
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function describeEntry(entry: CatalogEntry, settings: Settings): string {
  return `${entry.key} = ${entry.show(readValue(settings, entry.key))} | ${entry.allowed} | ${entry.label}: ${entry.help}`
}
