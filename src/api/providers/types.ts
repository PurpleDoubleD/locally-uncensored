/**
 * Multi-Provider Type Definitions
 *
 * Core interfaces that all providers (Ollama, OpenAI-compat, Anthropic) must implement.
 * This is the contract between the UI layer and the LLM backends.
 */

// ── Provider Identity ──────────────────────────────────────────

export type ProviderId = 'ollama' | 'openai' | 'anthropic' | 'lu-cloud'

export interface ProviderConfig {
  id: ProviderId
  name: string          // Display name: "Ollama", "OpenRouter", "Groq", "Anthropic"
  enabled: boolean
  baseUrl: string       // e.g. "http://localhost:11434", "https://openrouter.ai/api/v1"
  apiKey: string        // Encrypted in store. Empty string for local providers.
  isLocal: boolean      // true for Ollama, LM Studio, vLLM — no API key needed
  // Built-in engine (2.5.7): the app manages this OpenAI-compatible backend's
  // lifecycle itself (bundled llama-server on 127.0.0.1:8127). When true the UI
  // hides the URL/key inputs and the model list comes from `list_bundled_models`
  // (the Tauri command), not `/v1/models`. Undefined = a normal user-configured
  // backend, unchanged behavior.
  managed?: boolean
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
  // Built-in engine (2.5.7) — bundled llama.cpp llama-server, OpenAI-compatible,
  // lifecycle owned by the app. Zero external install. Default backend.
  { id: 'builtin', name: 'Built-in Engine', providerId: 'openai', baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true },

  // Ollama (dedicated provider)
  { id: 'ollama', name: 'Ollama', providerId: 'ollama', baseUrl: 'http://localhost:11434', isLocal: true },

  // ── Local backends (no API key, no internet) ─────────────
  { id: 'lmstudio', name: 'LM Studio', providerId: 'openai', baseUrl: 'http://localhost:1234/v1', isLocal: true },
  { id: 'vllm', name: 'vLLM', providerId: 'openai', baseUrl: 'http://localhost:8000/v1', isLocal: true },
  { id: 'llamacpp', name: 'llama.cpp', providerId: 'openai', baseUrl: 'http://localhost:8080/v1', isLocal: true },
  // LiteLLM proxy (GH PR #64, thanks @RheagalFire) — speaks the OpenAI protocol,
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
  id: string            // Model ID as provider knows it (e.g. "gpt-4o", "claude-sonnet-4-20250514")
  name: string          // Display name
  provider: ProviderId
  providerName: string  // "OpenRouter", "Ollama", "Anthropic" etc.
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  /** Think-button capability (LU Cloud /models `think` field): 'toggle' shows
   *  the switch, 'always' reasons regardless, 'never' hides it. Absent =
   *  fall back to the local name-heuristic. */
  thinkMode?: 'toggle' | 'always' | 'never'
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
    arguments: Record<string, any>
  }
}

// ── Chat Options ───────────────────────────────────────────────

export interface ChatOptions {
  temperature?: number
  topP?: number
  topK?: number         // Ollama/Anthropic support this, OpenAI doesn't
  maxTokens?: number
  thinking?: boolean    // Enable model thinking/reasoning mode
  // Bug AA v2.5.0 — Kj103x Discord 2026-05-27. Ollama defaults `num_ctx` to
  // 2048 if you don't pass it in /api/chat options, which silently caps RAG
  // and long-turn chats even though the loaded model supports way more. When
  // set, we forward this as `options.num_ctx` to Ollama. Other providers
  // ignore it (they have their own context handling). 0/undefined = let the
  // provider use its default.
  contextWindow?: number
  signal?: AbortSignal
  // Tool definitions for a STREAMING tool turn. chatStream implementations
  // that support tools include these in the request and stream tool-call
  // deltas into the done-chunk's toolCalls; providers that cannot stream
  // tools ignore the field, and their callers keep using chatWithTools.
  // This is what lets Code/Agent mode stream on every transport instead of
  // sitting silent until the whole call returns (David 2026-07-31).
  tools?: ToolDefinition[]
}

// ── Streaming Chunk (unified output) ──────────────────────────

export interface ChatStreamChunk {
  content: string
  thinking?: string    // Model reasoning (Ollama thinking field, <think> tags)
  toolCalls?: ToolCall[]
  done: boolean
  // Why generation ended, on the final done:true chunk. 'stop' | 'length'
  // (token budget exhausted — e.g. the whole budget went into reasoning) |
  // 'disconnect' (the stream closed without any completion signal: proxy
  // timeout, upstream cut). Lets the chat layer explain an empty reply
  // instead of rendering silent dead air.
  finishReason?: string
  // Server-reported generation metrics (Bug M v2.4.7 — Ollama only). Released
  // in the final done:true chunk. Authoritative tok/s = evalCount /
  // (evalDurationMs / 1000). Prefer these over client-side JS timing whenever
  // available, because WebView2 release-mode often buffers the response and
  // makes client-side TTFT measurement meaningless for fast models.
  evalCount?: number      // tokens generated by the model
  promptEvalCount?: number // tokens in the prompt = real consumed context (system+tools+history+input)
  evalDurationMs?: number // generation time in ms (excludes prompt eval + load)
}

// ── Tool Definition (OpenAI format, converted per provider) ───

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, any>
      required: string[]
    }
  }
}

// ── Provider Client Interface ─────────────────────────────────

export interface ProviderClient {
  readonly id: ProviderId

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
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number; thinking?: string }>

  /** List available models from this provider. */
  listModels(): Promise<ProviderModel[]>

  /** Test if the provider is reachable and credentials are valid. */
  checkConnection(): Promise<boolean>

  /** Get the context window size for a model. */
  getContextLength(model: string): Promise<number>

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
  /** 'auth' | 'rate_limit' | 'not_found' | 'network' | 'ollama_missing_blob' | 'ollama_stale_manifest' */
  readonly code?: string
  readonly status?: number
  /**
   * Provider-specific extra context. Used by UI catch sites to update the
   * model-health store (Ollama missing-blob / stale-manifest) without importing
   * zustand from inside the provider — keeps the API layer decoupled from app
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
