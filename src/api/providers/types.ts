/**
 * Multi-Provider Type Definitions
 *
 * Core interfaces that all providers (Ollama, OpenAI-compat, Anthropic) must implement.
 * This is the contract between the UI layer and the LLM backends.
 */

// ── Provider Identity ──────────────────────────────────────────

import { LU_ENGINE_NAME } from '../../lib/engine-name'
import type { ResolvedContextWindow } from '../../lib/context-source'
import type { WindowChoice } from '../../lib/context-window'

import type { CompatProviderId } from './compat-id'
export type { CompatProviderId } from './compat-id'
export { isCompatProviderId, compatProviderId, speaksOpenAIProtocol } from './compat-id'

/**
 * The four fixed slots plus any number of extra OpenAI-compatible ones
 * (`openai-<slug>`, see compat-id.ts). A table over this type still has to
 * name the four fixed slots; the extra ones are an index signature, so every
 * such table needs a spoken rule for them next to it.
 */
export type FixedProviderId = 'ollama' | 'openai' | 'anthropic' | 'lu-cloud'
export type ProviderId = FixedProviderId | CompatProviderId

export interface ProviderConfig {
  id: ProviderId
  name: string          // Display name: "Ollama", "OpenRouter", "Groq", "Anthropic"
  enabled: boolean
  baseUrl: string       // e.g. "http://localhost:11434", "https://openrouter.ai/api/v1"
  apiKey: string        // Encrypted in store. Empty string for local providers.
  isLocal: boolean      // true for Ollama, LM Studio, vLLM, no API key needed
  // Built-in engine (2.5.7): the app manages this OpenAI-compatible backend's
  // lifecycle itself (bundled llama-server on 127.0.0.1:8127). When true the UI
  // hides the URL/key inputs and the model list comes from `list_bundled_models`
  // (the Tauri command), not `/v1/models`. Undefined = a normal user-configured
  // backend, unchanged behavior.
  managed?: boolean
  // GitHub #173: set on an ADDITIONAL OpenAI-compatible entry (LM Studio next
  // to KoboldCpp next to the LU Engine), never on the four fixed slots. Its
  // models are named `openai:<entryId>::<model>` (api/providers/model-name.ts)
  // and route to this entry's own address and key. Undefined = the slot itself.
  entryId?: string
  // Set when the user switched this provider off with the Disable button in
  // Settings, AI Backends, and cleared when Enable puts it back. The list keeps
  // such a row visible (greyed, with Enable) instead of dropping it, so the
  // control that turns a backend off is not also the control that hides the way
  // back (Nebenbefund 1, R9 re-measure 2026-08-30). Undefined = a slot nobody
  // has touched here; it stays out of the list as before.
  disabledByUser?: boolean
  // The backend this slot pushed out when Add Provider handed it to somebody
  // else. Only the `openai` slot can carry one: it is the single slot every
  // OpenAI-protocol backend shares, so adding Jan there used to make the
  // built-in engine's card disappear without a word (Nebenbefund 3, R10
  // re-measure 2026-08-30). The providers list draws a greyed standby card for
  // it with an Enable button that hands the slot back. See
  // lib/openai-slot-handover.ts. Undefined = nothing was pushed out.
  displaced?: {
    name: string
    baseUrl: string
    isLocal: boolean
    managed?: boolean
    // Set when this backend left the slot because the user pressed Disable on
    // it, rather than because something else took the slot from it. The card
    // then reads DISABLED instead of STANDBY, which is the button that was
    // pressed (Nebenbefund 3, R12/R13 re-measure 2026-08-30).
    disabledByUser?: boolean
    // Opus-Review Nachbesserung 6 (3.0.1, F3): the pushed-out backend's own
    // API key, so a takeover does not just stop LEAKING it into the new
    // occupant's field (the original F3 fix) but also stops DESTROYING it,
    // handing the slot back used to come back with no key and a silent 401.
    // Same "obfuscated" representation `apiKey` itself carries, an opaque
    // blob this app never needs to read as text outside providerStore.ts.
    // Session-only on purpose: providerStore.ts's `partialize` strips this
    // field unconditionally before every persist, because there is no vault
    // entry reserved for a PARKED backend (the OS keychain has exactly one
    // slot per ProviderId, already spoken for by whichever backend is
    // active). A key parked here survives Enable/Disable within the running
    // session; it does not survive a restart, same as before this fix.
    apiKey?: string
  }
}

// ── Provider Presets (auto-fill URL) ───────────────────────────

export interface ProviderPreset {
  id: string
  name: string
  providerId: ProviderId
  baseUrl: string
  isLocal: boolean
  placeholder?: string  // API key placeholder hint
  managed?: boolean     // App-managed lifecycle (built-in engine). See ProviderConfig.managed.
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // Built-in engine (2.5.7), bundled llama.cpp llama-server, OpenAI-compatible,
  // lifecycle owned by the app. Zero external install. Default backend.
  { id: 'builtin', name: LU_ENGINE_NAME, providerId: 'openai', baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true },

  // Ollama (dedicated provider)
  { id: 'ollama', name: 'Ollama', providerId: 'ollama', baseUrl: 'http://localhost:11434', isLocal: true },

  // ── Local backends (no API key, no internet) ─────────────
  { id: 'lmstudio', name: 'LM Studio', providerId: 'openai', baseUrl: 'http://localhost:1234/v1', isLocal: true },
  { id: 'vllm', name: 'vLLM', providerId: 'openai', baseUrl: 'http://localhost:8000/v1', isLocal: true },
  { id: 'llamacpp', name: 'llama.cpp', providerId: 'openai', baseUrl: 'http://localhost:8080/v1', isLocal: true },
  // LiteLLM proxy (GH PR #64, thanks @RheagalFire), speaks the OpenAI protocol,
  // so it reuses the openai client and fronts 100+ upstreams from one local port.
  { id: 'litellm', name: 'LiteLLM', providerId: 'openai', baseUrl: 'http://localhost:4000/v1', isLocal: true },
  { id: 'koboldcpp', name: 'KoboldCpp', providerId: 'openai', baseUrl: 'http://localhost:5001/v1', isLocal: true },
  { id: 'oobabooga', name: 'text-generation-webui', providerId: 'openai', baseUrl: 'http://localhost:5000/v1', isLocal: true },
  { id: 'localai', name: 'LocalAI', providerId: 'openai', baseUrl: 'http://localhost:8080/v1', isLocal: true },
  { id: 'jan', name: 'Jan', providerId: 'openai', baseUrl: 'http://localhost:1337/v1', isLocal: true },
  { id: 'tabbyapi', name: 'TabbyAPI', providerId: 'openai', baseUrl: 'http://localhost:5000/v1', isLocal: true },
  { id: 'gpt4all', name: 'GPT4All', providerId: 'openai', baseUrl: 'http://localhost:4891/v1', isLocal: true },
  { id: 'aphrodite', name: 'Aphrodite', providerId: 'openai', baseUrl: 'http://localhost:2242/v1', isLocal: true },
  { id: 'sglang', name: 'SGLang', providerId: 'openai', baseUrl: 'http://localhost:30000/v1', isLocal: true },
  { id: 'tgi', name: 'TGI (HuggingFace)', providerId: 'openai', baseUrl: 'http://localhost:8080/v1', isLocal: true },

  // ── Cloud providers (API key required) ───────────────────
  { id: 'openrouter', name: 'OpenRouter', providerId: 'openai', baseUrl: 'https://openrouter.ai/api/v1', isLocal: false, placeholder: 'sk-or-...' },
  { id: 'groq', name: 'Groq', providerId: 'openai', baseUrl: 'https://api.groq.com/openai/v1', isLocal: false, placeholder: 'gsk_...' },
  { id: 'together', name: 'Together', providerId: 'openai', baseUrl: 'https://api.together.xyz/v1', isLocal: false, placeholder: 'tok_...' },
  { id: 'deepseek', name: 'DeepSeek', providerId: 'openai', baseUrl: 'https://api.deepseek.com/v1', isLocal: false, placeholder: 'sk-...' },
  { id: 'mistral', name: 'Mistral', providerId: 'openai', baseUrl: 'https://api.mistral.ai/v1', isLocal: false, placeholder: 'sk-...' },
  { id: 'openai', name: 'OpenAI', providerId: 'openai', baseUrl: 'https://api.openai.com/v1', isLocal: false, placeholder: 'sk-...' },
  { id: 'custom-openai', name: 'Custom (OpenAI-compat)', providerId: 'openai', baseUrl: '', isLocal: false },

  // Anthropic (own API format)
  { id: 'anthropic', name: 'Anthropic', providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', isLocal: false, placeholder: 'sk-ant-...' },
]

// ── Model ──────────────────────────────────────────────────────

export interface ProviderModel {
  flash?: import('../../lib/flash-ui').FlashPolicy
  /** Gemessenes Inhaltsverhalten aus dem Server-Katalog (LU Cloud /models
   *  `unfiltered`), nie aus dem Modellnamen geraten. 'full' = das Modell
   *  antwortet ohne Ablehnung. Fehlt das Feld, ist nichts gemessen und nichts
   *  versprochen. */
  unfiltered?: 'full' | 'partial'
  /** Die zweite Marke des Katalogs (LU Cloud /models `unrestricted`): vom
   *  Hersteller ohne Ablehnungsschicht herausgegeben. Nur Anzeige. */
  unrestricted?: boolean
  /** The name the catalogue route itself gives the model (`name`), kept only
   *  where the app shows another one (`native_name`). A store build of the
   *  phone app shows this one: the words of the web, no text of its own. */
  catalogName?: string

  id: string            // Model ID as provider knows it (e.g. "gpt-4o", "claude-sonnet-4-20250514")
  name: string          // Display name
  provider: ProviderId
  providerName: string  // "OpenRouter", "Ollama", "Anthropic" etc.
  /** GitHub #173: the additional OpenAI-compatible entry this row came from.
   *  Absent for the original slot and every other provider. */
  entryId?: string
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  /** May the two Create tools of the chat go to this model? Stated by the LU
   *  Cloud models route (`create_in_chat`). Absent on every other endpoint. */
  createInChat?: boolean
  /** The server's `limited_capacity`: the model has little room for all
   *  customers together. The picker notes it. Absent = no. */
  limitedCapacity?: boolean
  /** Think-button capability (LU Cloud /models `think` field): 'toggle' shows
   *  the switch, 'always' reasons regardless, 'never' hides it. Absent =
   *  fall back to the local name-heuristic. */
  thinkMode?: 'toggle' | 'always' | 'never'
  /** The reasoning rungs this model really accepts, ascending (LU Cloud
   *  /models `reasoning_effort_levels`). Absent on every other backend and on
   *  a server that predates the field, and absent means no effort control and
   *  the old fixed behaviour. See lib/effort.ts. */
  effortLevels?: string[]
  /** The rung the model itself defaults to (`reasoning_effort_default`). Used
   *  only where no wish was made; the user's own choice always wins. */
  effortDefault?: string
  /** A LAN model whose server takes no rungs (issue 176): the sentence the
   *  greyed effort control shows. See lib/local-effort.ts. */
  effortNote?: string
  /** The rungs come from the local server, not from a catalogue (issue 176).
   *  They go on the wire only once the user picked one (localEffortChosen). */
  effortLocal?: boolean
  /** The context window the server itself stated in its listing, and nothing
   *  else: no table, no guess from the name. `contextLength` above always
   *  holds a number to budget with; this one is absent when nobody stated
   *  one, so the model picker can leave the figure empty. */
  declaredContext?: number
  /** What the model draws per one million tokens, in credits, input and output
   *  apart (LU Cloud /models `credit_rates`, from the meter's own price
   *  source). Credits per token count only, never a money amount. Absent on a
   *  server that does not send the field. */
  creditRates?: CreditRates
}

export interface CreditRates {
  inputPerMillion: number
  outputPerMillion: number
}

// ── Chat Messages (unified format) ────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: { data: string; mimeType: string }[]  // base64 image attachments
  tool_calls?: ToolCall[]
  tool_call_id?: string  // Required for OpenAI tool results
}

export interface ToolCall {
  id?: string            // OpenAI requires this, Ollama doesn't
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

// ── Chat Options ───────────────────────────────────────────────

export interface ChatOptions {
  temperature?: number
  topP?: number
  // Ollama/Anthropic support this. The real OpenAI API does not, but F3
  // (3.0.1): the OpenAI-COMPATIBLE provider (self-hosted endpoints,
  // llama.cpp, vLLM, KoboldCpp, LM Studio, the built-in engine) sends it as
  // an extension field, the same way it already sends top_p.
  topK?: number
  maxTokens?: number
  /** GH #175: the extra samplers a persona (or a chat) can set. Each provider
   *  sends only the ones its backend reads, see sampler-fields.ts. */
  minP?: number
  repeatPenalty?: number
  presencePenalty?: number
  frequencyPenalty?: number
  dryMultiplier?: number
  /** GH #198: custom sampling parameters, key → parsed value. OpenAI
   *  compatible providers put them at the top level of the body, Ollama in
   *  `options`; a key LU sets from its own field is never taken from here
   *  (lib/custom-params.ts). */
  customParams?: Record<string, unknown>
  /**
   * True when `maxTokens` above is THIS caller's own fallback default, not a
   * value the user actually typed into a slider (bau/wfprogress.md Runde 3,
   * klein 1: `workflow-engine.ts`'s `DEFAULT_PROMPT_STEP_MAX_TOKENS` sets
   * this). `openai-provider.ts`'s `applyMaxTokens` reserves its unmeasured-
   * context branch (GH #129: "ein ausdruecklicher Wunsch des Nutzers geht
   * weiterhin raus... ohne einen solchen bleibt das Feld WEG") for a real
   * user wish only; without this flag a caller's own default would look
   * exactly like one and could get sent uncapped to a server whose real
   * window nobody measured. Every existing caller leaves this unset, so
   * `requested > 0` alone keeps meaning "the user asked for this" for them,
   * same as before this field existed.
   */
  maxTokensIsDefault?: boolean
  thinking?: boolean    // Enable model thinking/reasoning mode
  /**
   * Which rung of the reasoning ladder to ask for while thinking is on
   * (2.6.8). Meaningful only together with `effortLevels`; without a declared
   * ladder the provider keeps sending what it always sent.
   */
  reasoningEffort?: string
  /**
   * The rungs the ACTIVE model declares, ascending, straight from the server
   * catalogue. The caller passes them because the model row is what knows
   * them; the provider clamps the wish onto them. Absent = no ladder = old
   * behaviour.
   */
  effortLevels?: string[]
  /**
   * The rung the MODEL declares as its own default. Consulted only where the
   * wish is off the ladder, and only downward: the user's wish is the wish, and
   * a model default above it would quietly upgrade the bill.
   */
  effortDefault?: string
  /**
   * Has the user picked a rung for a local model himself (settings
   * `localEffortChosen`)? Until then a local server gets exactly the request
   * it got before 3.0.7: top-level 'high' with Think on and nothing in the
   * template. Absent counts as not picked, so a caller that does not pass it
   * keeps the old request rather than a new rung.
   */
  localEffortChosen?: boolean
  /**
   * Think budget in tokens (D12), 0 or absent for auto. Read only by the
   * backends that take a count (lib/think-budget.ts) and only while
   * `thinking` is true; every other provider ignores it.
   */
  thinkingBudget?: number
  /**
   * Which window this call runs in on an Ollama model. Named only by a turn a
   * person started (`chat` or `agent`); left out, the call is sent the window
   * the model was last sent and can never make Ollama load it again. The
   * number itself is never a caller's business: `ollamaNumCtx` in
   * api/ollama.ts resolves it. Other providers ignore the field (their window
   * is set when the model is loaded).
   */
  window?: WindowChoice
  /**
   * A JSON schema the answer must match, for a caller that parses the answer
   * as one JSON object (the computer control executor). Sent as the server's
   * own constrained output where one exists: `response_format` on an
   * OpenAI-compatible server, `format` on Ollama. LU Cloud and Anthropic
   * ignore it, and the caller's parser has to cope with free text anyway.
   * Read by chatWithTools only.
   */
  jsonSchema?: Record<string, unknown>
  /**
   * Phone only (round 10, lib/continue-answer.ts): the last message is an
   * answer that was cut, and the engine goes on inside it instead of
   * starting a new one. Only the OpenAI-compatible provider sends it, and
   * only the send path of the phone sets it, for the engine of the phone.
   */
  continueFinalMessage?: boolean
  signal?: AbortSignal
  // Tool definitions for a STREAMING tool turn. chatStream implementations
  // that support tools include these in the request and stream tool-call
  // deltas into the done-chunk's toolCalls; providers that cannot stream
  // tools ignore the field, and their callers keep using chatWithTools.
  // This is what lets Code/Agent mode stream on every transport instead of
  // sitting silent until the whole call returns (2026-07-31).
  tools?: ToolDefinition[]
}

// ── Streaming Chunk (unified output) ──────────────────────────

export interface ToolCallProgress {
  name: string
  argsChars: number
}

export interface ChatStreamChunk {
  content: string
  thinking?: string    // Model reasoning (Ollama thinking field, <think> tags)
  toolCalls?: ToolCall[]
  // A tool call the model is still writing: its name and how much of its
  // arguments has arrived. The finished calls still come only on the done
  // chunk; this is what the run shows in the meantime instead of "Working"
  // (a 4 kB file_write streams for ~11 s on Mistral Small, measured
  // 01.10.2026).
  toolProgress?: ToolCallProgress
  done: boolean
  // Why generation ended, on the final done:true chunk. 'stop' | 'length'
  // (token budget exhausted, e.g. the whole budget went into reasoning) |
  // 'disconnect' (the stream closed without any completion signal: proxy
  // timeout, upstream cut). Lets the chat layer explain an empty reply
  // instead of rendering silent dead air.
  finishReason?: string
  // Server-reported generation metrics (Bug M v2.4.7, Ollama only). Released
  // in the final done:true chunk. Authoritative tok/s = evalCount /
  // (evalDurationMs / 1000). Prefer these over client-side JS timing whenever
  // available, because WebView2 release-mode often buffers the response and
  // makes client-side TTFT measurement meaningless for fast models.
  evalCount?: number      // tokens generated by the model
  promptEvalCount?: number // tokens in the prompt = real consumed context (system+tools+history+input)
  evalDurationMs?: number // generation time in ms (excludes prompt eval + load)
  /** How LU Cloud billed this request (`x-lu-chat-billing`): 'flash' drew no
   *  credits. Absent on every other backend and when the header was missing. */
  billing?: ChatBilling
}

export type ChatBilling = 'flash' | 'credits'

// ── Tool Definition (OpenAI format, converted per provider) ───

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }
}

// ── Provider Client Interface ─────────────────────────────────

export interface ProviderClient {
  readonly id: ProviderId
  /** GitHub #173: the additional OpenAI-compatible entry this client serves.
   *  Absent for the four fixed slots. */
  readonly entryId?: string

  /** Stream a chat response. Yields unified ChatStreamChunks. */
  chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncGenerator<ChatStreamChunk>

  /** Non-streaming chat with tool calling support. The optional
   *  promptEvalCount/evalCount carry real token usage (consumed context) so
   *  the agent/code TokenCounter can show the true fill, not a char/4 estimate.
   *  `thinking` carries native model reasoning (Ollama thinking field, LU Cloud
   *  reasoning_content). */
  chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number; thinking?: string; billing?: ChatBilling }>

  /** List available models from this provider. */
  listModels(): Promise<ProviderModel[]>

  /** Test if the provider is reachable and credentials are valid. */
  checkConnection(): Promise<boolean>

  /** Get the context window size for a model. */
  getContextLength(model: string): Promise<number>

  /** GH #129: dasselbe Fenster MIT der Auskunft, woher die Zahl stammt
   *  (Server, Nutzer, geraten). Nur der OpenAI-kompatible Provider
   *  beantwortet das; wo es fehlt, bleibt es bei der blossen Zahl. */
  getContextWindow?(model: string, signal?: AbortSignal): Promise<ResolvedContextWindow>

  /** GH #129: der Schluessel, unter dem die Fensterwahl des Nutzers fuer
   *  dieses Modell an diesem Endpunkt liegt. */
  contextWindowKey?(model: string): string

  /** G37b: the server's own live answer to "can this model take a native
   *  `tools` payload", asked at send time. Only the OpenAI-compat provider
   *  implements it (LM Studio enhanced listing per model, llama.cpp /props
   *  server-wide); `false` downgrades the run to the prompt transport,
   *  `undefined` means nobody said. */
  serverToolSupport?(model: string): Promise<boolean | undefined>

  /** R19: the context the server actually allocated for the loaded model
   *  (LM Studio `loaded_context_length`). The agent run budget clamps to it,
   *  because a prompt beyond the allocation is hard-truncated server-side.
   *  `null` means the server did not say. */
  loadedContextLength?(model: string): Promise<number | null>
}

// ── Provider Error ────────────────────────────────────────────

export class ProviderError extends Error {
  // Explicit fields (not constructor parameter-properties): the build runs
  // under `erasableSyntaxOnly`, which forbids TS parameter-properties.
  readonly provider: ProviderId
  /** 'auth' | 'rate_limit' | 'not_found' | 'network' | 'outage' | 'ollama_missing_blob' | 'ollama_stale_manifest' */
  readonly code?: string
  readonly status?: number
  /**
   * Provider-specific extra context. Used by UI catch sites to update the
   * model-health store (Ollama missing-blob / stale-manifest) without importing
   * zustand from inside the provider, keeps the API layer decoupled from app
   * state. See lib/sync-ollama-health.ts.
   */
  readonly model?: string
  /**
   * How long the server said to wait, in milliseconds, from a `retry-after`
   * header. Only a throttle sends one. Without it the retry site can only
   * guess, and its guess (1.5 s then 3 s) is far shorter than the window a
   * fixed-window limiter actually holds, so every attempt lands inside the
   * same refusal. See lib/http-status retryDelayMs.
   */
  readonly retryAfterMs?: number

  constructor(
    message: string,
    provider: ProviderId,
    code?: string,
    status?: number,
    model?: string,
    retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.code = code
    this.status = status
    this.model = model
    this.retryAfterMs = retryAfterMs
  }
}
