/**
 * Multi-Provider Type Definitions
 *
 * Core interfaces that all providers (Ollama, OpenAI-compat, Anthropic) must implement.
 * This is the contract between the UI layer and the LLM backends.
 */

// ── Provider Identity ──────────────────────────────────────────

export type ProviderId = 'ollama' | 'openai' | 'anthropic'

export interface ProviderConfig {
  id: ProviderId
  name: string          // Display name: "Ollama", "OpenRouter", "Groq", "Anthropic"
  enabled: boolean
  baseUrl: string       // e.g. "http://localhost:11434", "https://openrouter.ai/api/v1"
  apiKey: string        // Encrypted in store. Empty string for local providers.
  isLocal: boolean      // true for Ollama, LM Studio, vLLM — no API key needed
}

// ── Provider Presets (auto-fill URL) ───────────────────────────

export interface ProviderPreset {
  id: string
  name: string
  providerId: ProviderId
  baseUrl: string
  isLocal: boolean
  placeholder?: string  // API key placeholder hint
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // Ollama (dedicated provider)
  { id: 'ollama', name: 'Ollama', providerId: 'ollama', baseUrl: 'http://localhost:11434', isLocal: true },

  // ── Local backends (no API key, no internet) ─────────────
  { id: 'lmstudio', name: 'LM Studio', providerId: 'openai', baseUrl: 'http://localhost:1234/v1', isLocal: true },
  { id: 'vllm', name: 'vLLM', providerId: 'openai', baseUrl: 'http://localhost:8000/v1', isLocal: true },
  { id: 'llamacpp', name: 'llama.cpp', providerId: 'openai', baseUrl: 'http://localhost:8080/v1', isLocal: true },
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
  { id: 'litellm', name: 'LiteLLM', providerId: 'openai', baseUrl: 'http://localhost:4000/v1', isLocal: true },
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
}

// ── Streaming Chunk (unified output) ──────────────────────────

export interface ChatStreamChunk {
  content: string
  thinking?: string    // Model reasoning (Ollama thinking field, <think> tags)
  toolCalls?: ToolCall[]
  done: boolean
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
   *  the agent/code TokenCounter can show the true fill, not a char/4 estimate. */
  chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number }>

  /** List available models from this provider. */
  listModels(): Promise<ProviderModel[]>

  /** Test if the provider is reachable and credentials are valid. */
  checkConnection(): Promise<boolean>

  /** Get the context window size for a model. */
  getContextLength(model: string): Promise<number>
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

  constructor(
    message: string,
    provider: ProviderId,
    code?: string,
    status?: number,
    model?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.code = code
    this.status = status
    this.model = model
  }
}
