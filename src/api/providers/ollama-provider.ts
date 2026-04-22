/**
 * Ollama Provider — wraps existing ollama.ts into the ProviderClient interface.
 *
 * No behavior change. Pure adapter pattern.
 * Reuses localFetch/localFetchStream from backend.ts for Tauri compatibility.
 */

import type {
  ProviderClient, ProviderModel, ProviderConfig, ChatMessage, ChatOptions,
  ChatStreamChunk, ToolCall, ToolDefinition,
} from './types'
import { ProviderError } from './types'
import { localFetch, localFetchStream, ollamaUrl } from '../backend'
import { parseNDJSONStream } from '../stream'
import { repairToolCallArgs, extractToolCallsFromContent } from '../../lib/tool-call-repair'

// ── Ollama-specific types ──────────────────────────────────────

interface OllamaChatChunk {
  message?: { content: string; thinking?: string; tool_calls?: { function: { name: string; arguments: Record<string, any> } }[] }
  done?: boolean
}

interface OllamaModelEntry {
  name: string
  model: string
  size: number
  digest: string
  modified_at: string
  details: {
    parent_model: string
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
}

// ── Provider Implementation ────────────────────────────────────

export class OllamaProvider implements ProviderClient {
  readonly id = 'ollama' as const

  constructor(private config: ProviderConfig) {}

  /**
   * Build a full Ollama API URL. Delegates to `ollamaUrl()` from backend.ts
   * so Tauri-mode (direct URL honoring `_ollamaBase`) and dev-mode
   * (`/api/*` → Vite proxy with OLLAMA_HOST target) stay in sync with the
   * rest of the app.
   *
   * Issue #31 fix: previously this function used `config.baseUrl` in Tauri
   * mode only, and in dev mode always forwarded to the Vite proxy which
   * itself was hardcoded to localhost:11434 — so a user-configured remote
   * Ollama never actually got called. Both modes now go through the single
   * ollamaUrl() resolver.
   */
  private apiUrl(path: string): string {
    return ollamaUrl(path)
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const ollamaMessages = messages.map(m => {
      const msg: Record<string, any> = { role: m.role, content: m.content }
      if (m.images?.length) msg.images = m.images.map(img => img.data)
      return msg
    })

    const body: Record<string, any> = {
      model,
      messages: ollamaMessages,
      stream: true,
    }

    const ollamaOptions: Record<string, any> = { num_gpu: 99 }
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP
    if (options?.topK !== undefined) ollamaOptions.top_k = options.topK
    if (options?.maxTokens) ollamaOptions.num_predict = options.maxTokens
    body.options = ollamaOptions
    // Tri-state: true → explicit think on, false → explicit think off
    // (saves tokens on QwQ / DeepSeek-R1 / Gemma 4 etc.), undefined →
    // omit the field and let Ollama pick the default.
    if (options?.thinking === true) body.think = true
    else if (options?.thinking === false) body.think = false

    let res = await localFetchStream(this.apiUrl('/chat'), {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    // Older Ollama builds / non-thinking models reject ANY `think` field
    // with HTTP 400. Retry once without it so the user's request still
    // succeeds — we just fall back to model-default behaviour.
    if (!res.ok && res.status === 400 && 'think' in body) {
      delete body.think
      res = await localFetchStream(this.apiUrl('/chat'), {
        method: 'POST',
        body: JSON.stringify(body),
        signal: options?.signal,
      })
    }

    if (!res.ok) {
      throw new ProviderError(
        await this.extractError(res, 'Chat failed'),
        'ollama', 'network', res.status,
      )
    }

    for await (const chunk of parseNDJSONStream<OllamaChatChunk>(res)) {
      if (options?.signal?.aborted) break

      const toolCalls: ToolCall[] | undefined = chunk.message?.tool_calls?.map(tc => ({
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }))

      yield {
        content: chunk.message?.content || '',
        thinking: chunk.message?.thinking || undefined,
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        done: chunk.done || false,
      }
    }
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const ollamaMessages = messages.map(m => {
      const msg: Record<string, any> = { role: m.role, content: m.content }
      if (m.tool_calls) msg.tool_calls = m.tool_calls
      if (m.images?.length) msg.images = m.images.map(img => img.data)
      return msg
    })

    const body: Record<string, any> = {
      model,
      messages: ollamaMessages,
      tools,
      stream: false,
    }

    const ollamaOptions: Record<string, any> = { num_gpu: 99 }
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP
    if (options?.topK !== undefined) ollamaOptions.top_k = options.topK
    if (options?.maxTokens) ollamaOptions.num_predict = options.maxTokens
    body.options = ollamaOptions
    // Tri-state think flag — see chatStream() for details.
    if (options?.thinking === true) body.think = true
    else if (options?.thinking === false) body.think = false

    const fetchOptions = (bodyObj: Record<string, any>): any => {
      const opts: any = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      }
      if (options?.signal) opts.signal = options.signal
      return opts
    }

    let res = await localFetch(this.apiUrl('/chat'), fetchOptions(body))
    if (!res.ok && res.status === 400 && 'think' in body) {
      delete body.think
      res = await localFetch(this.apiUrl('/chat'), fetchOptions(body))
    }

    if (!res.ok) {
      throw new ProviderError(
        await this.extractError(res, 'Tool calling failed'),
        'ollama', 'network', res.status,
      )
    }

    const data = await res.json()
    let toolCalls: ToolCall[] = (data.message?.tool_calls || []).map((tc: any) => ({
      function: { name: tc.function.name, arguments: repairToolCallArgs(tc.function.arguments) },
    }))

    // If no tool calls found but content looks like a tool call, try to extract
    if (toolCalls.length === 0 && data.message?.content) {
      const extracted = extractToolCallsFromContent(data.message.content)
      if (extracted.length > 0) {
        toolCalls = extracted.map(tc => ({ function: tc }))
      }
    }

    return {
      content: data.message?.content || '',
      thinking: data.message?.thinking || '',
      toolCalls,
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const res = await localFetch(this.apiUrl('/tags'))
    if (!res.ok) {
      throw new ProviderError('Failed to fetch Ollama models', 'ollama', 'network', res.status)
    }

    const data = await res.json()
    return (data.models || []).map((m: OllamaModelEntry) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama' as const,
      providerName: 'Ollama',
      contextLength: undefined, // fetched on demand via getContextLength
    }))
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await localFetch(this.apiUrl('/tags'))
      return res.ok
    } catch {
      return false
    }
  }

  async getContextLength(model: string): Promise<number> {
    try {
      const res = await localFetch(this.apiUrl('/show'), {
        method: 'POST',
        body: JSON.stringify({ name: model }),
      })
      if (!res.ok) return 4096
      const info = await res.json()
      return info?.model_info?.['general.context_length'] || info?.parameters?.num_ctx || 4096
    } catch {
      return 4096
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private async extractError(res: Response, fallback: string): Promise<string> {
    try {
      // Share the detection logic with loadModel / unloadModel via ollama-errors.
      // The regex there matches chat, completion, AND generate (the Lichtschalter
      // path uses /api/generate with an empty prompt for preload — same error class).
      const { parseOllamaError, chatStyleMessage } = await import('../../lib/ollama-errors')
      const parsed = await parseOllamaError(res, fallback)
      return chatStyleMessage(parsed)
    } catch {
      return fallback
    }
  }
}
