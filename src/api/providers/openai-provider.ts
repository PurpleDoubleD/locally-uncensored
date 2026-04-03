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
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'gpt-4': 8192, 'gpt-3.5-turbo': 16385,
  'deepseek-chat': 64000, 'deepseek-reasoner': 64000,
  'mistral-large-latest': 128000, 'mistral-small-latest': 32000,
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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

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
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers,
    })

    if (!res.ok) {
      throw await this.parseError(res)
    }

    const data = await res.json()
    const models: OpenAIModelEntry[] = data.data || data.models || []

    return models.map(m => ({
      id: m.id,
      name: m.id,
      provider: 'openai' as const,
      providerName: this.config.name,
      contextLength: KNOWN_CONTEXT[m.id],
      supportsTools: true,
    }))
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers,
      })
      return res.ok
    } catch {
      return false
    }
  }

  async getContextLength(model: string): Promise<number> {
    return KNOWN_CONTEXT[model] || 8192
  }

  // ── Message conversion ───────────────────────────────────────

  private toOpenAIMessage(msg: ChatMessage): Record<string, any> {
    const m: Record<string, any> = { role: msg.role, content: msg.content }

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
      return {}
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

    return new ProviderError(message, 'openai', code, res.status)
  }
}
