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
import { isTauri, localFetch, localFetchStream } from '../backend'
import { parseNDJSONStream } from '../stream'

// ── Ollama-specific types ──────────────────────────────────────

interface OllamaChatChunk {
  message?: { content: string; tool_calls?: { function: { name: string; arguments: Record<string, any> } }[] }
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

  /** Build a full Ollama API URL from config.baseUrl + path */
  private apiUrl(path: string): string {
    const base = this.config.baseUrl || 'http://localhost:11434'
    if (isTauri()) {
      return `${base}/api${path}`
    }
    // Dev mode: proxy through Vite — use /api path
    return `/api${path}`
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content }))

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

    const res = await localFetchStream(this.apiUrl('/chat'), {
      method: 'POST',
      body: JSON.stringify(body),
    })

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

    const res = await localFetch(this.apiUrl('/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new ProviderError(
        await this.extractError(res, 'Tool calling failed'),
        'ollama', 'network', res.status,
      )
    }

    const data = await res.json()
    const toolCalls: ToolCall[] = (data.message?.tool_calls || []).map((tc: any) => ({
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }))

    return {
      content: data.message?.content || '',
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
      const data = await res.json()
      return data.error || fallback
    } catch {
      return fallback
    }
  }
}
