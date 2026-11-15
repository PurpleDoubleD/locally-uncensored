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
import { CONTEXT_WINDOW_MAX, MAX_TOKENS_MAX, SUB_AGENT_LIMIT_MAX } from './number-limits'

type Parsed = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Where a value lives (C60, 3.1.0). The catalog itself imports no store; the
 * read and write of each one is lib/settings-stores.ts. A store that is not
 * named here cannot be written from the chat at all: there is no generic
 * write path, only these entries.
 */
export type SettingsStoreId = 'settings' | 'voice' | 'create' | 'memory' | 'permission' | 'gpu'

/** The groups get_settings lists and the user's words open (C60). */
export type SettingsArea =
  | 'context' | 'sampling' | 'thinking' | 'timeouts' | 'agent' | 'code' | 'look' | 'search'
  | 'engine' | 'gpu' | 'comfyui' | 'create' | 'voice' | 'memory' | 'downloads' | 'cloud' | 'permissions'

/** When a change takes effect, for the card and the model. */
export type SettingApplies = 'now' | 'next-message' | 'engine-restart' | 'comfy-restart' | 'next-render'

export interface CatalogEntry {
  /** Settings key, or `builtinEngine.<field>` for the engine tuning. Other
   *  stores: `<store>.<field>` (voice.ttsEnabled, create.steps …). */
  key: string
  label: string
  /** One line for the model. */
  help: string
  /** Allowed values, as the model and the error read them. */
  allowed: string
  tab: SettingsTab
  parse: (v: unknown) => Parsed
  show: (stored: unknown) => string
  /** One-way keys: the only direction the chat may move them. `current` is
   *  the value now, for keys whose safe direction depends on it. */
  safe?: (next: unknown, current?: unknown) => boolean
  safeWhy?: string
  /** Default 'settings'. */
  store?: SettingsStoreId
  /** Default from AREA_BY_KEY, else from the tab. */
  area?: SettingsArea
  /** 'strong': red card, never after foreign content in the same run, and the
   *  user's own message must name it outright (C60 S3). Default 'card'. */
  risk?: 'card' | 'strong'
  applies?: SettingApplies
  /** More words, DE and EN, that name this setting in a user's message. */
  synonyms?: readonly string[]
  /** A catalog entry whose name matches a LOCK_RULES pattern wins over the
   *  lock (findEntry comes first). That must be a decision, not an accident:
   *  the test wants the reason here. */
  lockOverride?: string
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

// ── GPU cards (Card per task) ───────────────────────────────────

/** A card as the hardware detection reports it (detect_gpus). */
export interface KnownGpuCard { vendor: 'nvidia' | 'amd' | 'intel'; index: number; name: string }

let knownGpuCards: KnownGpuCard[] = []
/** settings-stores.ts fills this before a gpuRoles value is parsed. */
export function setKnownGpuCards(cards: KnownGpuCard[]): void { knownGpuCards = cards }

function gpuCard(): Pick<CatalogEntry, 'parse' | 'show' | 'allowed'> {
  return {
    allowed: 'auto, or a detected card by number or name',
    parse: (v) => {
      const s = String(v ?? '').trim().toLowerCase().replace(/^#/, '')
      if (/^(auto|automatic|automatisch|none|default|standard|keine)$/.test(s)) return { ok: true, value: null }
      if (knownGpuCards.length === 0) return { ok: false, error: 'no GPU detected on this computer, only auto' }
      const byIndex = /^\d+$/.test(s) ? knownGpuCards.filter((c) => c.index === Number(s)) : []
      const byName = knownGpuCards.filter((c) => c.name.toLowerCase().includes(s))
      const hit = byIndex.length === 1 ? byIndex : byName
      if (hit.length !== 1) {
        return { ok: false, error: `expects auto or one of ${knownGpuCards.map((c) => `#${c.index} ${c.name}`).join(', ')}` }
      }
      const c = hit[0]
      return { ok: true, value: { vendor: c.vendor, index: c.index, name: c.name } }
    },
    show: (s) => {
      const r = s as { index?: number; name?: string } | null | undefined
      return r && typeof r.index === 'number' ? `#${r.index} ${r.name ?? ''}`.trim() : 'auto'
    },
  }
}

// ── Permissions, stricter only ──────────────────────────────────

export const PERMISSION_CATEGORIES = ['filesystem', 'terminal', 'desktop', 'web', 'system', 'image', 'video', 'workflow', 'mcp'] as const
const STRICTNESS: Record<string, number> = { auto: 0, confirm: 1, blocked: 2 }

/** True when `next` is as strict as `current` or stricter. Unknown current
 *  counts as the loosest, so the check never trusts a value it cannot read. */
export function stricterOrSame(next: unknown, current: unknown): boolean {
  const n = STRICTNESS[String(next)]
  const c = STRICTNESS[String(current)] ?? 0
  return n !== undefined && n >= c
}

// ── The whitelist ───────────────────────────────────────────────

const e = (
  key: string, label: string, tab: SettingsTab, help: string,
  kind: Pick<CatalogEntry, 'parse' | 'show' | 'allowed'>,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({ key, label, tab, help, ...kind, ...extra })

export const CATALOG: readonly CatalogEntry[] = [
  // Context. Three different knobs, the help says which is which.
  e('autoCompact', 'Auto-compact', 'general', 'Summarise older turns automatically when the chat nears the context window.', bool()),
  e('chatRecall', 'Recall older messages', 'general', 'After a compaction, send the older messages that relate to the new one along, found by a local embedding model.', bool()),
  e('autoCompactThreshold', 'Auto-compact at', 'general', 'How full the context window gets before auto-compact runs.', compactThreshold),
  e('contextWindowOverride', 'Context window (Ollama)', 'general', 'num_ctx sent to Ollama, in tokens. Other backends ignore it; an API model whose server reports no window gets its own from the context button in the chat.', int(0, CONTEXT_WINDOW_MAX, 'tokens', 'auto')),
  e('engineIdleUnloadMinutes', 'Unload the chat model when unused', 'backends', 'Minutes without use before LU Engine, Ollama or LM Studio frees the model.', int(0, 1_440, 'min', 'never')),
  e('builtinEngine.ctx', 'Context window (LU Engine)', 'backends', 'Context size of LU Engine, in tokens. Applies on the next engine start.', int(0, 1_048_576, 'tokens', 'default 8192')),
  e('attachmentTokenLimit', 'Attachment limit', 'general', 'Most tokens one attached text file may take.', int(0, 1_048_576, 'tokens', 'no limit'), { lockOverride: 'A number of tokens, not a token.' }),
  e('contextDecay', 'Context decay', 'agent', 'Shorten old tool results in long agent runs.', bool()),
  e('codexSendWindowTokens', 'Send window (paid models)', 'agent', 'Most tokens one agent step sends to a paid provider.', int(4_096, 2_000_000, 'tokens'), { lockOverride: 'A number of tokens, not a token.' }),
  // Sampling
  // The ceiling of the slider since A33: above it every model writes noise.
  e('temperature', 'Temperature', 'general', 'Randomness of answers.', real(0, TEMPERATURE_MAX)),
  e('topP', 'Top P', 'general', 'Nucleus sampling.', real(0, 1)),
  e('topK', 'Top K', 'general', 'Sample from the K most likely tokens.', int(1, 100)),
  e('maxTokens', 'Max tokens', 'general', 'Longest answer in tokens.', int(0, MAX_TOKENS_MAX, 'tokens', 'model default'), { lockOverride: 'A number of tokens, not a token.' }),
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
  e('agentCompactAuto', 'Short tool list for local models', 'agent', 'Local models up to about 35B see the core tools and find the rest with tool_search.', bool()),
  e('agentLoopGuard', 'Loop guard', 'agent', 'Stops an agent run that repeats the same steps. Off: the run goes on until its step limit or Stop.', bool()),
  e('subAgentMaxToolCalls', 'Sub-agent tool call limit', 'agent', 'Most tool calls of one sub-agent.', int(0, SUB_AGENT_LIMIT_MAX, '', 'default')),
  e('subAgentMaxIterations', 'Sub-agent step limit', 'agent', 'Most steps of one sub-agent.', int(0, SUB_AGENT_LIMIT_MAX, '', 'default')),
  e('loopMaxPasses', '/loop passes', 'agent', 'How many passes a /loop may run.', int(0, 10_000, '', 'unlimited')),
  // Look and feel
  e('theme', 'Theme', 'general', 'Light or dark app theme.', oneOf(['light', 'dark'])),
  e('emojiAutoReplace', 'Emoji replacement', 'general', 'Turn :) into an emoji while typing.', bool()),
  e('enterKey', 'Enter key', 'general', 'Enter sends the message, or adds a new line (then Ctrl/Cmd+Enter sends).', oneOf(['send', 'newline']), { lockOverride: 'The Enter key of the keyboard, not an API key.' }),
  e('backgroundMediaTools', 'Keep chatting while it renders', 'general', 'A long picture or video from the chat goes on in the background.', bool()),
  e('cloudTeasersEnabled', 'Cloud features in Local mode', 'general', 'Show LU Cloud hints in Local mode.', bool()),
  e('cavemanMode', 'Caveman mode', 'general', 'Shorter, terser answers.', oneOf(['off', 'lite', 'full', 'ultra'])),
  e('smallModelMode', 'Small model mode', 'general', 'Lean prompts and fewer tools for 3B–8B models.', bool()),
  e('personasEnabled', 'Personas', 'agent', 'Use the persona system prompt in new chats. Persona texts stay locked.', bool()),
  // Search
  // C60: the providers without a key (duckduckgo, wikipedia) and the local
  // SearXNG too; brave, tavily, exa and you need a key the user enters.
  e('searchProvider', 'Search provider', 'agent', 'Which web search the chat uses. brave, tavily, exa and you need a key in Settings → Agent; searxng needs a local SearXNG.', oneOf(['auto', 'duckduckgo', 'wikipedia', 'searxng', 'brave', 'tavily', 'exa', 'you'])),
  e('searchUserAgent', 'Search user agent', 'agent', 'User-Agent of web search and web_fetch.', text(200)),
  // Hardware
  e('builtinEngine.gpuLayers', 'GPU layers (LU Engine)', 'backends', 'Layers offloaded to the GPU, -1 = all. Applies on the next engine start.', int(-1, 999)),
  e('builtinEngine.threads', 'CPU threads (LU Engine)', 'backends', 'CPU threads, -1 = auto. Applies on the next engine start.', int(-1, 256)),
  e('builtinEngine.flashAttn', 'Flash attention (LU Engine)', 'backends', 'Applies on the next engine start.', oneOf(['auto', 'on', 'off'])),
  e('builtinEngine.cacheTypeK', 'KV cache K (LU Engine)', 'backends', 'K cache type, f16 = unquantized.', oneOf(['f16', 'bf16', 'q8_0', 'q4_0'])),
  e('builtinEngine.cacheTypeV', 'KV cache V (LU Engine)', 'backends', 'V cache type; quantized needs flash attention.', oneOf(['f16', 'bf16', 'q8_0', 'q4_0'])),
  e('exclusiveVramMode', 'Free VRAM for images', 'backends', 'Unload the chat model while an image or video renders.', oneOf(['auto', 'always', 'never'])),
  e('freeAfterRender', 'Free memory after a render', 'backends', 'Unload the image and video models from VRAM and RAM: idle = after 5 minutes without a new render, now = right after, keep = never.', oneOf(['idle', 'now', 'keep'])),
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
    lockOverride: 'One way only, towards asking before a shell command.',
  }),
  e('webStrictUrls', 'Ask before unknown web addresses', 'agent', 'Web tools ask before opening an address that neither you nor a web result gave.', bool(), {
    allowed: 'on (off only by hand)', safe: (v) => v === true, safeWhy: 'Turning the question off is the user\'s choice',
    lockOverride: 'One way only, towards asking before a web address the model made up.',
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

  // ── C60 (3.1.0): the other stores ────────────────────────────────
  // Voice (stores/voiceStore.ts). Endpoints, the microphone and the voice
  // session's own tool switches stay with the user.
  e('voice.ttsEnabled', 'Read aloud (TTS)', 'voice-remote', 'Speaker button under answers.', bool(), { store: 'voice', area: 'voice' }),
  e('voice.autoReadAloud', 'Read every answer aloud', 'voice-remote', 'Read each finished answer aloud by itself.', bool(), { store: 'voice', area: 'voice' }),
  e('voice.sttEnabled', 'Dictation (STT)', 'voice-remote', 'Microphone button in the composer.', bool(), { store: 'voice', area: 'voice' }),
  e('voice.ttsRate', 'Speech rate', 'voice-remote', 'How fast the voice speaks, 1 = normal.', real(0.5, 2), { store: 'voice', area: 'voice' }),
  e('voice.ttsPitch', 'Speech pitch', 'voice-remote', 'Pitch of the browser voice, 1 = normal.', real(0.5, 2), { store: 'voice', area: 'voice' }),
  e('voice.ttsMode', 'Voice engine', 'voice-remote', 'piper = local neural voice, engine = LU Engine audio model. An external endpoint only by hand.', oneOf(['piper', 'engine']), { store: 'voice', area: 'voice' }),
  e('voice.sttMode', 'Dictation engine', 'voice-remote', 'whisper = local faster-whisper, engine = LU Engine audio model. An external endpoint only by hand.', oneOf(['whisper', 'engine']), { store: 'voice', area: 'voice' }),
  e('voice.loopThinking', 'Voice: think first', 'voice-remote', 'In a Voice session the model may think before it answers.', bool(), { store: 'voice', area: 'voice' }),
  e('voice.loopAgent', 'Voice: agent tools', 'voice-remote', 'In a Voice session the model may use the agent tools.', bool(), {
    store: 'voice', area: 'voice', allowed: 'off (on only by hand)', safe: (v) => v === false,
    safeWhy: 'Tools in a spoken session are the user\'s choice',
  }),

  // Create (stores/createStore.ts): the defaults of the Create tab. The image
  // and video model are also what the chat's own picture tools take first
  // (api/model-pick.ts).
  e('create.imageModel', 'Create image model', 'general', 'Image model of the Create tab and of pictures from the chat. An installed one, by name.', text(300), {
    store: 'create', area: 'create', allowed: 'the name of an installed image model', synonyms: ['bildmodell', 'image model'],
  }),
  e('create.videoModel', 'Create video model', 'general', 'Video model of the Create tab and of clips from the chat. An installed one, by name.', text(300), {
    store: 'create', area: 'create', allowed: 'the name of an installed video model', synonyms: ['videomodell', 'video model'],
  }),
  e('create.steps', 'Create steps', 'general', 'Sampling steps of an image.', int(1, 200), { store: 'create', area: 'create', applies: 'next-render', synonyms: ['schritte'] }),
  e('create.cfgScale', 'Create CFG', 'general', 'Prompt strength (CFG scale).', real(0, 30), { store: 'create', area: 'create', applies: 'next-render', synonyms: ['cfg', 'guidance'] }),
  e('create.size', 'Create size', 'general', 'Width x height in pixels, 64–4096 each, e.g. 1024x1024.', {
    allowed: 'WIDTHxHEIGHT, 64–4096 each',
    parse: (v) => {
      const m = /^\s*(\d{2,4})\s*[x×*,]\s*(\d{2,4})\s*$/i.exec(String(v ?? ''))
      if (!m) return { ok: false, error: 'expects WIDTHxHEIGHT, e.g. 1024x1024' }
      const w = Number(m[1]); const h = Number(m[2])
      if (w < 64 || h < 64 || w > 4096 || h > 4096) return { ok: false, error: 'out of range' }
      return { ok: true, value: [w, h] }
    },
    show: (s) => (Array.isArray(s) ? `${s[0]}×${s[1]}` : String(s)),
  }, { store: 'create', area: 'create', applies: 'next-render', synonyms: ['auflösung', 'aufloesung', 'resolution', 'größe', 'groesse', 'format'] }),
  e('create.sampler', 'Create sampler', 'general', 'ComfyUI sampler name, e.g. euler, dpmpp_2m.', {
    ...text(64), allowed: 'a ComfyUI sampler name',
    parse: (v) => { const s = String(v ?? '').trim().toLowerCase(); return /^[a-z0-9_+-]{1,64}$/.test(s) ? { ok: true, value: s } : { ok: false, error: 'expects a sampler name like euler' } },
  }, { store: 'create', area: 'create', applies: 'next-render' }),
  e('create.scheduler', 'Create scheduler', 'general', 'ComfyUI scheduler name, e.g. normal, karras, simple.', {
    ...text(64), allowed: 'a ComfyUI scheduler name',
    parse: (v) => { const s = String(v ?? '').trim().toLowerCase(); return /^[a-z0-9_+-]{1,64}$/.test(s) ? { ok: true, value: s } : { ok: false, error: 'expects a scheduler name like karras' } },
  }, { store: 'create', area: 'create', applies: 'next-render' }),
  e('create.batchSize', 'Create batch', 'general', 'Images per run.', int(1, 8), { store: 'create', area: 'create', applies: 'next-render' }),
  e('create.frames', 'Create video frames', 'general', 'Frames of a clip.', int(1, 2_000), { store: 'create', area: 'create', applies: 'next-render', synonyms: ['frames'] }),
  e('create.fps', 'Create video fps', 'general', 'Frames per second of a clip.', int(1, 120), { store: 'create', area: 'create', applies: 'next-render', synonyms: ['fps'] }),
  e('create.hiresFixEnabled', 'Create hires fix', 'general', 'Second, upscaled pass for images.', bool(), { store: 'create', area: 'create', applies: 'next-render', synonyms: ['hires', 'upscale'] }),

  // Memory (stores/memoryStore.ts, MemorySettings).
  e('memory.autoExtractEnabled', 'Remember facts automatically', 'agent', 'Save memories from chats by itself. Costs one extra model call per answer.', bool(), { store: 'memory', area: 'memory' }),
  e('memory.autoExtractInAllModes', 'Remember outside Agent', 'agent', 'Also save memories from plain chats.', bool(), { store: 'memory', area: 'memory' }),
  e('memory.maxMemoriesOverride', 'Memories per prompt', 'agent', 'How many memories go into a prompt; 0 = fits the model.', int(0, 100, '', 'auto'), { store: 'memory', area: 'memory' }),
  e('memory.maxMemoryChars', 'Memory length', 'agent', 'Most characters of one memory.', int(200, 20_000, 'chars'), { store: 'memory', area: 'memory' }),

  // GPU per task (Card per task, 3.0.8 A2). The card list comes from the
  // hardware detection; settings-stores.ts loads it before the parse.
  e('gpuRoles.chat', 'GPU for chat models', 'backends', 'The card Ollama and LU Engine use: auto, or a card by number or name. Applies on the next start of the engine.', gpuCard(), {
    store: 'gpu', area: 'gpu', applies: 'engine-restart', synonyms: ['grafikkarte', 'karte für den chat', 'card for chat'],
  }),
  e('gpuRoles.comfy', 'GPU for ComfyUI', 'backends', 'The card ComfyUI renders on: auto, or a card by number or name. Applies on the next start of ComfyUI.', gpuCard(), {
    store: 'gpu', area: 'gpu', applies: 'comfy-restart', synonyms: ['grafikkarte', 'karte für comfyui', 'card for comfyui'],
  }),

  // Permissions, stricter only (stores/permissionStore.ts). Looser is the
  // user's own hand: the safe check compares with the level now.
  ...PERMISSION_CATEGORIES.map((cat) => e(`permission.${cat}`, `Permission: ${cat}`, 'agent',
    `What a ${cat} tool may do without asking: auto, confirm (ask first) or blocked. From the chat only stricter.`, oneOf(['blocked', 'confirm', 'auto']), {
      store: 'permission', area: 'permissions',
      allowed: 'stricter than now only (auto → confirm → blocked)',
      safe: (next, current) => stricterOrSame(next, current),
      safeWhy: 'Loosening a permission is the user\'s choice',
      lockOverride: 'A permission may only get stricter from the chat; the safe check enforces it.',
    })),
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
    names: ['reaPluginEnabled', 'neuronsPluginEnabled', 'createEnabled', 'mcpServers', 'customNodes', 'plugins'],
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

/** The key without its store prefix: builtinEngine.ctx → ctx, voice.ttsRate → ttsRate. */
const bareKey = (key: string) => key.replace(/^(builtinEngine|voice|create|memory|permission)\./, '')

export function findEntry(key: string): CatalogEntry | undefined {
  const k = normKey(key)
  if (!k) return undefined
  return CATALOG.find((c) => normKey(c.key) === k || normKey(bareKey(c.key)) === k || normKey(c.label) === k)
}

// ── Areas and the words that name them (C60) ────────────────────

/**
 * The groups get_settings lists, and the words in a user's own message that
 * open them (DE and EN). The same words decide the intent check in
 * settings-tools.ts: a card only comes when the user's message names the area
 * of the setting, or answers the model's question about it.
 */
export const SETTINGS_AREAS: Record<SettingsArea, { label: string; words: readonly string[] }> = {
  context: { label: 'Context and compaction', words: ['context', 'kontext', 'num_ctx', 'compact', 'kompakt', 'kontextfenster', 'recall', 'attachment', 'anhang', 'decay', 'send window'] },
  sampling: { label: 'Sampling', words: ['temperature', 'temperatur', 'top p', 'top_p', 'top k', 'top_k', 'sampling', 'max tokens', 'kreativ', 'creative', 'random', 'zufäll', 'zufall'] },
  thinking: { label: 'Thinking', words: ['think', 'denk', 'reasoning', 'effort', 'nachdenk', 'budget'] },
  timeouts: { label: 'Time limits', words: ['timeout', 'zeitlimit', 'time limit', 'wartezeit', 'wait'] },
  agent: { label: 'Agent', words: ['agent', 'loop', 'schleife', 'sub-agent', 'unteragent', 'tool call', 'werkzeug', 'step limit', 'schrittlimit', 'persona', 'loop guard', 'endlos'] },
  code: { label: 'Code tab', words: ['code', 'coding', 'codex', 'repo map', 'review', 'architect', 'architekt', 'befehl', 'command', 'auto-apply', 'edits'] },
  look: { label: 'Look and input', words: ['theme', 'design', 'dark', 'dunkel', 'hell', 'light', 'emoji', 'enter', 'caveman', 'small model', 'kleine modell', 'aussehen', 'farbe', 'teaser'] },
  search: { label: 'Web search', words: ['search', 'such', 'websuche', 'user agent', 'user-agent', 'brave', 'tavily', 'duckduckgo', 'wikipedia', 'searxng'] },
  engine: { label: 'LU Engine', words: ['engine', 'gpu layers', 'layer', 'threads', 'kerne', 'flash', 'kv cache', 'kv-cache', 'cache', 'vram', 'unload', 'entlad', 'idle', 'llama'] },
  gpu: { label: 'GPU per task', words: ['gpu', 'grafikkarte', 'karte', 'card', 'vram', 'device', 'cpu'] },
  comfyui: { label: 'ComfyUI and memory', words: ['comfy', 'comfyui', 'render', 'vram', 'speicher frei', 'free memory'] },
  create: { label: 'Create defaults', words: ['create', 'bild', 'image', 'video', 'clip', 'steps', 'schritte', 'cfg', 'sampler', 'scheduler', 'auflösung', 'aufloesung', 'resolution', 'größe', 'groesse', 'size', 'batch', 'frames', 'fps', 'hires'] },
  voice: { label: 'Voice', words: ['voice', 'stimme', 'sprach', 'speech', 'tts', 'stt', 'vorlesen', 'vorles', 'read aloud', 'diktat', 'diktier', 'dictation', 'whisper', 'piper'] },
  memory: { label: 'Memory', words: ['memory', 'memories', 'gedächtnis', 'gedaechtnis', 'erinner', 'remember', 'merk'] },
  downloads: { label: 'Downloads', words: ['download', 'herunterlad', 'runterlad', 'bandbreite', 'bandwidth'] },
  cloud: { label: 'Cloud', words: ['cloud', 'local mode', 'lokal', 'offline'] },
  permissions: { label: 'Permissions (stricter only)', words: ['permission', 'berechtigung', 'erlaub', 'allow', 'block', 'sperr', 'nachfrag', 'frag vorher', 'ask before', 'confirm', 'bestätig', 'bestaetig'] },
}

/** Area of the entries written before C60, by key; the rest by tab. */
const AREA_BY_KEY: Record<string, SettingsArea> = {
  autoCompact: 'context', chatRecall: 'context', autoCompactThreshold: 'context', contextWindowOverride: 'context',
  'builtinEngine.ctx': 'context', attachmentTokenLimit: 'context', contextDecay: 'context', codexSendWindowTokens: 'context',
  temperature: 'sampling', topP: 'sampling', topK: 'sampling', maxTokens: 'sampling',
  thinkingEnabled: 'thinking', reasoningEffort: 'thinking', thinkingBudget: 'thinking',
  chatFirstReplyTimeoutSeconds: 'timeouts', imageGenTimeoutMinutes: 'timeouts', videoGenTimeoutMinutes: 'timeouts',
  agentMaxToolCalls: 'agent', agentMaxIterations: 'agent', agentLoopGuard: 'agent', subAgentMaxToolCalls: 'agent',
  subAgentMaxIterations: 'agent', loopMaxPasses: 'agent', personasEnabled: 'agent',
  theme: 'look', emojiAutoReplace: 'look', enterKey: 'look', backgroundMediaTools: 'look', cloudTeasersEnabled: 'cloud',
  cavemanMode: 'look', smallModelMode: 'look',
  searchProvider: 'search', searchUserAgent: 'search',
  engineIdleUnloadMinutes: 'engine', 'builtinEngine.gpuLayers': 'engine', 'builtinEngine.threads': 'engine',
  'builtinEngine.flashAttn': 'engine', 'builtinEngine.cacheTypeK': 'engine', 'builtinEngine.cacheTypeV': 'engine',
  exclusiveVramMode: 'comfyui', freeAfterRender: 'comfyui', comfyGpuMode: 'gpu', downloadLimitMBps: 'downloads',
  codexRepoMapEnabled: 'code', codexRepoMapLimit: 'code', codexReviewMode: 'code', codexArchitectMode: 'code',
  codexDefaultMode: 'code', codexConfirmShell: 'code', codexCloudConfirmOptIn: 'code', codexAutoApply: 'code',
  appMode: 'cloud', memoryCloudOptIn: 'memory', codexArchitectAllowCloud: 'code',
}

export function areaOf(entry: CatalogEntry): SettingsArea {
  return entry.area ?? AREA_BY_KEY[entry.key] ?? (entry.tab === 'backends' ? 'engine' : entry.tab === 'voice-remote' ? 'voice' : entry.tab === 'agent' ? 'agent' : 'look')
}

export function storeOf(entry: CatalogEntry): SettingsStoreId {
  return entry.store ?? 'settings'
}

export function isArea(s: string): s is SettingsArea {
  return Object.prototype.hasOwnProperty.call(SETTINGS_AREAS, s)
}

/** Every word that may name a setting in a user's message: the area words,
 *  each label and every synonym, lower case, at least 3 characters. */
export function catalogWords(): string[] {
  const out = new Set<string>()
  for (const a of Object.values(SETTINGS_AREAS)) for (const w of a.words) out.add(w.toLowerCase())
  for (const c of CATALOG) {
    out.add(c.label.toLowerCase())
    for (const s of c.synonyms ?? []) out.add(s.toLowerCase())
  }
  return [...out].filter((w) => w.length >= 3)
}

/**
 * Does this text name the setting? Its area's words, its label, its key or a
 * synonym. `strict` (strong entries): the label, key or a synonym only, the
 * area alone is not enough.
 */
export function textNames(entry: CatalogEntry, text: string, strict = false): boolean {
  const t = String(text ?? '').toLowerCase()
  if (!t) return false
  const tn = normKey(t)
  if (tn.includes(normKey(entry.key)) || tn.includes(normKey(bareKey(entry.key)))) return true
  if (t.includes(entry.label.toLowerCase())) return true
  if ((entry.synonyms ?? []).some((s) => t.includes(s.toLowerCase()))) return true
  if (strict) return false
  return SETTINGS_AREAS[areaOf(entry)].words.some((w) => t.includes(w))
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
