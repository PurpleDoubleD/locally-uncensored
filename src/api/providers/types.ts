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
  signal?: AbortSignal
}

// ── Streaming Chunk (unified output) ──────────────────────────

export interface ChatStreamChunk {
  content: string
  toolCalls?: ToolCall[]
  done: boolean
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

  /** Non-streaming chat with tool calling support. */
  chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions
  ): Promise<{ content: string; toolCalls: ToolCall[] }>

  /** List available models from this provider. */
  listModels(): Promise<ProviderModel[]>

  /** Test if the provider is reachable and credentials are valid. */
  checkConnection(): Promise<boolean>

  /** Get the context window size for a model. */
  getContextLength(model: string): Promise<number>
}

// ── Provider Error ────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderId,
    public readonly code?: string,     // 'auth', 'rate_limit', 'not_found', 'network'
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
