import { resolveMessageAttachments } from '../../lib/chat-attachments'
import { captureFlashGeneration, chatBilling, parseFlashPolicy, recordFlashResponse } from '../../lib/flash-ui'

/**
 * OpenAI-Compatible Provider
 *
 * Covers: OpenRouter, Groq, Together, LM Studio, vLLM, llama.cpp server,
 * text-generation-webui, Mistral, DeepSeek, OpenAI itself.
 *
 * All use the OpenAI Chat Completions API format:
 *   POST /v1/chat/completions
 *   GET  /v1/models
 */

import type {
  ProviderClient, ProviderModel, ProviderConfig, ChatMessage, ChatOptions,
  ChatStreamChunk, ToolCall, ToolDefinition,
} from './types'
import { ProviderError, type ChatBilling, type CreditRates } from './types'
import { LoopStop, RepetitionStop } from '../../lib/repetition-stop'
import { singleModelSlot } from '../../lib/capabilities'
import { parseSSEStream } from '../sse'
import { idleAbortGuard, isStreamIdleTimeout } from '../stream-idle'
import { sendWithTransientRetry } from './retry'
import { repairJson } from '../../lib/tool-call-repair'
import { signalCreditsExhausted } from '../../lib/credits-exhausted'
import { parseRetryAfter } from '../../lib/http-status'
import { requestLimitMessage } from '../../lib/request-limit'
import { localFetch, localFetchStream, isPrivateOrLanHost, isDirectFetchAllowed, hostnameOf, ensureProxyAllowsHost, backendCall } from '../backend'
import { chatBackendsBack } from '../../lib/chat-backends-gate'
import { openAiSamplerFields } from './sampler-fields'
import { openAiCustomFields } from '../../lib/custom-params'
import { topPForTemperature } from '../../lib/sampling'
import { ensureBuiltinEngineAlive, explainDeadEngine, explainEngineTransportMessage, isManagedBuiltinSlot } from '../builtin-ensure'
import { isLocalTransportFailure, localBackendUnreachableMessage, remoteBackendUnreachableMessage } from '../../lib/local-backend-transport'
import { applyTemplateContract } from './normalize-system'
import { clampEffort, hasEffortLadder, DEFAULT_EFFORT } from '../../lib/effort'
import { thinkBudgetForRequest } from '../../lib/think-budget'
import { chatFirstReplyMs, FIRST_REPLY_TIMEOUT } from '../../lib/chat-reply-timeout'
import {
  applyLocalEffort, isKoboldVersion, isLmStudioV1Models, lmStudioEffortLevels, localEffortNote,
  templateReadsEffort, KOBOLD_EFFORT_LEVELS, LLAMACPP_EFFORT_LEVELS, type LocalEffortServer,
} from '../../lib/local-effort'

/** The server-wide facts cached per endpoint, see `serverFact`. */
type ServerFactKind = 'props' | 'models' | 'kobold' | 'koboldVersion' | 'lmsV1Models'
import {
  parseOpenAIStreamChunk, parseOpenAIChatResponse, keyForUnindexedBlock,
  isRecord, prop, asString, asNumber, asBoolean, asRecordArray,
} from './wire'
import {
  serverRoot, v1Root, parseLlamaCppProps, parseModelsListContext,
  parseKoboldMaxContext, parseLmStudioModel, parseModelRowContext,
  type ProbedContext,
} from './context-probe'
import type { ResolvedContextWindow } from '../../lib/context-source'
import { contextWindowKey, storedWindow, capIsDerivable } from '../../lib/context-source'
import { useSettingsStore } from '../../stores/settingsStore'
import { endpointKey, withExtraModels } from '../../lib/extra-model-ids'
import { log } from '../../lib/logger'
import { estimateTokens } from '../../lib/token-estimate'
import { MOBILE_TEXT, platformText } from '../../lib/platform-text'

// Transport routing lives in the `useLocalProxy` getter (below) plus the shared
// host helpers in backend.ts. A direct webview fetch only works for hosts the
// pinned CSP lists; everything else, LAN backends (also CORS-blocked, GH #49)
// and any cloud endpoint LU ships no preset for, goes through the Rust proxy.
// `isLanBackend` stays separate: it decides local-only BEHAVIOUR (context
// probing), which must not follow the transport decision.

// ── OpenAI API Types ───────────────────────────────────────────
//
// What comes BACK lives in ./wire, behind checked parsers. It used to be
// declared here as two hand-rolled interfaces asserted onto `JSON.parse` and
// `res.json()`, and both said things the code itself knew to be false: the
// tool-call delta declared `index: number` as required while the accumulator
// right below it falls back to `keyForUnindexedBlock` precisely because
// servers omit it, and `choices` was typed as a one-element tuple.

/**
 * What we SEND to `/v1/chat/completions`.
 *
 * A real shape, not a `Record<string, any>` bag: the ladder in `sendChat`
 * reads and deletes four of these fields by name, and under `any` a typo in
 * one of those names would have compiled into a request that silently kept
 * the parameter the server just refused.
 */
export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface OpenAIRequestToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAIRequestMessage {
  role: ChatMessage['role']
  content: string | OpenAIContentPart[]
  tool_calls?: OpenAIRequestToolCall[]
  tool_call_id?: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIRequestMessage[]
  stream: boolean
  temperature?: number
  top_p?: number
  /** F3 (3.0.1): not part of the official OpenAI spec, but every self-hosted
   *  OpenAI-compatible server this app talks to (llama.cpp, vLLM, KoboldCpp,
   *  LM Studio, the built-in engine) accepts it as an extension the same way
   *  it accepts top_p. Omitted when unset, same as top_p, so a real OpenAI
   *  endpoint that 400s on unknown fields never sees it. */
  top_k?: number
  max_tokens?: number
  /** GH #175: extra samplers, only where the backend reads them
   *  (sampler-fields.ts). */
  min_p?: number
  repeat_penalty?: number
  repetition_penalty?: number
  presence_penalty?: number
  frequency_penalty?: number
  dry_multiplier?: number
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'none' | 'required'
  /** One rung of the effort ladder ('none' and 'minimal' mean off). Stepped
   *  down, then deleted, by sendChat. */
  reasoning_effort?: string
  chat_template_kwargs?: Record<string, unknown>
  /** Think budget for the bundled engine only (llama-server b9949 reads it
   *  per request, tools/server/server-common.cpp). Never sent anywhere else. */
  thinking_budget_tokens?: number
  stream_options?: { include_usage: boolean }
  /** Constrained output (ChatOptions.jsonSchema). Never sent to LU Cloud. */
  response_format?: { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown> } }
  /** Round 10, phone only: go on inside the last message, an answer that
   *  was cut (src-tauri/src/commands/engine_continue.rs). Never set unless
   *  the caller asked (ChatOptions.continueFinalMessage). */
  continue_final_message?: boolean
}

/**
 * The two transports this provider posts through: the browser `fetch` and
 * `localFetch`/`localFetchStream` (Rust proxy). Both satisfy this narrower
 * signature, which is what removes the `fetcher as any` casts that used to
 * bridge them, a cast that would equally have accepted a function taking no
 * arguments at all.
 */
type ChatFetcher = (
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<Response>

/** The route's own name of a model the app shows under its published one. */
function catalogNameOf(m: { name?: string; native_name?: string }): string | undefined {
  return m.native_name && m.name && m.name !== m.native_name ? m.name : undefined
}

interface OpenAIModelEntry {
  flash?: unknown
  usage_class?: unknown
  /** Gemessenes Inhaltsverhalten. Nur unsere eigene Wolke schickt das Feld. */
  unfiltered?: unknown
  /** Die zweite Marke des Katalogs. Nur unsere eigene Wolke schickt das Feld. */
  unrestricted?: unknown
  /** Der echte Name eines Modells, das die Wolke auf ihrer eigenen Domain
   *  unter einem neutralen Namen fuehrt. Die App zeigt diesen. */
  native_name?: string
  id: string
  object: string
  created?: number
  owned_by?: string
  // Catalogue metadata some OpenAI-compat servers attach (LU Cloud does):
  // display name, real context window, vision modality, think capability.
  // Absent everywhere else, the mapping below falls back to heuristics.
  name?: string
  /** Das Fenster, mit dem diese Bereitstellung laeuft. */
  context_length?: number
  /**
   * Die trainierte Decke des Modells, falls der Server sie nennt. Getrennt
   * gefuehrt, weil sie nur die Auswahlliste deckelt und nie der Wert ist, der
   * angezeigt oder verrechnet wird.
   */
  trained_context_length?: number
  input_modalities?: string[]
  // LU Cloud /models declares per-model tool-calling support. Some cloud chat
  // models (Hermes 3, Euryale, MythoMax, Llama-4-Maverick, …) can't do function
  // calling; the server marks them false so Agent/Code mode can gate them up
  // front instead of eating a mid-run 400. Absent on backends that don't send
  // it → the mapping falls back to `true` (optimistic, corrected at runtime).
  supports_tools?: boolean
  // LU Cloud /models: may the two Create tools of the chat go to this model?
  // The server's own rule; absent on every other endpoint and on an older
  // LU Cloud, and absent reads as no.
  create_in_chat?: boolean
  // LU Cloud /models: all customers together share a small number of requests
  // a minute on this model, so it asks for a short wait at busy times. The
  // picker says so in a quiet note. Absent reads as no.
  limited_capacity?: boolean
  think?: 'toggle' | 'always' | 'never'
  // The reasoning rungs this model accepts, ascending, and the one it defaults
  // to. LU Cloud sends both for every model that reasons and neither for a
  // `think: 'never'` one. Absent everywhere else, and absent on an LU Cloud
  // deployment that predates 2.6.8, which is why every reader below treats a
  // missing ladder as "keep doing exactly what you did before".
  reasoning_effort_levels?: string[]
  reasoning_effort_default?: string
  // What the model draws per one million tokens, in credits. LU Cloud sends it
  // since 3.0.5; absent everywhere else and on an older deployment.
  credit_rates?: CreditRates
}

/** The models route's `credit_rates`, or nothing. Both sides must be real
 *  numbers: half a rate would print as a price list with a hole in it. */
function parseCreditRates(raw: unknown): CreditRates | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { input_per_million: i, output_per_million: o } = raw as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  return ok(i) && ok(o) ? { inputPerMillion: i, outputPerMillion: o } : undefined
}

/**
 * Build a catalogue entry out of one `/v1/models` element, checking every
 * field on the way. `think` is validated against the three values the rest of
 * the app switches on, a server sending anything else must not smuggle a
 * fourth mode into the model picker.
 */
function toModelEntry(m: Record<string, unknown>): OpenAIModelEntry {
  const think = asString(m.think)
  const ctx = parseModelRowContext(m)
  const levels = Array.isArray(m.reasoning_effort_levels)
    ? m.reasoning_effort_levels.filter((x): x is string => typeof x === 'string')
    : []
  return {
    // A catalogue row with no string id is unusable downstream (it keys
    // KNOWN_CONTEXT and every heuristic); '' keeps the row and keeps
    // guessContextFromName from being handed a non-string.
    id: asString(m.id) ?? '',
    object: asString(m.object) ?? 'model',
    created: asNumber(m.created),
    owned_by: asString(m.owned_by),
    name: asString(m.name),
    native_name: asString(m.native_name),
    flash: m.flash,
    usage_class: m.usage_class,
    unfiltered: m.unfiltered,
    unrestricted: m.unrestricted,
    /*
     * GH #129: dieselbe Zahl, wie der jeweilige Server sie nennt, gelesen vom
     * selben Leser wie die Kaskade (context-probe). Das kostet keine einzige
     * zusaetzliche Anfrage und erspart der Kaskade die meisten.
     *
     * Hier stand `meta.n_ctx_train` als letzter Zweig DIESES Feldes, und damit
     * legte die Liste eine trainierte Decke in den Katalog, aus dem Zaehler
     * und `max_tokens` ihre Zahl ziehen. Gemessen auf der Box am 11.09.2026:
     * llama-server mit `--ctx-size 16384` wurde als 40960 gefuehrt.
     */
    context_length: ctx.window ?? undefined,
    trained_context_length: ctx.trained ?? undefined,
    input_modalities: Array.isArray(m.input_modalities)
      ? m.input_modalities.filter((x): x is string => typeof x === 'string')
      : undefined,
    supports_tools: asBoolean(m.supports_tools),
    create_in_chat: asBoolean(m.create_in_chat),
    limited_capacity: asBoolean(m.limited_capacity),
    think: think === 'toggle' || think === 'always' || think === 'never' ? think : undefined,
    // The ladder is deliberately NOT checked against a fixed list of rungs:
    // which rungs exist is the server's decision, and pinning them here would
    // mean a new rung needs a client release before anyone can pick it. What
    // is checked is the shape. A list that holds no string after filtering is
    // no ladder at all, so it comes back as absent rather than as an empty
    // array, which is the difference between "this model has no rungs" and
    // "this model does not reason".
    reasoning_effort_levels: levels.length > 0 ? levels : undefined,
    // A default the server sends outside its own ladder is not dropped here.
    // `clampEffort` is the one place that decides what an unreachable rung
    // becomes, and it already answers this case; a second answer here would be
    // a second place to keep right.
    reasoning_effort_default: asString(m.reasoning_effort_default),
    credit_rates: parseCreditRates(m.credit_rates),
  }
}

/** The window a listing stated itself, for the picker's context column. */
function declaredContextOf(m: OpenAIModelEntry): number | undefined {
  return m.context_length && m.context_length > 0 ? m.context_length : undefined
}

/**
 * Only the two measured values survive. Anything else a foreign server
 * writes into this field is dropped, same rule at both call sites, one
 * place to keep it right (see the shared literal these two used to be).
 */
function asUnfiltered(u: unknown): 'full' | 'partial' | undefined {
  return u === 'full' || u === 'partial' ? u : undefined
}

/**
 * llama.cpp's context refusal (`exceed_context_size_error`) carries its two
 * numbers beside the sentence, and the sentence alone drops them. Keep them in
 * the text: the Code Agent cuts its history by exactly that much and sends the
 * step again (GH #140, hooks/codex/context-overflow.ts).
 */
function withContextNumbers(message: string, err: unknown): string {
  const nCtx = prop(err, 'n_ctx')
  const nPrompt = prop(err, 'n_prompt_tokens')
  return typeof nCtx === 'number' && typeof nPrompt === 'number'
    ? `${message} (request (${nPrompt} tokens), context size (${nCtx} tokens))`
    : message
}

// ── Known context lengths for popular models ───────────────────

const KNOWN_CONTEXT: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'gpt-4': 8192, 'gpt-3.5-turbo': 16385,
  'gpt-5': 200000, 'gpt-5-mini': 200000, 'gpt-5-nano': 200000,
  'o1': 200000, 'o1-preview': 128000, 'o1-mini': 128000,
  'o3': 200000, 'o3-mini': 200000,
  // DeepSeek
  'deepseek-chat': 64000, 'deepseek-reasoner': 64000, 'deepseek-v3': 64000,
  'deepseek-r1': 64000,
  // Mistral
  'mistral-large-latest': 128000, 'mistral-small-latest': 32000,
  'mistral-medium-latest': 32000, 'codestral-latest': 32000,
  // Groq cloud (popular IDs)
  'llama-3.3-70b-versatile': 131072, 'llama-3.1-70b-versatile': 131072,
  'llama-3.1-8b-instant': 131072, 'mixtral-8x7b-32768': 32768,
  // Common OpenRouter aliases
  'meta-llama/llama-3.3-70b-instruct': 131072,
  'meta-llama/llama-3.1-405b-instruct': 131072,
  'qwen/qwen-2.5-72b-instruct': 32768,
}

// Heuristik aus dem Modell-Namen, letzter Fallback bevor wir auf den
// konservativen 8192er-Default zurueckfallen. Wird nur erreicht wenn weder
// KNOWN_CONTEXT noch `probeContextFromServer()` ein Ergebnis liefert.
function guessContextFromName(model: string): number {
  const lower = model.toLowerCase()
  if (lower.includes('llama-3.1') || lower.includes('llama3.1')) return 131072
  if (lower.includes('llama-3.2') || lower.includes('llama3.2')) return 131072
  if (lower.includes('llama-3.3') || lower.includes('llama3.3')) return 131072
  if (lower.includes('llama-3') || lower.includes('llama3')) return 8192
  if (lower.includes('qwen2.5') || lower.includes('qwen-2.5')) return 32768
  if (lower.includes('qwen3') || lower.includes('qwen-3')) return 32768
  if (lower.includes('qwen2') || lower.includes('qwen-2')) return 32768
  if (lower.includes('qwen')) return 32768
  if (lower.includes('gemma-3') || lower.includes('gemma3')) return 8192
  if (lower.includes('gemma-2') || lower.includes('gemma2')) return 8192
  if (lower.includes('phi-3.5') || lower.includes('phi3.5')) return 128000
  if (lower.includes('phi-3') || lower.includes('phi3')) return 128000
  if (lower.includes('phi-4') || lower.includes('phi4')) return 16384
  if (lower.includes('mistral-large') || lower.includes('mistral-small')) return 32768
  if (lower.includes('mistral-nemo') || lower.includes('mistral-medium')) return 128000
  if (lower.includes('mistral')) return 32768
  if (lower.includes('mixtral')) return 32768
  if (lower.includes('deepseek-r1') || lower.includes('deepseek-v3')) return 64000
  if (lower.includes('deepseek')) return 32000
  if (lower.includes('command-r')) return 128000
  if (lower.includes('yi-')) return 32768
  if (lower.includes('codestral')) return 32768
  if (lower.includes('qwen2.5-coder') || lower.includes('coder')) return 32768
  if (lower.includes('hermes')) return 8192
  if (lower.includes('granite-3')) return 128000
  return 8192
}

// Real context windows from the provider's /models catalogue (LU Cloud sends
// context_length per model). The name heuristic underestimates new cloud
// models badly (Qwen3.6-35B-A3B → 32k guess vs 262k real), which shrinks the
// applyMaxTokens headroom toward the 256 floor on long chats and truncates
// answers. Module-level and keyed by endpoint, NOT an instance field: the
// lu-cloud provider builds a FRESH OpenAIProvider delegate on every call (its
// bearer token rotates), so an instance map is always empty exactly where it
// matters. listModels fills it through one delegate; chatStream's
// applyMaxTokens and getContextLength read it through another.
const catalogContext = new Map<string, number>()

/**
 * Die trainierte Decke aus demselben Katalog, getrennt gefuehrt.
 *
 * Sie deckelt die Auswahlliste im Waehler und beantwortet die Frage nach dem
 * Fenster nur dann, wenn niemand ein laufendes genannt hat. In `catalogContext`
 * gehoert sie nicht: was dort steht, wird angezeigt und verrechnet.
 */
const catalogTrained = new Map<string, number>()

/**
 * Models whose catalogue entry declared their own rungs. Their ladder is the
 * server's word and the user's rung goes out as it always did; every other
 * ladder on a local slot is one this client read from the server itself
 * (issue 176) and waits for the user's own pick (localEffortChosen).
 */
const catalogEffort = new Set<string>()

/** Ceiling for the optional metadata probes, see `probeInit`. */
const CONTEXT_PROBE_TIMEOUT_MS = 2500

/**
 * Flat token cost charged for one inline image during prompt estimation.
 *
 * Audit CS-1: a base64 data URL is ~1.37 characters per byte of source image,
 * so a single 100 KB screenshot adds ~137 000 characters to `body.messages`,
 * ~34 000 phantom "tokens" under the chars/4 rule, which is more than the ENTIRE
 * window of every model at or below 32k (the built-in engine, LM Studio,
 * llama.cpp, vLLM, KoboldCpp). The headroom subtraction then went negative and
 * the 256 floor won, capping every answer with an attachment at 256 tokens,
 * and getting worse each turn, because images ride along in the history.
 *
 * Images do not cost characters, they cost tiles. OpenAI bills a 1024x1024
 * image at ~1100 tokens; Qwen2-VL / llava-style mmproj projectors on local
 * servers land in the same order of magnitude, and vision backends generally
 * cap a single image near 1.5k. 1500 is the conservative end of that range:
 * over-estimating only shortens the completion cap a little, under-estimating
 * risks the server rejecting the request outright.
 */
const IMAGE_TOKEN_ESTIMATE = 1500

/**
 * Serialized size of a request payload with every inline image replaced by a
 * placeholder, plus how many images were found.
 *
 * Pure: the value is walked through JSON.stringify's replacer, so `messages`
 * is never mutated and the body that goes on the wire keeps its full images.
 * Recognises the OpenAI part shape (`{ type: 'image_url', image_url: {...} }`),
 * the Anthropic-style `{ type: 'image', source: {...} }`, and any bare base64
 * data URL string, wherever they sit in the history.
 */
function measurePayload(value: unknown): { tokens: number; images: number } {
  let images = 0
  const json = JSON.stringify(value, (_key, val) => {
    if (typeof val === 'string' && val.startsWith('data:') && val.includes(';base64,')) {
      images++
      return ''
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const part = val as Record<string, unknown>
      if (part.type === 'image_url') {
        images++
        return { type: 'image_url' }
      }
      if (part.type === 'image' && part.source) {
        images++
        return { type: 'image' }
      }
    }
    return val
  })
  // GH #167: the same script aware estimate as the history budget, not a
  // flat chars / 4 that undercounted Japanese about 2.8 times.
  return { tokens: json ? estimateTokens(json) : 0, images }
}

/** Test-only: reset the endpoint catalogue between test cases. */
export function __clearContextCatalogForTests(): void {
  catalogContext.clear()
  catalogTrained.clear()
}

// ── Provider Implementation ────────────────────────────────────

/**
 * Laeuft die eingebaute Engine gerade? `null` heisst: nicht zu erfahren (kein
 * Tauri, das Kommando fehlt). Dann wird gefragt wie bisher. Mit Absicht der
 * rohe Aufruf und nicht `bundledEngineStatus()` aus api/engine: der gleicht
 * nebenbei den Port ab und meldet Hinweise, und das ist nicht Sache einer
 * Kontextabfrage.
 */
async function builtinEngineRunning(): Promise<boolean | null> {
  try {
    const status = await backendCall<{ running?: unknown } | null>('bundled_engine_status')
    return typeof status?.running === 'boolean' ? status.running : null
  } catch {
    return null
  }
}

export class OpenAIProvider implements ProviderClient {
  readonly id = 'openai' as const
  /** GitHub #173: set when this client serves an additional entry. */
  readonly entryId?: string

  private readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
    if (config.entryId) this.entryId = config.entryId
  }

  private catalogKey(model: string): string {
    return `${this.baseUrl}|${model}`
  }

  /**
   * Was die Modellliste ueber das Fenster gesagt hat, fuer applyMaxTokens und
   * den Waehler. Fenster und Decke landen in getrennten Ablagen; beide Zweige
   * von `listModels` schreiben durch DIESE eine Stelle, damit es nicht wieder
   * zwei Schreibwege mit verschiedener Bedeutung gibt.
   */
  private rememberCatalog(m: OpenAIModelEntry): void {
    const key = this.catalogKey(m.id)
    if (m.context_length && m.context_length > 0) catalogContext.set(key, m.context_length)
    if (m.trained_context_length && m.trained_context_length > 0) {
      catalogTrained.set(key, m.trained_context_length)
    }
    if (Array.isArray(m.reasoning_effort_levels) && m.reasoning_effort_levels.length > 0) catalogEffort.add(key)
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  /**
   * A backend on this machine or the LAN, declared by the preset
   * (`config.isLocal`) OR detected from the host (localhost, RFC1918, CGNAT,
   * IPv6 ULA/link-local, .local, bare machine name). Drives behaviour that only
   * makes sense locally: per-model context probing and the LM Studio enhanced
   * API. Cloud endpoints must not do those (N+1 requests → rate limits).
   */
  /** GH #175 with #173: what sampler-fields.ts decides on for this server. */
  private get samplerTarget(): { id: ProviderConfig['id']; isLocal: boolean; managed?: boolean } {
    return { id: this.config.id, isLocal: this.isLanBackend, managed: this.config.managed }
  }

  private get isLanBackend(): boolean {
    return this.config.isLocal === true || isPrivateOrLanHost(hostnameOf(this.baseUrl))
  }

  /**
   * Whether requests must go through the Rust proxy instead of a direct webview
   * fetch. Two reasons: a LAN endpoint has no CORS headers for the
   * tauri.localhost origin (GH #49), and a public host outside the pinned CSP
   * allow-list gets killed inside the webview before it hits the network, that
   * is every custom OpenAI-compatible provider a user configures themselves
   * (their own domain, or a vendor LU ships no preset for).
   */
  private get useLocalProxy(): boolean {
    return this.isLanBackend || !isDirectFetchAllowed(hostnameOf(this.baseUrl))
  }

  /**
   * Bug B3 round 2: the message sequence this endpoint can actually render.
   *
   * A LAN backend (the bundled engine, LM Studio, llama.cpp, vLLM, Jan, …)
   * renders the MODEL's own Jinja chat template, and a strict one raises
   * rather than improvises: no `tool` role, no two turns of the same role in
   * a row, user first. A cloud endpoint implements the protocol itself and
   * wants the plain OpenAI shape, so it is left alone.
   *
   * `nativeTools` is the second half of the rule and the reason this is not
   * a blanket downgrade. When the request carries a `tools` payload, the
   * strategy resolution already asked this very server whether its template
   * understands tools (serverToolSupport, /props chat_template_caps or the
   * LM Studio per-model listing) and got a yes. Then the tool channel stays
   * native, ids and all. When it does NOT carry one, the run is on the
   * prompt transport, and a leftover `tool` message in the history is a role
   * this template has no branch for. That is exactly the payload the
   * counter-check killed the built-in engine with.
   */
  private templateContract(messages: ChatMessage[], nativeTools: boolean): ChatMessage[] {
    const rendersTemplate = this.isLanBackend && !nativeTools
    return applyTemplateContract(messages, {
      toolRole: rendersTemplate ? 'text' : 'native',
      alternate: rendersTemplate,
    })
  }

  /**
   * Run a send and, when this slot is the app's own engine, translate a
   * transport failure into a sentence about the engine. A refused connection
   * to 127.0.0.1:8127 used to surface as the raw proxy error, which is how a
   * fresh Windows install introduced itself to a user on 2026-08-01 before
   * they moved to Ollama. Anything that reached an HTTP response is untouched.
   */
  private async sendOrExplain(send: () => Promise<Response>): Promise<Response> {
    try {
      return await send()
    } catch (err) {
      if (this.config.managed === true) throw explainDeadEngine(err, this.baseUrl)
      throw err
    }
  }

  /**
   * The thinking knob for this request, or undefined to leave it out.
   *
   * Toggle OFF used to send 'minimal', the least the OpenAI API itself allows.
   * A user traced what that means elsewhere (#112, 2026-08-13): DwarfStar
   * reads 'minimal' as think_mode high, so our OFF switch turned thinking ON
   * and his tool workflows paid the latency he had just disabled. Only 'none'
   * really disables it. Our own cloud proxy already translates minimal to
   * none, so this never showed up on LU Cloud, only on servers users point us
   * at themselves.
   *
   * 'none' is younger than 'minimal' though, and an endpoint that predates it
   * answers 400. So sendChat walks the knob down instead of swapping it, and
   * remembers how far it had to walk, per endpoint and model.
   */
  private thinkingEffort(
    model: string,
    thinking: boolean | undefined,
    options?: ChatOptions,
  ): string | undefined {
    const levels = options?.effortLevels
    // A local ladder the user has not touched yet counts as no ladder at all,
    // which is exactly the request every local server got before 3.0.7.
    const ladder = hasEffortLadder(levels) && !this.localEffortWaits(model, options)
    // No wish and no declared ladder: send nothing, exactly as before. A model
    // that always reasons and a model that never does both arrive here with
    // `thinking` undefined, and on a server that does not declare rungs they
    // keep deciding for themselves.
    if (thinking === undefined && !ladder) return undefined

    // OFF stays OFF, on its own lane and with its own memory. A model whose
    // catalogue entry says it always reasons never reaches this branch: the
    // composer keeps its Think button locked on, so 'none' is never asked for
    // it. That matters in money: on GLM 5.3 'none' does not stop the thinking,
    // it only stops the upstream from separating it, so the monologue lands in
    // the customer's chat window and costs MORE than sending nothing.
    if (thinking === false) {
      const walkedOff = OpenAIProvider.effortMemory.get(this.effortKey(model, 'off'))
      if (walkedOff?.off === 'omit') return undefined
      return walkedOff?.off === 'minimal' ? 'minimal' : 'none'
    }

    // ON: the wish, clamped onto the rungs this model really has. Without a
    // ladder that is DEFAULT_EFFORT, which is the 'high' this client has always
    // sent.
    //
    // There is no client-side walk down the rungs. The server clamps every rung
    // it knows onto the model's own ladder before the request leaves the proxy,
    // so a rung off this ladder does not come back as a 4xx. Walking it here
    // would only blame the everyday 400 (an overlong context) on the knob, cost
    // up to seven posts for one message, and leave a downgrade in the memory
    // that nothing ever clears.
    const wanted = ladder
      ? clampEffort(levels, options?.reasoningEffort ?? DEFAULT_EFFORT, options?.effortDefault)
      : DEFAULT_EFFORT
    const walked = OpenAIProvider.effortMemory.get(this.effortKey(model, 'on', wanted))
    return walked?.on === 'omit' ? undefined : wanted
  }

  /**
   * Memory key for one lane of the walk.
   *
   * The OFF lane is a single switch position, so one key per model does. The ON
   * lane has as many positions as the model has rungs and they are NOT
   * interchangeable: Qwen/Qwen3.8-27B answers 400 to 'high' and serves
   * 'medium' without complaint (live measurement 2026-09-02). Keyed by rung, a
   * 'max' that had to give the knob up cannot take 'low' down with it, the same
   * way the ON lane has never been allowed to take the OFF lane down with it.
   */
  private effortKey(model: string, lane: 'on' | 'off', rung?: string): string {
    const base = this.catalogKey(model)
    return lane === 'off' ? base : `${base}#${rung ?? DEFAULT_EFFORT}`
  }

  /**
   * The thinking knob a backend that renders the MODEL'S OWN template reads.
   *
   * `reasoning_effort` is an OpenAI-API concept. A server that runs the
   * model's Jinja template itself does not have a reasoning mode of its own:
   * the switch lives INSIDE the template, as the `enable_thinking` variable
   * the Qwen, GLM, Nemotron and Hunyuan cards branch on, and it is reached
   * through `chat_template_kwargs`.
   *
   * Counter-check on the bundled engine (lu-llama-server b1-049326a,
   * 2026-08-29), asking /apply-template with a template that prints which
   * branch it took:
   *
   *   reasoning_effort: 'high'                      -> MARKER_THINK_OFF
   *   chat_template_kwargs: {enable_thinking:true}  -> MARKER_THINK_ON
   *
   * and the chat request carrying reasoning_effort answered 200, so nothing
   * ever complained. That is the owner's report exactly: the Think button was on,
   * the model did not think, and no thinking block appeared, because nothing
   * on the wire ever asked it to.
   *
   * Only for a backend on this machine or the LAN. A cloud endpoint
   * implements the protocol itself, does not render a template, and the
   * strict ones (api.openai.com) refuse an unknown body field outright.
   * The ladder in sendChat drops the field for a local server that refuses it
   * too, and remembers, so the cost is one round trip once.
   */
  private templateThinkingKwargs(thinking: boolean | undefined): Record<string, unknown> | undefined {
    if (thinking === undefined) return undefined
    if (!this.isLanBackend) return undefined
    if (OpenAIProvider.templateKwargsRefused.has(this.baseUrl)) return undefined
    return { enable_thinking: thinking }
  }

  /**
   * Think budget (D12), for the app's own engine only.
   *
   * The pinned llama-server b9949 reads `thinking_budget_tokens` on every
   * chat request and ends the thought by force once that many tokens are
   * spent (tools/server/server-common.cpp, reasoning budget sampler). Any
   * other server in this slot is a version we do not know, and the cloud
   * endpoints refuse unknown fields, so nobody else gets it.
   */
  /**
   * GH #198: the custom sampling rows of the persona and the chat, as top
   * level fields, under the names typed. A field LU sets itself is never
   * taken from a row (lib/custom-params.ts). Not for LU Cloud, whose proxy
   * refuses a field it does not know. A strict remote server may refuse one
   * too; the person added the row for that server and sees its answer.
   */
  private applyCustomParams(body: OpenAIChatRequest, options?: ChatOptions): void {
    if (this.config.id === 'lu-cloud') return
    Object.assign(body, openAiCustomFields(options?.customParams))
  }

  private applyThinkBudget(body: OpenAIChatRequest, options?: ChatOptions): void {
    if (this.config.managed !== true) return
    const budget = thinkBudgetForRequest(options?.thinking, options?.thinkingBudget)
    if (budget !== undefined) body.thinking_budget_tokens = budget
  }

  /**
   * Which local server sits behind this slot, for the effort form (issue
   * 176). The managed slot is the LU Engine; anything else is asked once per
   * endpoint and five minutes through the same cache as the context probe.
   * Order matters: KoboldCpp answers a llama.cpp style /props too.
   */
  private async localEffortServer(signal?: AbortSignal): Promise<LocalEffortServer> {
    if (this.config.managed === true) return 'engine'
    if (!this.isLanBackend || this.config.id === 'lu-cloud') return 'unknown'
    const root = serverRoot(this.baseUrl)
    if (isKoboldVersion(await this.serverFact('koboldVersion', `${root}/api/extra/version`, signal))) return 'kobold'
    if (isLmStudioV1Models(await this.serverFact('lmsV1Models', `${root}/api/v1/models`, signal))) return 'lmstudio'
    if (templateReadsEffort(await this.serverFact('props', `${root}/props`, signal))) return 'llamacpp'
    return 'unknown'
  }

  /**
   * The effort ladder a LAN model gets when its listing declared none, or the
   * note that says why the control is greyed. LU Cloud on a local port
   * declares its own and never comes here.
   */
  private async localEffortFor(model: string): Promise<{ levels?: string[]; note?: string }> {
    const server = await this.localEffortServer()
    if (server === 'kobold') return { levels: [...KOBOLD_EFFORT_LEVELS] }
    if (server === 'llamacpp') return { levels: [...LLAMACPP_EFFORT_LEVELS] }
    if (server === 'lmstudio') {
      const levels = lmStudioEffortLevels(await this.serverFact('lmsV1Models', `${serverRoot(this.baseUrl)}/api/v1/models`), model)
      return levels ? { levels } : { note: localEffortNote('lmstudio') }
    }
    // A server whose /props shows a template without the variable is llama.cpp
    // all the same; the note then names the template, not the backend.
    const props = await this.serverFact('props', `${serverRoot(this.baseUrl)}/props`)
    return { note: localEffortNote(typeof props === 'object' && props !== null && 'chat_template' in props ? 'llamacpp' : 'unknown') }
  }

  /**
   * Reshape the rung into the form this local server reads (issue 176). Only
   * when the composer offered rungs for this model, so a model without them
   * keeps exactly the request it had before.
   */
  private async applyLocalEffortForm(body: OpenAIChatRequest, model: string, options?: ChatOptions): Promise<void> {
    if (options?.thinking !== true || !hasEffortLadder(options?.effortLevels)) return
    if (body.reasoning_effort === undefined) return
    if (!this.isLocalEffortSlot) return
    if (this.localEffortWaits(model, options)) return
    applyLocalEffort(body, await this.localEffortServer(), options?.thinkingBudget)
  }

  /** The LU Engine or a server on this machine or the LAN, LU Cloud aside. */
  private get isLocalEffortSlot(): boolean {
    return this.config.managed === true || (this.isLanBackend && this.config.id !== 'lu-cloud')
  }

  /**
   * Does this model's ladder wait for the user's own pick (3.0.7, after
   * issue 176)? The global rung defaults to 'high', and before 3.0.7 no local
   * server ever got it in a form it reads: the LU Engine and llama.cpp
   * ignored the top-level field, so gpt-oss ran on its template's own Medium.
   * Sending the default as a real rung would change speed and behaviour for
   * everyone who never touched the button. So a ladder this client read from
   * a local server stays off the wire until the user picked a rung there,
   * and the request is the one from before 3.0.7 (LM Studio and KoboldCpp
   * keep their top-level 'high', the engine gets nothing in the template).
   */
  private localEffortWaits(model: string, options?: ChatOptions): boolean {
    if (options?.localEffortChosen === true) return false
    if (!this.isLocalEffortSlot) return false
    return !catalogEffort.has(this.catalogKey(model))
  }

  /** Remember a walk, for one lane and one rung only. */
  private rememberEffort(key: string, lane: 'on' | 'off', value: 'minimal' | 'omit'): void {
    const prev = OpenAIProvider.effortMemory.get(key) ?? {}
    const next = { ...prev }
    if (lane === 'on') next.on = 'omit'
    else next.off = value
    OpenAIProvider.effortMemory.set(key, next)
  }

  /**
   * POST a chat body, stepping the thinking knob down rather than dropping it
   * at the first complaint: 'none', then 'minimal', then gone. The last step
   * also drops stream_options, the other field an endpoint that predates both
   * rejects. The LU Cloud proxy deliberately passes upstream 400 AND 422
   * (the upstream's bad-parameter status) through so this path can engage.
   *
   * Only a request that then SUCCEEDS teaches us anything. A 400 for an
   * unrelated reason (an overlong context is the common one) walks the same
   * ladder and must not leave a memory behind, or one oversized message would
   * cost the user their thinking switch for the rest of the session.
   *
   * stream_options gets its own rung ahead of dropping the knob, so a 400 that
   * field caused is never blamed on thinking. Dropping both at once and then
   * crediting the knob is how an endpoint that only dislikes stream_options
   * ended up remembered as one that cannot think at all.
   */
  private async sendChat(
    model: string,
    body: OpenAIChatRequest,
    signal: AbortSignal | undefined,
    fetcher: ChatFetcher,
  ): Promise<Response> {
    const billingGeneration = captureFlashGeneration()
    // Sanierungspfad: a throttle or a gateway hiccup is not the request's
    // fault, and the user used to read the raw status line for it. The retry
    // sits HERE, around the request, so it can never replay a stream that has
    // already started, see providers/retry.ts for the rules.
    const post = () => sendWithTransientRetry(
      () => fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
      }),
      { signal },
    )
    const refused = (res: Response) => !res.ok && (res.status === 400 || res.status === 422)

    const asked = body.reasoning_effort
    // 'none' and 'minimal' are the two ways of saying off; every other rung is
    // the ON lane. Reading it off the value rather than off 'high' is what lets
    // 'low', 'medium' and 'max' keep their own memory instead of borrowing the
    // off switch's.
    const lane: 'on' | 'off' | undefined =
      asked === undefined ? undefined : asked === 'none' || asked === 'minimal' ? 'off' : 'on'
    const memoryKey = lane === undefined ? '' : this.effortKey(model, lane, asked)

    // Stop ends the walk. The real fetch rejects on an aborted signal on its
    // own, but localFetchStream's proxy path used to fire the request anyway,
    // so the ladder could keep spending steps after the user was done.
    const stopped = () => signal?.aborted === true

    let res = await this.sendOrExplain(post)

    if (!stopped() && refused(res) && body.reasoning_effort === 'none') {
      body.reasoning_effort = 'minimal'
      res = await post()
    }

    // Its own rung, ahead of both the knob and stream_options: a server that
    // refuses the template kwargs must not be remembered as one that cannot
    // think. Dropped for the whole endpoint once it succeeds without it, so
    // the extra round trip is paid once and not on every message.
    if (!stopped() && refused(res) && 'chat_template_kwargs' in body) {
      delete body.chat_template_kwargs
      res = await post()
      if (res.ok) OpenAIProvider.templateKwargsRefused.add(this.baseUrl)
    }

    if (!stopped() && refused(res) && 'stream_options' in body) {
      delete body.stream_options
      res = await post()
    }

    if (!stopped() && refused(res) && 'reasoning_effort' in body) {
      delete body.reasoning_effort
      res = await post()
    }

    if (res.ok && lane) {
      const survived = body.reasoning_effort
      if (survived === undefined) this.rememberEffort(memoryKey, lane, 'omit')
      else if (survived !== asked) this.rememberEffort(memoryKey, lane, 'minimal')
    }

    recordFlashResponse(this.catalogKey(model), res, billingGeneration)
    return res
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      h['Authorization'] = `Bearer ${this.config.apiKey}`
    }
    // OpenRouter requires these headers
    if (this.config.baseUrl.includes('openrouter.ai')) {
      h['HTTP-Referer'] = 'https://lu-labs.ai'
      h['X-Title'] = 'LU'
    }
    return h
  }

  /**
   * Request init for the optional side probes (context window, tool
   * capabilities). Every one of them is an OPTIMISATION, a failure just means
   * the cascade falls back to a heuristic, but they ran with neither a signal
   * nor a timeout, so a LAN backend that accepts the TCP connection and then
   * says nothing blocked the user's message for the proxy's full default
   * (300 s, and applyMaxTokens can hit two of them) with Stop unable to cut in.
   * A few seconds is already generous for a local metadata endpoint.
   */
  private probeInit(signal?: AbortSignal): {
    headers: Record<string, string>; timeoutMs: number; signal?: AbortSignal
  } {
    return { headers: this.headers, timeoutMs: CONTEXT_PROBE_TIMEOUT_MS, signal }
  }

  /**
   * Bound `max_tokens` so prompt + completion can never exceed the model's real
   * context window. Some cloud backends otherwise default the
   * completion budget to nearly the whole window and then 400 the moment the
   * real prompt (agent system prompt + tool definitions) tips it over,    * surfaced as "[network] inference upstream error" on tool turns (Bug 5,
   * 2026-07-11). Under-estimating the context is safe (a shorter cap); we never
   * over-request. Runs for every request, so an UNSET budget (settings.maxTokens
   * = 0) sends the full safe remainder instead of letting the server over-default.
   *
   * Ab GH #129 gilt das nur noch fuer ein GEMESSENES Fenster. Was die Rechnung
   * schuetzen soll, ist ein Server, der sein eigenes Fenster kennt; ist die
   * Zahl geraten, schuetzt sie nichts und behauptet nur etwas. Siehe den Block
   * im Rumpf.
   */
  private async applyMaxTokens(
    model: string,
    body: OpenAIChatRequest,
    options?: ChatOptions,
  ): Promise<void> {
    const requested = options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : 0
    // LU Cloud sizes an absent budget itself: it clamps to the room the model
    // has, and a free Flash request gets its 8192 default. Our own fallback of
    // up to 32768 read there as an explicit wish, so Flash reserved four times
    // what the web reserves for the same message and fell over to credits
    // while the day's free allowance still had room (bug hunt 01.10.2026, H5).
    // Only the user's own number goes up.
    if (this.config.id === 'lu-cloud' && (requested === 0 || options?.maxTokensIsDefault)) {
      delete body.max_tokens
      return
    }
    let ctxLen = 0
    let derivable = false
    // Audit: the probe behind this runs on the SEND path. Without the signal a
    // Stop could not interrupt it, and without a timeout a hung LAN backend
    // held the message hostage for the proxy's full 300 s (twice). Both are
    // threaded through probeInit(); on a timeout the cascade just falls back to
    // the heuristic, which is what an optional optimisation should do.
    try {
      const resolved = await this.getContextWindow(model, options?.signal)
      ctxLen = resolved.tokens
      derivable = capIsDerivable(resolved)
    } catch { ctxLen = 0 }
    /*
     * GH #129: aus einer GERATENEN Zahl wird kein Budget.
     *
     * Der Melder betreibt einen eigenen Server mit einem 256k-Modell. Weil
     * weder Katalog noch Abfrage etwas lieferten, riet die Namensheuristik
     * 8192 (nach dem Umbenennen auf "qwen" dann 32768), und diese Zahl ging
     * als `max_tokens` auf die Leitung. Sein Server antwortete mit "token
     * limit exceeded": wir hatten ihm ein Budget genannt, das niemand
     * gemessen hatte.
     *
     * Ein ausdruecklicher Wunsch des Nutzers geht weiterhin raus, der gehoert
     * ihm. Ohne einen solchen bleibt das Feld WEG, und der Server nimmt seine
     * eigene Voreinstellung. Das ist die einzige Antwort, die nicht raet.
     * Fuer den LU-Motor, Ollama und LM Studio aendert sich nichts: deren
     * Fenster ist gemessen, also bleibt die Rechnung unten.
     */
    if (!derivable || ctxLen <= 0) {
      // Runde 3 klein 1 (bau/wfprogress.md): a caller's own FALLBACK default
      // (workflow-engine.ts's DEFAULT_PROMPT_STEP_MAX_TOKENS, sent when the
      // user set nothing) is not the "ausdruecklicher Wunsch des Nutzers"
      // this branch exists to trust; only a real one still passes through
      // unclamped here, same as before this field existed.
      if (requested > 0 && !options?.maxTokensIsDefault) body.max_tokens = requested
      else delete body.max_tokens
      return
    }
    const RESERVE = 512
    // Audit CS-1: count the text WITHOUT the base64 image payloads and charge
    // a flat per-image rate instead, see IMAGE_TOKEN_ESTIMATE. Counting the
    // data URLs as text made one screenshot look like ~34k tokens and starved
    // max_tokens down to the 256 floor on every model with a small window.
    const msgPayload = measurePayload(body.messages || '')
    const toolPayload = measurePayload(body.tools || '')
    const promptTokens =
      msgPayload.tokens + toolPayload.tokens + (msgPayload.images + toolPayload.images) * IMAGE_TOKEN_ESTIMATE
    const headroom = Math.max(256, ctxLen - promptTokens - RESERVE)
    // Audit E6: an UNSET budget used to send the whole remaining window as
    // max_tokens, six figures on a 128k model. Servers that validate
    // max_tokens against the model's real OUTPUT limit reject that outright.
    // 32k is beyond any single reply this app produces; an explicit user
    // request still passes through un-capped (their server, their call).
    body.max_tokens = requested > 0 ? Math.min(requested, headroom) : Math.min(headroom, 32768)
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    messages = await resolveMessageAttachments(messages)
    const body: OpenAIChatRequest = {
      model,
      // Bug B3: one system message, first. The built-in engine and LM Studio
      // render the model's own Jinja template, which raises "System message
      // must be at the beginning" on anything else and kills the whole turn
      // before a byte streams. See providers/normalize-system.ts.
      messages: this.templateContract(messages, (options?.tools?.length ?? 0) > 0).map(m => this.toOpenAIMessage(m)),
      stream: true,
    }

    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    // A33: above temperature 1 the tail is held back, or the answer is noise.
    const heldTopP = topPForTemperature(body.temperature, body.top_p)
    if (heldTopP !== undefined) body.top_p = heldTopP
    // F3: temperature and top_p reached the request, top_k never did,
    // the sampling popup's slider promised an effect that never happened.
    // LU Cloud is excluded on purpose: its proxy protocol genuinely has no
    // such field (sampling-reaches-the-cloud-body.test.ts), unlike a real
    // self-hosted llama.cpp/vLLM/KoboldCpp/LM-Studio/built-in-engine server.
    if (options?.topK !== undefined && this.config.id !== 'lu-cloud') body.top_k = options.topK
    // GH #175: the extra samplers, under the names this backend reads. A
    // server on this machine or the LAN counts as local whether its preset
    // said so or only its address does, an additional entry (#173) included.
    if (options) Object.assign(body, openAiSamplerFields(this.samplerTarget, options))
    this.applyCustomParams(body, options)
    // Streaming tool turn: same wire shape as chatWithTools, but the calls
    // come back as deltas which the accumulator below already merges.
    if (options?.tools?.length) {
      body.tools = options.tools
      body.tool_choice = 'auto'
    }
    await this.applyMaxTokens(model, body, options)
    // Reasoning-model knob (o1, o3, gpt-5-thinking, etc.). Toggle ON → "high",
    // toggle OFF → "none". Non-reasoning models simply ignore the field; an
    // endpoint that rejects it is handled by the ladder in sendChat.
    const effort = this.thinkingEffort(model, options?.thinking, options)
    if (effort) body.reasoning_effort = effort
    // The knob a template-rendering backend actually reads. See
    // templateThinkingKwargs for the counter-check that reasoning_effort
    // alone leaves the built-in engine's Think button doing nothing.
    const tmplKwargs = this.templateThinkingKwargs(options?.thinking)
    if (tmplKwargs) body.chat_template_kwargs = tmplKwargs
    this.applyThinkBudget(body, options)
    await this.applyLocalEffortForm(body, model, options)
    // Round 10, phone only: the caller ends the messages with a cut answer
    // and the engine of the phone goes on inside it. Absent on every other send.
    if (options?.continueFinalMessage) body.continue_final_message = true
    // Ask the server for REAL token usage in a final stream chunk
    // (choices:[] + usage:{...}). OpenAI, LU Cloud, Groq, vLLM and
    // LM Studio all honor stream_options; an endpoint that rejects unknown
    // params 400/422s and the retry below drops it. Real usage is what keeps
    // the TokenCounter honest, a char/4 estimate can't see the system prompt.
    body.stream_options = { include_usage: true }

    // Managed built-in engine: Create/Music renders stop the llama-server
    // child to free VRAM ("reloads lazily on the next message"), this is that
    // lazy reload. Restart-before-send instead of letting the fetch hit a dead
    // 127.0.0.1:8127 and look like a crashed backend.
    // A Create render may have moved this backend's model out (vram-handoff).
    if (this.isLanBackend) await chatBackendsBack()
    if (this.config.managed === true) await ensureBuiltinEngineAlive(model)

    if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher = this.useLocalProxy ? localFetchStream : fetch
    // Zeitbombe 4, the idle watchdog needs a controller to abort, and a
    // provider only ever receives a signal. This chains one onto the caller's:
    // Stop still propagates inward, and a stream that goes silent can cancel
    // its own request instead of leaving reader.read() pending forever.
    const guard = idleAbortGuard(options?.signal)
    const repetitionStop = this.config.managed === true ? new RepetitionStop() : undefined
    const reasoningRepetitionStop = this.config.managed === true ? new RepetitionStop() : undefined
    // A phone runs models small enough to fall into a loop inside one answer (lib/repetition-stop.ts, LoopStop).
    // Only there: the desktop engine keeps exactly the rule it had.
    const watchLoops = this.config.managed === true && singleModelSlot()
    const loopStop = watchLoops ? new LoopStop() : undefined
    const reasoningLoopStop = watchLoops ? new LoopStop() : undefined
    let res: Response
    try {
      res = await this.sendChat(model, body, guard.signal, fetcher)
      if (!res.ok) throw await this.parseError(res)
    } catch (err) {
      // Nothing to watch, drop the listener on the caller's signal here, the
      // stream loop's `finally` below is never reached on this path.
      guard.release()
      throw err
    }

    // Accumulate tool call arguments across chunks (OpenAI streams them in pieces)
    const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map()
    let promptTokens = 0
    let completionTokens = 0
    let finishReason: string | undefined
    const billing = chatBilling(res)
    const doneChunk = (fallbackReason: string): ChatStreamChunk => {
      const toolCalls = this.flushToolCalls(toolCallAccum)
      return {
        content: '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
        done: true,
        finishReason: finishReason ?? fallbackReason,
        promptEvalCount: promptTokens || undefined,
        evalCount: completionTokens || undefined,
        billing,
      }
    }

    try {
      // Issue 177: a local backend may read a long prompt for many minutes
      // before its first byte, so that wait follows the setting (0 = Off).
      // Cloud endpoints keep the fixed first chunk budget of stream-idle.ts.
      const firstChunkMs = this.isLanBackend ? chatFirstReplyMs(useSettingsStore.getState().settings) : undefined
      for await (const event of parseSSEStream(res, { onIdle: guard.abort, firstChunkMs })) {
        if (event.data === '[DONE]') {
          yield doneChunk('stop')
          return
        }

        let raw: unknown
        try {
          raw = JSON.parse(event.data)
        } catch {
          continue
        }
        // Boundary: from here on every field has been checked, not asserted.
        const chunk = parseOpenAIStreamChunk(raw)

        // LM Studio (and some OpenAI-compat servers) report a mid-stream failure
        // as a 200 response carrying an SSE error chunk ({ error: { message } } or
        // a bare { error: "..." }) instead of a non-2xx status, so the !res.ok
        // guard above never fires. Such a chunk has no `choices`, so the old loop
        // just skipped it → the user got a SILENT EMPTY reply. Surface it as a
        // thrown error so the chat layer can map it to a friendly message (e.g.
        // the #67 image-on-text-model case). Verified live: LM Studio + image on a
        // text-only model returns `event: error` with HTTP 200 (2026-06-21).
        const streamErr = chunk.error
        if (streamErr) {
          // The server's code travels with the error, so the retry ladder can
          // tell a step it must not repeat (LU Cloud `stalled_runaway`: ten
          // minutes of output nobody saw) from a dropped line.
          const serverCode = typeof streamErr === 'string' ? undefined : asString(prop(streamErr, 'code')) || undefined
          throw new ProviderError(
            typeof streamErr === 'string'
              ? streamErr
              : withContextNumbers(asString(prop(streamErr, 'message')) || 'Streaming error', streamErr),
            'openai',
            serverCode,
          )
        }

        // Real token usage, the include_usage final chunk carries `usage` with
        // an empty choices[], so capture it BEFORE the choice guard below.
        const u = chunk.usage
        if (u) {
          promptTokens = u.prompt_tokens || promptTokens
          completionTokens = u.completion_tokens || completionTokens
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        // Capture WHY the model stopped ('stop', 'length', 'content_filter').
        // 'length' with zero content is the reasoning-loop failure mode: the
        // whole token budget went into thinking and no answer was ever written
        // (the owner, cloud Qwen3.6, 2026-07-12), the chat layer needs the reason
        // to explain the empty bubble.
        if (choice.finish_reason) finishReason = choice.finish_reason

        const content = choice.delta?.content || ''

        // Yield native reasoning as `thinking` so the panel fills live,
        // without this the entire reasoning phase of a cloud reasoner is
        // silently dropped and the chat sits in dead air (the web app).
        const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? ''
        if (repetitionStop?.push(content) || reasoningRepetitionStop?.push(reasoning)) {
          guard.abort()
          throw new Error(platformText('repeatedQuestionMarks'))
        }
        if (loopStop?.push(content) || reasoningLoopStop?.push(reasoning)) {
          guard.abort()
          throw new Error(MOBILE_TEXT.repeatedOutput)
        }
        if (reasoning) {
          yield { content: '', thinking: reasoning, done: false }
        }

        // Accumulate streamed tool calls
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const key = tc.index ?? keyForUnindexedBlock(toolCallAccum, tc.id)
            const existing = toolCallAccum.get(key)
            if (existing) {
              // id and name do NOT always arrive in the first delta, several
              // OpenAI-compat servers send the id one chunk later, or open with a
              // bare index. Ignoring them left a call with an empty name (dispatch
              // fails on "") or an empty tool_call_id, which 422s the follow-up
              // turn, the exact break the server-side normalizer had to heal.
              // Set-if-empty, not append: servers that repeat the full name in
              // every delta are far more common than ones that stream it in parts.
              if (tc.id && !existing.id) existing.id = tc.id
              if (tc.function?.name && !existing.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.args += tc.function.arguments
            } else {
              toolCallAccum.set(key, {
                id: tc.id || '',
                name: tc.function?.name || '',
                args: tc.function?.arguments || '',
              })
            }
            const call = toolCallAccum.get(key)
            if (call?.name) yield { content: '', toolProgress: { name: call.name, argsChars: call.args.length }, done: false }
          }
        }

        if (content) {
          yield { content, done: false }
        }

        // NB: we intentionally do NOT early-return on finish_reason. With
        // stream_options.include_usage the server sends the usage chunk AFTER
        // the finish_reason chunk, returning early would discard it. The [DONE]
        // sentinel (or the end-of-stream fallback below) emits the single done
        // chunk, which now carries the captured usage.
      }
    } catch (err) {
      // The watchdog fired: the stream did not fail, it went quiet. Same
      // terminal chunk as a clean cut, so the chat layer explains it the same
      // way instead of throwing a raw error at the user.
      if (isStreamIdleTimeout(err)) {
        // The only trace a silent cut leaves: the chat shows "disconnected",
        // the support log says which watchdog and after how long.
        log.warn('provider.stream_idle_timeout', { provider: this.config.id, idleMs: err.idleMs })
        yield doneChunk('disconnect')
        return
      }
      throw err
    } finally {
      guard.release()
    }

    // Stream ended without an explicit [DONE] sentinel. If the server also
    // never sent a finish_reason, the connection was cut mid-generation
    // (proxy idle-timeout, upstream drop), a clean FIN ends parseSSEStream
    // without any error, which used to masquerade as a normal completion and
    // leave the user a silent empty bubble. Tag it 'disconnect' so the chat
    // layer can say so.
    yield doneChunk('disconnect')
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number; thinking?: string; billing?: ChatBilling }> {
    messages = await resolveMessageAttachments(messages)
    const body: OpenAIChatRequest = {
      model,
      // Bug B3: same invariant as chatStream, see providers/normalize-system.ts.
      messages: this.templateContract(messages, tools.length > 0).map(m => this.toOpenAIMessage(m)),
      stream: false,
    }

    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    // A33: above temperature 1 the tail is held back, or the answer is noise.
    const heldTopP = topPForTemperature(body.temperature, body.top_p)
    if (heldTopP !== undefined) body.top_p = heldTopP
    // F3: temperature and top_p reached the request, top_k never did,
    // the sampling popup's slider promised an effect that never happened.
    // LU Cloud is excluded on purpose: its proxy protocol genuinely has no
    // such field (sampling-reaches-the-cloud-body.test.ts), unlike a real
    // self-hosted llama.cpp/vLLM/KoboldCpp/LM-Studio/built-in-engine server.
    if (options?.topK !== undefined && this.config.id !== 'lu-cloud') body.top_k = options.topK
    // GH #175: the extra samplers, under the names this backend reads.
    if (options) Object.assign(body, openAiSamplerFields(this.samplerTarget, options))
    this.applyCustomParams(body, options)
    await this.applyMaxTokens(model, body, options)
    // Same reasoning_effort gate as chatStream.
    const effort = this.thinkingEffort(model, options?.thinking, options)
    if (effort) body.reasoning_effort = effort
    // Same template-kwargs gate as chatStream.
    const tmplKwargs = this.templateThinkingKwargs(options?.thinking)
    if (tmplKwargs) body.chat_template_kwargs = tmplKwargs
    this.applyThinkBudget(body, options)
    await this.applyLocalEffortForm(body, model, options)
    if (options?.jsonSchema && this.config.id !== 'lu-cloud') {
      body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: options.jsonSchema } }
    }

    // Same self-heal as chatStream: agent/tool turns after a Create render
    // must revive the offloaded built-in engine before hitting its port.
    // A Create render may have moved this backend's model out (vram-handoff).
    if (this.isLanBackend) await chatBackendsBack()
    if (this.config.managed === true) await ensureBuiltinEngineAlive(model)

    if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher = this.useLocalProxy ? localFetch : fetch
    const res = await this.sendChat(model, body, options?.signal, fetcher)

    if (!res.ok) {
      throw await this.parseError(res, tools.length > 0)
    }

    // Boundary: the body is foreign, so it goes through the checked parser
    // rather than an `as OpenAIResponse` that would break on the first
    // tool-call the server sends without a `function` object.
    const data = parseOpenAIChatResponse(await res.json())
    const message = data.message

    const toolCalls: ToolCall[] = (message?.tool_calls || []).map(tc => ({
      id: tc.id,
      function: {
        name: tc.function?.name ?? '',
        arguments: this.safeParseArgs(tc.function?.arguments ?? ''),
      },
    }))

    // Real consumed-context usage (non-streaming response carries it directly).
    const usage = data.usage
    return {
      content: message?.content || '',
      toolCalls,
      promptEvalCount: usage?.prompt_tokens,
      evalCount: usage?.completion_tokens,
      thinking: message?.reasoning_content || message?.reasoning || undefined,
      billing: chatBilling(res),
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const listed = await this.listedModels()
    // GitHub #112: ids this endpoint serves without listing them.
    const extra = useSettingsStore.getState().settings.extraModelIds?.[endpointKey(this.baseUrl)] ?? []
    const rows = withExtraModels(listed, extra, (id) => ({
      id,
      name: id,
      provider: 'openai' as const,
      providerName: this.config.name,
      contextLength: KNOWN_CONTEXT[id] ?? guessContextFromName(id),
      supportsTools: true,
    }))
    // GitHub #173: every row of an additional entry names that entry, so its
    // picker id routes back here and not to the original slot.
    const entryId = this.config.entryId
    return entryId ? rows.map((m) => ({ ...m, entryId })) : rows
  }

  private async listedModels(): Promise<ProviderModel[]> {
    if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher = this.useLocalProxy ? localFetch : fetch
    const res = await fetcher(`${this.baseUrl}/models`, {
      headers: this.headers,
    })

    if (!res.ok) {
      throw await this.parseError(res)
    }

    const body: unknown = await res.json()
    // Both spellings are in the wild (`data` in the OpenAI spec, `models` on
    // some compat servers); anything that is not an array of objects yields
    // an empty catalogue instead of blowing up the model picker.
    const rawList = prop(body, 'data') ?? prop(body, 'models')
    const models: OpenAIModelEntry[] = asRecordArray(rawList).map(toModelEntry)

    // Bug K: fuer lokale Backends (LM Studio etc.) probe das wahre
    // Context-Limit vom Server. Sonst zeigen wir 8K obwohl das Modell 32K+
    // kann. Probes laufen parallel; bei Cloud-Providers (OpenAI/OpenRouter)
    // wuerde N+1 zu Rate-Limits fuehren, deshalb nur KNOWN_CONTEXT/Heuristik.
    if (this.isLanBackend) {
      // G32 (R20-Mac, 2026-08-07): the standard /v1/models listing says
      // nothing about tools, so `?? true` declared every LM Studio model
      // tool-capable and the layered resolution downstream had nothing to
      // downgrade on, a tool-less model got a native `tools` payload. LM
      // Studio's enhanced listing answers it per model in `capabilities`
      // (['tool_use', ...]); one fetch covers all models. Backends without
      // the enhanced API leave the map empty → optimistic as before.
      const { lanCaps, serverTools } = await this.liveToolCaps()
      return Promise.all(models.map(async m => {
        // A catalogue answer is a catalogue answer wherever the server sits.
        // This branch used to keep ONLY the id and the tool flag, which was
        // fine while "LAN" meant LM Studio and llama.cpp, and wrong the moment
        // LU Cloud ran on localhost:3000: every model arrived with the raw id
        // for a name, no think mode (so the Think button rendered grey on a
        // model that always reasons), no vision flag and no effort ladder (so
        // the composer drew no effort control at all). Measured on the 2.6.8
        // Mac bundle, 2026-09-02.
        this.rememberCatalog(m)
        // Issue 176: a local server declares no rungs in /v1/models, so they
        // are read from where that server keeps them (lib/local-effort.ts).
        const localEffort = m.reasoning_effort_levels || this.config.id === 'lu-cloud'
          ? undefined
          : await this.localEffortFor(m.id)
        return {
          id: m.id,
          name: m.native_name ?? m.name ?? m.id,
          catalogName: catalogNameOf(m),
          provider: 'openai' as const,
          providerName: this.config.name,
          // The declared window comes BEFORE the probe: a server that already
          // answered the question in its listing must not be asked again per
          // model. That probe is what fired a GET /models/<id> at LU Cloud for
          // every entry, collected a 404 each time, and stretched one listing
          // to between eight and twenty-one seconds.
          contextLength:
            KNOWN_CONTEXT[m.id] ??
            (m.context_length && m.context_length > 0 ? m.context_length : undefined) ??
            (await this.probeContextFromServer(m.id)) ??
            guessContextFromName(m.id),
          supportsTools: lanCaps.has(m.id)
            ? lanCaps.get(m.id)!.includes('tool_use')
            : (serverTools ?? m.supports_tools ?? true),
          supportsVision: m.input_modalities?.includes('image') || undefined,
          createInChat: m.create_in_chat,
          limitedCapacity: m.limited_capacity === true ? true : undefined,
          thinkMode: m.think,
          flash: this.config.apiKey?.startsWith('lu_') ? undefined : parseFlashPolicy(m.flash, m.usage_class, this.catalogKey(m.id)),
          unfiltered: asUnfiltered(m.unfiltered),
          unrestricted: m.unrestricted === true ? true : undefined,
          effortLevels: m.reasoning_effort_levels ?? localEffort?.levels,
          effortDefault: m.reasoning_effort_default,
          effortNote: m.reasoning_effort_levels ? undefined : localEffort?.note,
          effortLocal: !m.reasoning_effort_levels && localEffort?.levels ? true : undefined,
          declaredContext: declaredContextOf(m),
          creditRates: m.credit_rates,
        }
      }))
    }

    return models.map(m => {
      // Remember the server-declared window for applyMaxTokens (see
      // catalogContext). Server value beats every heuristic, it reflects
      // what THIS deployment actually serves.
      this.rememberCatalog(m)
      return {
        id: m.id,
        name: m.native_name ?? m.name ?? m.id,
        catalogName: catalogNameOf(m),
        provider: 'openai' as const,
        providerName: this.config.name,
        contextLength: m.context_length ?? KNOWN_CONTEXT[m.id] ?? guessContextFromName(m.id),
        // Server-authoritative tool capability. `false` for the cloud chat
        // models that can't do function calling → the whole chain (Agent
        // toggle, dropdown icon, Code mode) gates them without a failed run.
        // Fallback `true` keeps older deployments (no field) optimistic.
        supportsTools: m.supports_tools ?? true,
        supportsVision: m.input_modalities?.includes('image') || undefined,
        createInChat: m.create_in_chat,
        limitedCapacity: m.limited_capacity === true ? true : undefined,
        thinkMode: m.think,
        flash: this.config.apiKey?.startsWith('lu_') ? undefined : parseFlashPolicy(m.flash, m.usage_class, this.catalogKey(m.id)),
        unfiltered: asUnfiltered(m.unfiltered),
          unrestricted: m.unrestricted === true ? true : undefined,
        // Straight through, no invention: a server that does not declare the
        // ladder leaves both undefined, and undefined is what switches the
        // whole effort feature off for this model.
        effortLevels: m.reasoning_effort_levels,
        effortDefault: m.reasoning_effort_default,
        declaredContext: declaredContextOf(m),
        creditRates: m.credit_rates,
      }
    })
  }

  async checkConnection(): Promise<boolean> {
    try {
      if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
      const fetcher = this.useLocalProxy ? localFetch : fetch
      const res = await fetcher(`${this.baseUrl}/models`, {
        headers: this.headers,
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Bug K, dynamische Context-Window-Detection fuer lokale OpenAI-compat
   * Backends. LM Studio 0.3+ liefert die wahren Werte via Enhanced-API:
   *   GET /api/v0/models/<id>  ->  { max_context_length, loaded_context_length, ... }
   * Generische OpenAI-compat Server (vLLM, llama.cpp server, Aphrodite, SGLang,
   * TabbyAPI, ...) liefern es oft im Standard-/v1/models/<id> response unter
   * verschiedenen Keys: context_window | max_model_len | context_length, und
   * daneben mit `n_ctx_train` die trainierte Decke.
   *
   * Gefragt wird nach dem LAUFENDEN Fenster, nicht nach dem Koennen des
   * Modells. Bug K liess es umgekehrt lesen (`max_context_length` vor
   * `loaded_context_length`), damit im Modellwaehler nicht "8K" stand, wo ein
   * 128k-Modell nur klein geladen war. Die Zahl aus dieser Kaskade ist aber
   * auch die, aus der `applyMaxTokens` das Budget rechnet, und LM Studio
   * schneidet jeden Prompt ueber dem geladenen Wert hart ab. Das Koennen des
   * Modells steht seit dem 11.09.2026 daneben (`trained`) und deckelt die
   * Auswahlliste im Waehler; angezeigt und verrechnet wird das Fenster.
   *
   * Returnt `null` wenn nichts gefunden, damit Callers cascaden koennen.
   */
  private async probeContextFromServer(model: string, signal?: AbortSignal): Promise<number | null> {
    const probed = await this.probeWindow(model, signal)
    return probed.window ?? probed.trained
  }

  /** Eine Metadaten-Abfrage, die nie wirft: ein toter Endpunkt ist eine
   *  Antwort wie jede andere (naemlich keine). */
  private async probeJson(url: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const res = await localFetch(url, this.probeInit(signal))
      if (!res.ok) return undefined
      return await res.json()
    } catch {
      return undefined
    }
  }

  /**
   * Die Kaskade selbst, mit der trainierten Decke daneben (GH #129).
   *
   * Reihenfolge und Grund:
   *   1. LM Studio `/api/v0/models/<id>`  ist die genaueste Auskunft, die es
   *      hier gibt: `loaded_context_length` ist das laufende Fenster.
   *   2. `/v1/models/<id>`                vLLM, Aphrodite, SGLang, TabbyAPI.
   *   3. `/props`                         llama.cpp. Die Zahl dort ist das
   *      WIRKLICH geladene Fenster; ein Prompt darueber stirbt serverseitig.
   *   4. `/v1/models` (Liste)             vLLM `max_model_len`, llama.cpp
   *      `meta.n_ctx`. Ein Server mit genau einem Modell darf dabei
   *      seinen eigenen Namen verwenden, siehe parseModelsListContext.
   *   5. `/api/extra/true_max_context_length`  KoboldCpp.
   *
   * Eine Stufe steigt NUR aus, wenn sie ein laufendes Fenster gefunden hat.
   * Eine Decke (LM Studios `max_context_length`, llama.cpps `n_ctx_train`)
   * beendet die Suche nicht, sie wird mitgenommen: gemessen auf der Box am
   * 11.09.2026 hat ein llama-server auf `--ctx-size 16384` die Decke 40960
   * gemeldet, und wer hier ausgestiegen waere, haette 40960 angezeigt und ein
   * `max_tokens` von 32768 auf die Leitung gelegt, das Doppelte des ganzen
   * Fensters.
   *
   * Alle Wege haengen an `serverRoot`, also funktionieren sie auch fuer eine
   * Basis-URL OHNE `/v1` (llama-server startet in seiner eigenen Anleitung auf
   * http://localhost:8080). Vorher war das der Fall, in dem gar nicht gefragt
   * wurde. LAN-Regel unveraendert: ein fremder Host im Internet bekommt keine
   * einzige dieser Anfragen.
   */
  private async probeWindow(model: string, signal?: AbortSignal): Promise<ProbedContext> {
    if (!this.isLanBackend) return { window: null, trained: null }

    // Probe cache (audit E5): applyMaxTokens calls getContextLength on EVERY
    // request, and a LAN backend without a catalog entry paid one or two HTTP
    // probes per agent iteration. A loaded model's window does not move
    // between iterations; 5 minutes covers an LM Studio reload with changed
    // settings. Negative answers cache too, because a server that has no
    // context endpoint will not grow one mid-run.
    const cacheKey = `${this.baseUrl}|${model}`
    const hit = OpenAIProvider.probeCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 300_000) {
      return { window: hit.ctx, trained: hit.max ?? null }
    }
    const remember = (window: number | null, trained: number | null): ProbedContext => {
      OpenAIProvider.probeCache.set(cacheKey, { at: Date.now(), ctx: window, max: trained })
      return { window, trained }
    }

    const root = serverRoot(this.baseUrl)
    const v1 = v1Root(this.baseUrl)
    const id = encodeURIComponent(model)
    /** Die hoechste Decke, die bis hierher jemand genannt hat. */
    let ceiling: number | null = null
    const under = (n: number | null) => Math.max(ceiling ?? 0, n ?? 0) || null

    // Die eingebaute Engine ist ein llama-server, den die App selbst startet.
    // Zwei Dinge folgen daraus (Befund vom ersten Geraetestart, r2/rust.md 3.2):
    //   a) Solange sie nicht laeuft, gibt es niemanden zu fragen. Jede Anfrage
    //      waere ein abgelehnter Verbindungsaufbau und eine Fehlerzeile in der
    //      Konsole. Die leere Antwort wird NICHT abgelegt, damit die naechste
    //      Frage nach dem Start die echte Zahl holt.
    //   b) LM Studios und KoboldCpps Pfade und `/v1/models/<id>` kennt sie nie.
    //      Gefragt wird `/props` (das geladene Fenster) und, wenn das nichts
    //      sagt, die Modellliste (`meta.n_ctx`), beides llama.cpp.
    if (this.config.managed === true) {
      if ((await builtinEngineRunning()) === false) return { window: null, trained: null }
      const ownProps = parseLlamaCppProps(await this.serverFact('props', `${root}/props`, signal))
      if (ownProps) return remember(ownProps, ceiling)
      const ownList = parseModelsListContext(await this.serverFact('models', `${v1}/models`, signal), model)
      ceiling = under(ownList.trained)
      return remember(ownList.window ?? null, ceiling)
    }

    const lms = parseLmStudioModel(await this.probeJson(`${root}/api/v0/models/${id}`, signal))
    ceiling = under(lms.max)
    if (lms.loaded) return remember(lms.loaded, ceiling)

    const generic = parseModelRowContext(await this.probeJson(`${v1}/models/${id}`, signal))
    ceiling = under(generic.trained)
    if (generic.window) return remember(generic.window, ceiling)

    const props = parseLlamaCppProps(await this.serverFact('props', `${root}/props`, signal))
    if (props) return remember(props, ceiling)

    const list = parseModelsListContext(
      await this.serverFact('models', `${v1}/models`, signal),
      model,
    )
    ceiling = under(list.trained)
    if (list.window) return remember(list.window, ceiling)

    const kobold = parseKoboldMaxContext(
      await this.serverFact('kobold', `${root}/api/extra/true_max_context_length`, signal),
    )
    if (kobold) return remember(kobold, ceiling)

    return remember(null, ceiling)
  }

  /**
   * Eine Auskunft ueber den SERVER, hoechstens einmal je Endpunkt und
   * Fuenfminutenfenster.
   *
   * `/props`, die Modellliste und KoboldCpps Endpunkt beschreiben die
   * Maschine, nicht ein Modell. Ohne diese Ablage haette eine Modellliste mit
   * zwanzig Eintraegen zwanzig Mal dasselbe `/props` geholt, und genau diese
   * N-plus-1-Rechnung hat die Auflistung an LU Cloud schon einmal auf
   * einundzwanzig Sekunden gedehnt. Das `/props` teilt sich die Ablage mit der
   * Werkzeugfrage aus G37: dieselbe Antwort, zwei Leser, eine Anfrage.
   */
  private async serverFact(
    kind: ServerFactKind,
    url: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const now = Date.now()
    let entry = OpenAIProvider.serverFacts.get(this.baseUrl)
    if (!entry || now - entry.at >= 300_000) {
      entry = { at: now, asked: {} }
      OpenAIProvider.serverFacts.set(this.baseUrl, entry)
    }
    // Gespeichert wird das VERSPRECHEN, nicht die Antwort. `listModels` faehrt
    // alle Modelle mit Promise.all parallel, und wer erst nach dem Warten
    // ablegt, hat zwanzig gleichzeitige Anfragen auf dieselbe URL, bevor die
    // erste zurueck ist. Gemessen an dieser Stelle: drei Modelle, drei
    // /props. `probeJson` wirft nie, also ist ein abgelegtes Versprechen
    // gefahrlos.
    if (!(kind in entry.asked)) entry.asked[kind] = this.probeJson(url, signal)
    return await entry.asked[kind]
  }

  /** Server-weite Metadaten je Endpunkt (GH #129), siehe `serverFact`. */
  private static serverFacts = new Map<
    string,
    { at: number; asked: Partial<Record<ServerFactKind, Promise<unknown>>> }
  >()

  /**
   * G32: per-model tool capability from LM Studio's enhanced listing
   * (/api/v0/models). Only entries that carry a `capabilities` array land in
   * the map, a generic OpenAI-compat backend (vLLM, llama.cpp server) 404s
   * or answers without the field, and an absent entry means "nobody said",
   * which keeps the optimistic default. LAN only, same rule as the context
   * probe: a cloud endpoint must not get an extra request per listing.
   */
  private async fetchLanCapabilities(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    const enhancedBase = this.baseUrl.replace(/\/v1\/?$/, '/api/v0')
    if (enhancedBase === this.baseUrl) return map
    try {
      const res = await localFetch(`${enhancedBase}/models`, this.probeInit())
      if (!res.ok) return map
      const data = await res.json()
      for (const m of (data?.data ?? [])) {
        if (m?.id && Array.isArray(m.capabilities)) map.set(m.id, m.capabilities)
      }
    } catch { /* no enhanced API on this backend */ }
    return map
  }

  /**
   * G37 (R21c wire proof, 2026-08-07): llama.cpp's own answer, one flag for
   * the whole server. The bundled engine's /props reports
   * chat_template_caps.supports_tools: false because the GGUF ships a minimal
   * template, and a native `tools` payload is then accepted but IGNORED, no
   * refusal to learn from, the model just never sees a tool contract. false
   * means every model here needs the prompt transport; true means native is
   * fine; a 404 or a props answer without the field means nobody said, and
   * the optimistic default stands (vLLM and friends are untouched).
   */
  private async fetchServerToolCaps(): Promise<boolean | undefined> {
    // GH #129: dasselbe `/props`, das die Kontextabfrage liest, aus derselben
    // Ablage. Vorher holten die beiden Fragen die Antwort getrennt.
    const data = await this.serverFact('props', `${serverRoot(this.baseUrl)}/props`)
    const flag = prop(prop(data, 'chat_template_caps'), 'supports_tools')
    return typeof flag === 'boolean' ? flag : undefined
  }

  /** Probe results per endpoint+model (audit E5). Static, not an instance
   *  field: the lu-cloud provider builds a fresh delegate per call. `max` ist
   *  die trainierte Decke, wenn der Server sie mitgeliefert hat (GH #129). */
  private static probeCache = new Map<
    string,
    { at: number; ctx: number | null; max?: number | null }
  >()

  /**
   * How far the thinking knob had to be walked down for an endpoint and model,
   * keyed like probeCache. Absent means nothing has been refused here yet, so
   * a new endpoint always gets the value that actually disables thinking.
   * Only a successful request writes to this (see sendChat).
   *
   * Split by direction on purpose. An endpoint with the o1-era vocabulary
   * (low, medium, high) refuses both 'none' and 'minimal' while accepting
   * 'high' happily, so what we learn with the switch OFF says nothing about
   * the switch ON. One shared entry made a single OFF message silence the
   * user's thinking switch for the rest of the session.
   */
  // Keyed by effortKey(): one entry per model for the OFF lane, one per model
  // AND rung for the ON lane. The only thing either lane can learn is 'omit',
  // plus 'minimal' as the OFF lane's one intermediate step.
  private static effortMemory = new Map<string, { on?: 'omit'; off?: 'minimal' | 'omit' }>()

  /**
   * Endpoints that refused `chat_template_kwargs`. Keyed by base URL, not by
   * model: it is the SERVER that either forwards template kwargs or does not,
   * and llama-server does it for every model it ever loads. Remembered so a
   * backend that dislikes the field pays one extra round trip once instead of
   * one on every message.
   */
  private static templateKwargsRefused = new Set<string>()

  /** Live tool-capability answers per endpoint (G37b). Static for the same
   *  reason as probeCache, and TTL-bound like it: an LM Studio reload or an
   *  engine swap with a different template lands within 5 minutes. */
  private static toolCapsCache = new Map<string, { at: number; lanCaps: Map<string, string[]>; serverTools: boolean | undefined }>()

  /**
   * G37 (R21c, 2026-08-07): llama.cpp answers the tool question on /props,
   * server-wide. The bundled engine loads the GGUF's template WITHOUT tool
   * support and then silently ignores a native `tools` payload, the model
   * never sees a tool contract and invents results for every step. /props is
   * only asked when the enhanced listing said nothing.
   */
  private async liveToolCaps(): Promise<{ lanCaps: Map<string, string[]>; serverTools: boolean | undefined }> {
    const hit = OpenAIProvider.toolCapsCache.get(this.baseUrl)
    if (hit && Date.now() - hit.at < 300_000) return hit
    const lanCaps = await this.fetchLanCapabilities()
    const serverTools = lanCaps.size === 0 ? await this.fetchServerToolCaps() : undefined
    const entry = { at: Date.now(), lanCaps, serverTools }
    OpenAIProvider.toolCapsCache.set(this.baseUrl, entry)
    return entry
  }

  /**
   * G37b (R21d wire proof, 2026-08-08): the send-time answer to "can this
   * server drive native tools". The listing-time probe (G37) never runs for
   * the bundled engine, because useModels skips listModels for the managed
   * built-in backend and builds the picker rows from the downloaded GGUFs
   * instead, so the run still put a native `tools` payload on 8127 and the
   * model narrated fiction. The strategy resolution calls this directly
   * before each run: `false` means the prompt transport must carry the
   * contract, `true` means native is fine, `undefined` means nobody said
   * (vLLM and friends stay optimistic). Cloud endpoints never pay a request.
   */
  async serverToolSupport(model: string): Promise<boolean | undefined> {
    if (!this.isLanBackend) return undefined
    const { lanCaps, serverTools } = await this.liveToolCaps()
    if (lanCaps.has(model)) return lanCaps.get(model)!.includes('tool_use')
    return serverTools
  }

  /**
   * R19 (LM Studio, 2026-08-07): what the server actually ALLOCATED for this
   * model. LM Studio JIT-loads at its configured default, often far below the
   * model's maximum, and hard-truncates any prompt beyond it, a run budgeted
   * against max_context_length loses the middle of its own prompt, tool
   * contract included, and dies without a usable error. The run budget clamps
   * to this; the DISPLAY value deliberately keeps preferring the maximum
   * (Bug K), because that is what the model could do.
   */
  async loadedContextLength(model: string): Promise<number | null> {
    if (!this.isLanBackend) return null
    // Managed built-in engine (Z36 finding 2): llama-server has no LM Studio
    // enhanced API, so this probe used to return null and the run budget fell
    // back to catalog/name heuristics, happily budgeting 32k against an
    // engine started with 8192. The engine status carries the true started
    // ctx; use it, uncached, because ensureBuiltinAgentCtx may have JUST
    // swapped the engine bigger and a 5-minute-old value would clamp wrong
    // (or, after a render offload restart, fail to clamp at all).
    if (isManagedBuiltinSlot()) {
      try {
        const s = await backendCall<{ running?: boolean; ctx?: number | null }>('bundled_engine_status')
        if (s?.running && typeof s.ctx === 'number' && s.ctx > 0) return s.ctx
      } catch { /* non-Tauri context, fall through to the LM Studio probe */ }
      return null
    }
    const cacheKey = `loaded|${this.baseUrl}|${model}`
    const hit = OpenAIProvider.probeCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 300_000) return hit.ctx
    const remember = (ctx: number | null): number | null => {
      OpenAIProvider.probeCache.set(cacheKey, { at: Date.now(), ctx })
      return ctx
    }
    const root = serverRoot(this.baseUrl)
    const lms = parseLmStudioModel(
      await this.probeJson(`${root}/api/v0/models/${encodeURIComponent(model)}`),
    )
    if (lms.loaded) return remember(lms.loaded)
    // GH #129: llama.cpp hat keine erweiterte API, aber `/props` nennt mit
    // `default_generation_settings.n_ctx` genau dasselbe, naemlich das
    // wirklich allokierte Fenster. Bis hierher stieg diese Abfrage aus, sobald
    // die Basis-URL nicht auf `/v1` endete, also bei jedem llama-server auf
    // seinem eigenen Standardpfad http://localhost:8080.
    const props = parseLlamaCppProps(await this.probeJson(`${root}/props`))
    if (props) return remember(props)
    return remember(null)
  }

  /**
   * Der Schluessel, unter dem die Fensterwahl des Nutzers liegt. Endpunkt und
   * Modell, dieselbe Form wie `catalogKey`: zwei Server laden dasselbe Modell
   * verschieden gross.
   */
  contextWindowKey(model: string): string {
    return contextWindowKey(this.baseUrl, model)
  }

  /**
   * Das Fenster UND woher es kommt (GH #129).
   *
   * Kaskade, in dieser Reihenfolge und aus diesen Gruenden:
   *   1. Das laufende Fenster: erst das `context_length` aus dem /models-
   *      Katalog der Bereitstellung, sonst die Metadaten-Abfragen
   *      (`serverWindow`). Vom Server gesagt, schlaegt jede Heuristik.
   *   2. Die Wahl des Nutzers. Wer eine Zahl gesetzt hat, hat sie gesetzt,
   *      ABER nur bis an das laufende Fenster: LU kann das `-c` eines fremden
   *      Servers nicht setzen, eine groessere Wahl waere also eine Behauptung
   *      ueber ihn und wuerde wieder ein `max_tokens` ueber seinem Fenster
   *      ergeben. Geklemmt wird nur die Rechnung, nicht der Speicher: wer
   *      seinen Server groesser neu startet, bekommt seine Wahl zurueck.
   *   3. KNOWN_CONTEXT. Eine Tabelle in DIESEM Haus, kein Server hat sie
   *      bestaetigt, also `guess`: sie kann veraltet sein, und aus ihr darf
   *      kein hartes Budget abgeleitet werden.
   *   4. Die trainierte Decke, wenn niemand ein laufendes Fenster genannt hat.
   *      Sie heisst dann auch so (`trained`) und traegt kein Budget: ein
   *      Server darf jederzeit kleiner laufen, als das Modell koennte.
   *   5. Die Namensheuristik, mit 8192 als letztem Boden. Geraten.
   *
   * Die Decke steht nie in Schritt 1. Bis zum 11.09.2026 legte `toModelEntry`
   * das `n_ctx_train` der Liste in denselben Katalog wie ein echtes Fenster,
   * womit der Katalog die Abfrage ueberholte und `/props` gar nicht mehr
   * gelesen wurde.
   */
  async getContextWindow(model: string, signal?: AbortSignal): Promise<ResolvedContextWindow> {
    const { window, trained } = await this.serverWindow(model, signal)
    const chosen = this.userWindow(model)
    if (chosen > 0) {
      return window > 0 && chosen > window
        ? { tokens: window, source: 'user', modelMax: window, clampedFrom: chosen }
        : { tokens: chosen, source: 'user', modelMax: window || trained }
    }
    if (window > 0) return { tokens: window, source: 'probe', modelMax: window }
    if (KNOWN_CONTEXT[model]) {
      return { tokens: KNOWN_CONTEXT[model], source: 'guess', modelMax: 0, guessKind: 'table' }
    }
    if (trained > 0) return { tokens: trained, source: 'trained', modelMax: trained }
    return { tokens: guessContextFromName(model), source: 'guess', modelMax: 0, guessKind: 'name' }
  }

  /**
   * Was der Server ueber sein Fenster und die Decke gesagt hat, Katalog vor
   * Abfrage. Beide Zahlen, damit die Kaskade daraus eine machen kann.
   *
   * Der Katalog kommt aus derselben Modellliste, die der Waehler ohnehin holt,
   * kostet also nichts; die Abfrage liegt hinter der Fuenfminutenablage und
   * ruehrt einen Cloud-Endpunkt nie an (`probeWindow` steigt fuer alles aus,
   * was nicht auf diesem Rechner oder im LAN steht).
   */
  private async serverWindow(
    model: string,
    signal?: AbortSignal,
  ): Promise<{ window: number; trained: number }> {
    const key = this.catalogKey(model)
    const declared = catalogContext.get(key) ?? 0
    const declaredMax = catalogTrained.get(key) ?? 0
    if (declared > 0) return { window: declared, trained: declaredMax }
    const probed = await this.probeWindow(model, signal)
    return {
      window: probed.window ?? 0,
      trained: Math.max(probed.trained ?? 0, declaredMax),
    }
  }

  /** Die gespeicherte Wahl des Nutzers fuer dieses Modell, 0 = keine. */
  private userWindow(model: string): number {
    try {
      const map = useSettingsStore.getState().settings.contextWindowByModel
      return storedWindow(map, this.contextWindowKey(model))
    } catch {
      return 0
    }
  }

  async getContextLength(model: string, signal?: AbortSignal): Promise<number> {
    return (await this.getContextWindow(model, signal)).tokens
  }

  // ── Message conversion ───────────────────────────────────────

  private toOpenAIMessage(msg: ChatMessage): OpenAIRequestMessage {
    // If message has images, use content array format
    let content: string | OpenAIContentPart[] = msg.content
    if (msg.images?.length && msg.role === 'user') {
      const parts: OpenAIContentPart[] = []
      for (const img of msg.images) {
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })
      }
      parts.push({ type: 'text', text: msg.content })
      content = parts
    }
    const m: OpenAIRequestMessage = { role: msg.role, content }

    if (msg.tool_calls) {
      m.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2, 11)}`,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }))
    }

    if (msg.tool_call_id) {
      m.tool_call_id = msg.tool_call_id
    }

    return m
  }

  // ── Tool call helpers ────────────────────────────────────────

  private flushToolCalls(accum: Map<number, { id: string; name: string; args: string }>): ToolCall[] {
    if (accum.size === 0) return []

    const calls: ToolCall[] = []
    for (const [index, tc] of accum) {
      calls.push({
        // A server that never sent an id would otherwise put an empty
        // tool_call_id in the follow-up message and 422 the next turn.
        id: tc.id || `call_${index}`,
        function: {
          name: tc.name,
          arguments: this.safeParseArgs(tc.args),
        },
      })
    }
    accum.clear()
    return calls
  }

  /**
   * A tool call's `arguments` is a JSON *string* on the wire and the caller is
   * a language model, so nothing guarantees it decodes to an object. The happy
   * path used to return whatever JSON.parse produced under a
   * `Record<string, any>` annotation, `"null"` therefore handed `null` to
   * every downstream `args.foo` read, and `"[1,2]"` / `"42"` handed on a value
   * with none of the promised keys.
   *
   * Both branches now go through `isRecord`, and that is deliberately NOT the
   * check the repair branch used to have: `typeof [] === 'object'`, so
   * `parsed && typeof parsed === 'object'` let an ARRAY through, the very
   * `"[1,2]"` this comment named as covered while it was not. Arrays and null
   * are rejected here; only something indexable by name leaves.
   */
  private safeParseArgs(args: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(args)
      if (isRecord(parsed)) return parsed
    } catch {
      // fall through to the repair path below
    }
    const repaired: unknown = repairJson(args)
    return isRecord(repaired) ? repaired : {}
  }

  // ── Error parsing ────────────────────────────────────────────

  private async parseError(res: Response, toolsSent = false): Promise<ProviderError> {
    let message = `${this.config.name}: Request failed`
    let code: string = 'network'
    let hasServerMessage = false
    // LU Cloud proxy tags impossible requests with a structured top-level code
    // (sibling of `error`): "model_no_tools" (tools sent to a model without
    // function calling) / "model_no_vision" (image sent to a text-only model).
    // Mapped to our kinds after the status switch so the honest `error` line
    // surfaces and Agent/Code can remember the model.
    let serverCode: string | undefined

    try {
      const data = await res.json() as { error?: unknown; message?: string; code?: string; detail?: unknown }
      const err = data.error
      if (typeof data.code === 'string' && data.code.trim()) serverCode = data.code
      // R5-16: der Server schickt `detail` als Geschwister von `error`, und der
      // Desktop las es nicht. Genau dort steht die Haelfte, die dem Nutzer sagt,
      // was er tun kann; uebrig blieb der blanke Satz. Das Web haengt es seit
      // jeher an (the web app).
      const detail = typeof data.detail === 'string' && data.detail.trim()
        ? ` (${data.detail.slice(0, 200)})`
        : ''
      // OpenAI & most servers: { error: { message, code } }. But LM Studio and
      // llama.cpp commonly send a BARE string ({ error: "..." }) or a top-level
      // { message: "..." }. The old object-only read missed both → the real
      // reason (e.g. a context-window overflow) was swallowed and the user saw
      // the opaque "Request failed". Handle all three shapes.
      if (typeof err === 'string' && err.trim()) {
        message = err + detail
        hasServerMessage = true
      } else if (err && typeof err === 'object') {
        const eo = err as { message?: string; code?: string }
        if (eo.message) {
          message = withContextNumbers(eo.message, err)
          hasServerMessage = true
        }
        if (eo.code) code = eo.code
      } else if (typeof data.message === 'string' && data.message.trim()) {
        message = data.message
        hasServerMessage = true
      }
    } catch { /* non-JSON body → keep default */ }

    // Map HTTP status to error code. The canned texts are FALLBACKS for
    // opaque bodies only, a server that sends an honest message (LU Cloud:
    // "monthly credit budget exhausted", "LU Cloud is in closed beta (Max
    // plan only)", …) must surface it verbatim, not a wrong API-key /
    // wait-a-moment hint the user can't act on.
    if (res.status === 401 || res.status === 403) {
      code = 'auth'
      if (!hasServerMessage) message = `Invalid API key for ${this.config.name}. Check Settings > Providers.`
    } else if (res.status === 429) {
      code = 'rate_limit'
      // The server's sentence word for word; our own only when it sent none
      // or just the status label (lib/request-limit.ts).
      message = requestLimitMessage({
        said: hasServerMessage ? message : '',
        retryAfterMs: parseRetryAfter(res),
        nothingCharged: this.config.id === 'lu-cloud',
      })
    } else if (res.status === 404) {
      code = 'not_found'
    }

    // A tool-augmented request rejected for the tools themselves. LU Cloud
    // LU Cloud answer 405 for a model without function calling; some servers
    // 400/404/422 with a tool/function message. Tag it 'tools_unsupported' so
    // the chat layer shows a clean "this model can't do tool calling" note (and
    // remembers the model) instead of a raw status error. Guarded on toolsSent
    // so a plain 405 on a tool-less request is never mislabelled.
    if (toolsSent && (res.status === 405 || ((res.status === 400 || res.status === 404 || res.status === 422) && /\btools?\b|function[_ ]?call/i.test(message)))) {
      code = 'tools_unsupported'
      if (!hasServerMessage) message = `${this.config.name}: this model does not support tools (function calling).`
    }

    // Server-authoritative capability rejection (LU Cloud proxy, HTTP 400).
    // Wins over the heuristic above: it names the exact reason and ships an
    // honest, user-facing `error` line (already captured as `message`).
    if (serverCode === 'model_no_tools') code = 'tools_unsupported'
    else if (serverCode === 'model_no_vision') code = 'vision_unsupported'
    // A request without streaming that LU Cloud ended after ten minutes with
    // nothing to show; lib/http-status treats it as terminal.
    else if (serverCode === 'stalled_runaway') code = 'stalled_runaway'
    // Issue 177: a local server sent nothing within Chat Reply Timeout
    // (api/backend.ts). Terminal for the agent's retry ladder.
    else if (serverCode === FIRST_REPLY_TIMEOUT) code = FIRST_REPLY_TIMEOUT
    else if (serverCode === 'credits_exhausted') {
      // Out of credits, top-up wallet empty (HTTP 429). Raise the global
      // signal so the "Load up your credits" dialog opens on top of the
      // honest error line already carried in `message`.
      code = 'credits_exhausted'
      signalCreditsExhausted()
    }

    // LM Studio: model load fails when there's no inference runtime for the
    // model's format installed. The raw API error reads "No LM Runtime found
    // for model format 'gguf'" which doesn't tell a noob what to do,
    // rewrite it into actionable steps. This commonly happens on Windows
    // ARM64 where LM Studio doesn't auto-fetch a runtime, and on any fresh
    // install where the user installed via LU's in-app install_lmstudio.
    // The runtime catalogue isn't reachable from `lms` CLI (no `runtime`
    // subcommand), so the only Plug-and-Play step we can offer is a clear
    // pointer into LM Studio's GUI.
    if (/no\s+lm\s+runtime\s+found/i.test(message)) {
      code = 'lmstudio_runtime_missing'
      message =
        "LM Studio has no inference runtime installed for GGUF models on this machine.\n\n" +
        "Open LM Studio → click the 🔍 Discover icon in the left sidebar → " +
        "switch to the \"Runtimes\" tab → download \"llama.cpp (CPU)\" " +
        "(plus a GPU runtime if you have one).\n\n" +
        "Once the runtime is downloaded, come back here and resend your message, " +
        "no need to restart LU."
    }

    // Our OWN engine could not be reached. The failure never arrives as a
    // thrown error on the streaming path: localFetchStream turns a refused
    // connection into Response(503, {"error": "proxy_localhost_stream_chunked:
    // ..."}), so the raw Rust command name landed in the chat bubble
    // (counter-check round 2, 2026-08-29). Say it in English instead. Last in
    // the chain so a server that answered with real words keeps them.
    if (this.config.managed === true) {
      const friendly = explainEngineTransportMessage(message, this.baseUrl)
      if (friendly) {
        message = friendly
        code = 'network'
      }
    } else if (this.useLocalProxy && isLocalTransportFailure(message, this.baseUrl)) {
      // Someone else's server: LM Studio, llama.cpp, vLLM, a box in the next
      // room, or a user's own domain that the pinned CSP does not know. Same
      // raw proxy line, same house rule, only the name changes.
      //
      // The gate is `useLocalProxy` and nothing narrower, because that is the
      // very getter that chose the proxy in the first place. Asking a second,
      // smaller question here (counter-check 2026-09-04: it used to ask
      // `isPrivateOrLanHost`) left every custom provider on a public domain
      // outside the translation while its requests went through the proxy all
      // the same, so a dead endpoint put the Rust command name in the chat
      // bubble. A host that is fetched directly never produces this line at
      // all, so the gate costs a cloud endpoint nothing.
      message = this.isLanBackend
        ? localBackendUnreachableMessage(this.config.name, this.baseUrl)
        : remoteBackendUnreachableMessage(this.config.name, this.baseUrl)
      code = 'network'
    }

    return new ProviderError(message, 'openai', code, res.status, undefined, parseRetryAfter(res))
  }
}
