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
import { ProviderError } from './types'
import { parseSSEStream } from '../sse'
import { repairJson } from '../../lib/tool-call-repair'
import { localFetch, localFetchStream } from '../backend'

/**
 * Local OpenAI-compat backends (LM Studio, vLLM, llama.cpp, KoboldCpp, etc.)
 * are hit over plain HTTP on localhost. From the Tauri webview that triggers
 * CORS, so use `localFetch`/`localFetchStream` which bypass via the Rust
 * proxy (with direct-fetch fallback).
 * Cloud endpoints (OpenAI, OpenRouter, Groq, Together, etc.) don't need the
 * proxy and skip it via a simple host check.
 */
function isLocalUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

// ── OpenAI API Types ───────────────────────────────────────────

interface OpenAIStreamChunk {
  choices?: [{
    delta?: {
      content?: string
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }]
}

interface OpenAIResponse {
  choices?: [{
    message?: {
      content?: string
      tool_calls?: {
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }[]
    }
    finish_reason?: string
  }]
}

interface OpenAIModelEntry {
  id: string
  object: string
  created?: number
  owned_by?: string
}

interface OpenAIError {
  error?: { message?: string; type?: string; code?: string }
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

// Heuristik aus dem Modell-Namen — letzter Fallback bevor wir auf den
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

// ── Provider Implementation ────────────────────────────────────

export class OpenAIProvider implements ProviderClient {
  readonly id = 'openai' as const

  constructor(private config: ProviderConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
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
      h['HTTP-Referer'] = 'https://locallyuncensored.com'
      h['X-Title'] = 'Locally Uncensored'
    }
    return h
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const body: Record<string, any> = {
      model,
      messages: messages.map(m => this.toOpenAIMessage(m)),
      stream: true,
    }

    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    if (options?.maxTokens) body.max_tokens = options.maxTokens
    // Reasoning-model knob (o1, o3, gpt-5-thinking, etc.). Toggle OFF →
    // "minimal" (least reasoning the API allows). Toggle ON → "high".
    // Non-reasoning models simply ignore this field; older APIs may 400 on
    // it — we handle that with a retry below.
    if (options?.thinking === true) body.reasoning_effort = 'high'
    else if (options?.thinking === false) body.reasoning_effort = 'minimal'

    const fetcher = isLocalUrl(this.baseUrl) ? localFetchStream : fetch
    let res = await fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    } as any)

    // Retry without reasoning_effort if the model/endpoint rejects it.
    if (!res.ok && res.status === 400 && 'reasoning_effort' in body) {
      delete body.reasoning_effort
      res = await fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      } as any)
    }

    if (!res.ok) {
      throw await this.parseError(res)
    }

    // Accumulate tool call arguments across chunks (OpenAI streams them in pieces)
    const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map()

    for await (const event of parseSSEStream(res)) {
      if (event.data === '[DONE]') {
        // Flush accumulated tool calls
        const toolCalls = this.flushToolCalls(toolCallAccum)
        yield { content: '', toolCalls: toolCalls.length ? toolCalls : undefined, done: true }
        return
      }

      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(event.data)
      } catch {
        continue
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue

      const content = choice.delta?.content || ''

      // Accumulate streamed tool calls
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallAccum.get(tc.index)
          if (existing) {
            if (tc.function?.arguments) existing.args += tc.function.arguments
          } else {
            toolCallAccum.set(tc.index, {
              id: tc.id || '',
              name: tc.function?.name || '',
              args: tc.function?.arguments || '',
            })
          }
        }
      }

      if (content) {
        yield { content, done: false }
      }

      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        const toolCalls = this.flushToolCalls(toolCallAccum)
        yield { content: '', toolCalls: toolCalls.length ? toolCalls : undefined, done: true }
        return
      }
    }

    // If stream ended without explicit done
    const toolCalls = this.flushToolCalls(toolCallAccum)
    yield { content: '', toolCalls: toolCalls.length ? toolCalls : undefined, done: true }
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const body: Record<string, any> = {
      model,
      messages: messages.map(m => this.toOpenAIMessage(m)),
      stream: false,
    }

    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    if (options?.maxTokens) body.max_tokens = options.maxTokens
    // Same reasoning_effort gate as chatStream.
    if (options?.thinking === true) body.reasoning_effort = 'high'
    else if (options?.thinking === false) body.reasoning_effort = 'minimal'

    const fetcher = isLocalUrl(this.baseUrl) ? localFetch : fetch
    let res = await fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    } as any)

    if (!res.ok && res.status === 400 && 'reasoning_effort' in body) {
      delete body.reasoning_effort
      res = await fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      } as any)
    }

    if (!res.ok) {
      throw await this.parseError(res)
    }

    const data: OpenAIResponse = await res.json()
    const choice = data.choices?.[0]

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls || []).map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: this.safeParseArgs(tc.function.arguments),
      },
    }))

    return {
      content: choice?.message?.content || '',
      toolCalls,
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const fetcher = isLocalUrl(this.baseUrl) ? localFetch : fetch
    const res = await fetcher(`${this.baseUrl}/models`, {
      headers: this.headers,
    } as any)

    if (!res.ok) {
      throw await this.parseError(res)
    }

    const data = await res.json()
    const models: OpenAIModelEntry[] = data.data || data.models || []

    // Bug K: fuer lokale Backends (LM Studio etc.) probe das wahre
    // Context-Limit vom Server. Sonst zeigen wir 8K obwohl das Modell 32K+
    // kann. Probes laufen parallel; bei Cloud-Providers (OpenAI/OpenRouter)
    // wuerde N+1 zu Rate-Limits fuehren, deshalb nur KNOWN_CONTEXT/Heuristik.
    if (isLocalUrl(this.baseUrl)) {
      return Promise.all(models.map(async m => ({
        id: m.id,
        name: m.id,
        provider: 'openai' as const,
        providerName: this.config.name,
        contextLength:
          KNOWN_CONTEXT[m.id] ??
          (await this.probeContextFromServer(m.id)) ??
          guessContextFromName(m.id),
        supportsTools: true,
      })))
    }

    return models.map(m => ({
      id: m.id,
      name: m.id,
      provider: 'openai' as const,
      providerName: this.config.name,
      contextLength: KNOWN_CONTEXT[m.id] ?? guessContextFromName(m.id),
      supportsTools: true,
    }))
  }

  async checkConnection(): Promise<boolean> {
    try {
      const fetcher = isLocalUrl(this.baseUrl) ? localFetch : fetch
      const res = await fetcher(`${this.baseUrl}/models`, {
        headers: this.headers,
      } as any)
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Bug K — dynamische Context-Window-Detection fuer lokale OpenAI-compat
   * Backends. LM Studio 0.3+ liefert die wahren Werte via Enhanced-API:
   *   GET /api/v0/models/<id>  ->  { max_context_length, loaded_context_length, ... }
   * Generische OpenAI-compat Server (vLLM, llama.cpp server, Aphrodite, SGLang,
   * TabbyAPI, ...) liefern es oft im Standard-/v1/models/<id> response unter
   * verschiedenen Keys: context_window | max_model_len | n_ctx_train | context_length.
   *
   * Wir bevorzugen `max_context_length` (das echte Modell-Limit) ueber
   * `loaded_context_length` (was der User gerade in LM Studio geladen hat).
   * Sonst sieht der User "8K" weil er LM Studio mit 8K geladen hat — obwohl
   * sein qwen2.5:32b in Wahrheit 32K+ kann. Genau das war der Reporter-Bug.
   *
   * Returnt `null` wenn nichts gefunden, damit Callers cascaden koennen.
   */
  private async probeContextFromServer(model: string): Promise<number | null> {
    if (!isLocalUrl(this.baseUrl)) return null

    // 1. LM Studio Enhanced API: /api/v0/models/<id>
    //    Base-URL ist typischerweise http://localhost:1234/v1 — wir tauschen
    //    /v1 gegen /api/v0 aus. Wenn der Server kein LM Studio ist, kommt 404
    //    zurueck und wir cascaden weiter.
    try {
      const lmStudioBase = this.baseUrl.replace(/\/v1\/?$/, '/api/v0')
      const lmsRes = await localFetch(
        `${lmStudioBase}/models/${encodeURIComponent(model)}`,
        { headers: this.headers } as any,
      )
      if (lmsRes.ok) {
        const data = await lmsRes.json()
        const max = data?.max_context_length ?? data?.context_length
        if (max && Number(max) > 0) return Number(max)
      }
    } catch { /* fall through */ }

    // 2. Generic /v1/models/<id> — vLLM, llama.cpp server, etc. expose Context
    //    unter wechselnden Keys. Wir akzeptieren das erste was > 0 ist.
    try {
      const res = await localFetch(
        `${this.baseUrl}/models/${encodeURIComponent(model)}`,
        { headers: this.headers } as any,
      )
      if (res.ok) {
        const data = await res.json()
        const ctx =
          data?.context_window ??
          data?.max_model_len ??
          data?.n_ctx_train ??
          data?.context_length
        if (ctx && Number(ctx) > 0) return Number(ctx)
      }
    } catch { /* fall through */ }

    return null
  }

  async getContextLength(model: string): Promise<number> {
    // Cascade:
    //   1. KNOWN_CONTEXT lookup (kein Network, instant)
    //   2. probeContextFromServer (LM Studio enhanced + generic /v1/models/<id>)
    //   3. Heuristik aus dem Modell-Namen
    //   4. Konservativer 8192er-Fallback (in guessContextFromName)
    if (KNOWN_CONTEXT[model]) return KNOWN_CONTEXT[model]
    const probed = await this.probeContextFromServer(model)
    if (probed) return probed
    return guessContextFromName(model)
  }

  // ── Message conversion ───────────────────────────────────────

  private toOpenAIMessage(msg: ChatMessage): Record<string, any> {
    // If message has images, use content array format
    let content: any = msg.content
    if (msg.images?.length && msg.role === 'user') {
      const parts: any[] = []
      for (const img of msg.images) {
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })
      }
      parts.push({ type: 'text', text: msg.content })
      content = parts
    }
    const m: Record<string, any> = { role: msg.role, content }

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
    for (const [, tc] of accum) {
      calls.push({
        id: tc.id,
        function: {
          name: tc.name,
          arguments: this.safeParseArgs(tc.args),
        },
      })
    }
    accum.clear()
    return calls
  }

  private safeParseArgs(args: string): Record<string, any> {
    try {
      return JSON.parse(args)
    } catch {
      const repaired = repairJson(args)
      return repaired && typeof repaired === 'object' ? repaired : {}
    }
  }

  // ── Error parsing ────────────────────────────────────────────

  private async parseError(res: Response): Promise<ProviderError> {
    let message = `${this.config.name}: Request failed`
    let code: string = 'network'

    try {
      const data: OpenAIError = await res.json()
      if (data.error?.message) message = data.error.message
      if (data.error?.code) code = data.error.code
    } catch { /* use default */ }

    // Map HTTP status to error code
    if (res.status === 401 || res.status === 403) {
      code = 'auth'
      message = `Invalid API key for ${this.config.name}. Check Settings > Providers.`
    } else if (res.status === 429) {
      code = 'rate_limit'
      message = `Rate limited by ${this.config.name}. Wait a moment and try again.`
    } else if (res.status === 404) {
      code = 'not_found'
    }

    // LM Studio: model load fails when there's no inference runtime for the
    // model's format installed. The raw API error reads "No LM Runtime found
    // for model format 'gguf'" which doesn't tell a noob what to do —
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
        "Once the runtime is downloaded, come back here and resend your message — " +
        "no need to restart Locally Uncensored."
    }

    return new ProviderError(message, 'openai', code, res.status)
  }
}
