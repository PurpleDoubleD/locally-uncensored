/**
 * Anthropic Provider — Claude API
 *
 * Uses the Anthropic Messages API which has a different format from OpenAI:
 * - System prompt is a separate `system` param, not a message
 * - SSE events use `event: content_block_delta` format
 * - Tool calling uses `tool_use` content blocks
 * - No /models endpoint — model list is hardcoded
 */

import type {
  ProviderClient, ProviderModel, ProviderConfig, ChatMessage, ChatOptions,
  ChatStreamChunk, ToolCall, ToolDefinition,
} from './types'
import { ProviderError } from './types'
import { parseSSEWithEvents } from '../sse'
import { idleAbortGuard, isStreamIdleTimeout } from '../stream-idle'
import { sendWithTransientRetry } from './retry'
import { parseRetryAfter } from '../../lib/http-status'
import {
  localFetch, localFetchStream, isPrivateOrLanHost, isDirectFetchAllowed,
  hostnameOf, ensureProxyAllowsHost,
} from '../backend'

// ── Anthropic API Types ────────────────────────────────────────

interface AnthropicStreamEvent {
  type: string
  index?: number
  content_block?: { type: string; id?: string; name?: string; input?: any; text?: string }
  delta?: { type: string; text?: string; partial_json?: string; thinking?: string }
  message?: { id: string; usage?: { input_tokens: number; output_tokens: number } }
  // message_delta events carry cumulative output usage at the event top level.
  usage?: { input_tokens?: number; output_tokens?: number }
  // `event: error` on an otherwise healthy HTTP-200 stream. Anthropic sends it
  // for overloaded_error / api_error when the failure happens AFTER the
  // response headers are out.
  error?: { type?: string; message?: string }
}

interface AnthropicResponse {
  content: {
    type: 'text' | 'tool_use'
    text?: string
    id?: string
    name?: string
    input?: Record<string, any>
  }[]
  stop_reason?: string
  usage?: { input_tokens: number; output_tokens: number }
}

// ── Known Claude models ────────────────────────────────────────

const CLAUDE_MODELS: ProviderModel[] = [
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', providerName: 'Anthropic', contextLength: 200000, supportsTools: true, supportsVision: true },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', providerName: 'Anthropic', contextLength: 200000, supportsTools: true, supportsVision: true },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', providerName: 'Anthropic', contextLength: 200000, supportsTools: true, supportsVision: true },
]

// ── Prompt caching (2.6.6 A8) ──────────────────────────────────
//
// Prompt caching is GA on `anthropic-version: 2023-06-01`, the version this
// provider already pins. The old opt-in `anthropic-beta:
// prompt-caching-2024-07-31` is no longer required and is NOT sent: an
// unknown beta value is a needless failure surface on the proxies people
// front this provider with (LiteLLM, claude-relay-server, opencode-zen).
//
// The API allows at most 4 breakpoints per request. We place at most 3, in
// render order (tools → system → messages):
//   1. the last tool definition  → caches [tools]
//   2. the system block          → caches [tools + system]
//   3. the last STABLE message   → caches [tools + system + settled history]
// Layered on purpose: when the system prompt moves, the tools prefix still
// reads from cache.
//
// "Stable" means the youngest message the NEXT request will send unchanged,
// so the current turn's message is deliberately skipped. Marking it would
// write a fresh entry on every step and never read one back, because A1
// decay and A3 compaction still rewrite the tail of the history.

/** A /v1/messages body under construction. The wire mixes strings, numbers,
 *  nested objects and content-block arrays, so the value type stays open —
 *  named once here rather than restated on every signature. */
type MessagesBody = Record<string, any>

/** The init every transport in this file accepts: plain `fetch`, and the two
 *  proxy-aware helpers in backend.ts. */
interface MessagesRequestInit {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

const CACHE_CONTROL = { type: 'ephemeral' } as const

// ── Extended Thinking budget ───────────────────────────────────
/** Upper bound for the reasoning budget. The model may use less. */
const DEFAULT_THINKING_BUDGET = 5000
/** Room the answer itself keeps on top of the reasoning budget. */
const MIN_ANSWER_TOKENS = 2048

/** A message content as blocks, so a marker has something to ride on. */
function asContentBlocks(content: string | Record<string, any>[]): Record<string, any>[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/**
 * Stamp the three ephemeral breakpoints onto a finished request body. Called
 * from both request paths (chatStream and chatWithTools) after the body is
 * fully built, so vision, tool and plain-text variants all carry the markers.
 */
function applyCacheControl(body: MessagesBody): void {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    body.tools[body.tools.length - 1].cache_control = { ...CACHE_CONTROL }
  }

  if (typeof body.system === 'string' && body.system) {
    body.system = [{ type: 'text', text: body.system, cache_control: { ...CACHE_CONTROL } }]
  }

  const messages: Record<string, any>[] = body.messages
  if (messages.length >= 2) {
    const stable = messages[messages.length - 2]
    stable.content = asContentBlocks(stable.content)
    const lastBlock = stable.content[stable.content.length - 1]
    if (lastBlock) lastBlock.cache_control = { ...CACHE_CONTROL }
  }
}

// ── Provider Implementation ────────────────────────────────────

export class AnthropicProvider implements ProviderClient {
  readonly id = 'anthropic' as const

  private readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  /**
   * Bug O — v2.4.7. When users point the Anthropic provider at a proxy
   * (claude-relay-server, LiteLLM, opencode-zen, etc.) they sometimes
   * configure the baseUrl with `/v1` already included. Pre-v2.4.7 we always
   * appended `/v1/messages`, producing `https://proxy.example/v1/v1/messages`
   * which 404s silently. Strip a trailing `/v1` so users can paste whichever
   * shape their proxy docs use.
   */
  private messagesUrl(): string {
    const base = this.baseUrl
    if (/\/v1$/i.test(base)) {
      return `${base}/messages`
    }
    return `${base}/v1/messages`
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }

  /**
   * Transport decision, same rule the OpenAI provider uses.
   *
   * This provider explicitly supports a custom baseUrl (claude-relay-server,
   * LiteLLM, opencode-zen — see messagesUrl above), and then always issued a
   * raw webview fetch. In the packaged app that request never leaves the
   * webview: the pinned CSP lists api.anthropic.com and nothing else, and a
   * self-hosted relay adds CORS on top. So the one configuration the code went
   * out of its way to support was the one that could not work. Anything the CSP
   * does not name — and every LAN address — takes the Rust proxy instead;
   * api.anthropic.com itself keeps its direct fetch, unchanged.
   */
  private get useLocalProxy(): boolean {
    const host = hostnameOf(this.baseUrl)
    return this.config.isLocal === true
      || isPrivateOrLanHost(host)
      || !isDirectFetchAllowed(host)
  }

  /**
   * One POST to /v1/messages, over whichever transport this endpoint needs,
   * with the throttle retry around it (providers/retry.ts — request only,
   * never around a stream that has already started).
   */
  private async send(
    body: MessagesBody,
    signal: AbortSignal | undefined,
    streaming: boolean,
  ): Promise<Response> {
    const proxied = this.useLocalProxy
    if (proxied) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher: (url: string, init: MessagesRequestInit) => Promise<Response> =
      proxied ? (streaming ? localFetchStream : localFetch) : fetch
    return sendWithTransientRetry(
      () => fetcher(this.messagesUrl(), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
      }),
      { signal },
    )
  }

  /**
   * Extended Thinking, built to the API's constraints instead of against them.
   *
   * Two of them were violated at once, so this feature could only ever produce
   * a 400: `budget_tokens` has to be strictly SMALLER than `max_tokens` (the
   * budget is carved out of it), and 5000 was sent against a 4096 default; and
   * `temperature` / `top_p` / `top_k` may not be sent at all while thinking is
   * on, which the sampling defaults above did on every turn. The retry below
   * then dropped `thinking` and succeeded, which is why nobody saw a failure —
   * it just meant Extended Thinking has never once run, at the price of a full
   * extra request per Anthropic turn. (useChat injects a `<think>` prompt for
   * non-Ollama models, so the UI still showed a thinking block.)
   *
   * The budget stays under half the ceiling so a user who lowered Max Tokens
   * still gets an answer and not only reasoning, and never drops below the
   * 1024 the API requires.
   */
  private applyThinking(body: MessagesBody, options?: ChatOptions): void {
    if (options?.thinking !== true) return

    const ceiling: number = body.max_tokens
    const budget = Math.max(1024, Math.min(DEFAULT_THINKING_BUDGET, Math.floor(ceiling / 2)))
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // max_tokens covers thinking AND the answer, so it must have room for both.
    body.max_tokens = Math.max(ceiling, budget + MIN_ANSWER_TOKENS)
    delete body.temperature
    delete body.top_p
    delete body.top_k
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const { system, anthropicMessages } = this.convertMessages(messages)

    const body: MessagesBody = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : 4096,
      stream: true,
    }

    if (system) body.system = system
    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    if (options?.topK !== undefined) body.top_k = options.topK
    // Claude Extended Thinking (Sonnet 3.7+, Opus 4). Opt-in: only when the
    // user actually toggled Thinking ON. Default stays OFF, so toggle OFF
    // simply omits the field. See applyThinking for the API constraints it
    // has to satisfy — and used to violate.
    this.applyThinking(body, options)

    // Streaming tool turn (same conversion as chatWithTools below). The
    // stream parser already accumulates tool_use blocks via input_json_delta
    // and flushes them into the done-chunk's toolCalls.
    if (options?.tools?.length) {
      body.tools = options.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    }

    applyCacheControl(body)

    // Zeitbombe 4 — the idle watchdog needs a controller to abort, and a
    // provider only ever receives a signal. This chains one onto the caller's:
    // Stop still propagates inward, and a stream that goes silent can cancel
    // its own request instead of leaving reader.read() pending forever.
    const guard = idleAbortGuard(options?.signal)
    let res: Response
    try {
      res = await this.send(body, guard.signal, true)

      // Retry without extended thinking if the model rejects it (e.g. older
      // Claude versions don't support `thinking`). With applyThinking building
      // an API-conform body this is a genuine fallback again rather than the
      // request that always ran.
      if (!res.ok && res.status === 400 && 'thinking' in body) {
        delete body.thinking
        res = await this.send(body, guard.signal, true)
      }

      if (!res.ok) throw await this.parseError(res)
    } catch (err) {
      // Nothing to watch — drop the listener on the caller's signal here, the
      // stream loop's `finally` below is never reached on this path.
      guard.release()
      throw err
    }

    // Track tool use blocks being built
    const toolUseBlocks: Map<number, { id: string; name: string; input: string }> = new Map()
    // Real token usage: message_start carries input_tokens, message_delta the
    // cumulative output_tokens. Surfaced on the done chunk exactly like the
    // OpenAI provider so the TokenCounter gets a real anchor on every backend.
    let inputTokens = 0
    let outputTokens = 0

    try {
      for await (const { data } of parseSSEWithEvents<AnthropicStreamEvent>(res, { onIdle: guard.abort })) {
        if (options?.signal?.aborted) break

        switch (data.type) {
          case 'error': {
            // Anthropic reports a failure that happened AFTER the response
            // headers went out as an `error` EVENT on a healthy HTTP 200 —
            // overloaded_error when the fleet is saturated, api_error for an
            // internal fault. The switch had no arm for it, so the event was
            // dropped, the stream then ended without message_stop, and the user
            // got an empty 'disconnect' bubble that blamed their network for
            // the provider's outage. Surface the real thing, with the status
            // the retry policy in lib/http-status expects for it.
            const kind = data.error?.type
            const code = kind === 'overloaded_error' ? 'overloaded'
              : kind === 'rate_limit_error' ? 'rate_limit'
              : kind === 'authentication_error' ? 'auth'
              : 'network'
            const status = kind === 'overloaded_error' ? 529
              : kind === 'rate_limit_error' ? 429
              : kind === 'authentication_error' ? 401
              : 500
            throw new ProviderError(
              data.error?.message || `Anthropic stream error${kind ? ` (${kind})` : ''}`,
              'anthropic',
              code,
              status,
            )
          }

          case 'message_start': {
            const u = data.message?.usage
            if (u?.input_tokens) inputTokens = u.input_tokens
            break
          }

          case 'content_block_start': {
            if (data.content_block?.type === 'tool_use') {
              toolUseBlocks.set(data.index!, {
                id: data.content_block.id || '',
                name: data.content_block.name || '',
                input: '',
              })
            }
            break
          }

          case 'content_block_delta': {
            const dtype = (data.delta as any)?.type
            if (dtype === 'text_delta' && (data.delta as any).text) {
              yield { content: (data.delta as any).text, done: false }
            } else if (dtype === 'thinking_delta' && (data.delta as any).thinking) {
              // Claude Extended Thinking stream — route to `thinking` so the
              // ThinkingBlock UI picks it up (same field as Ollama's native).
              yield { content: '', thinking: (data.delta as any).thinking, done: false }
            } else if (dtype === 'input_json_delta' && (data.delta as any).partial_json) {
              const block = toolUseBlocks.get(data.index!)
              if (block) block.input += (data.delta as any).partial_json
            }
            break
          }

          case 'message_delta': {
            // End of message — flush tool calls. Map Anthropic's stop_reason
            // onto the unified finishReason ('max_tokens' → 'length', the key
            // the chat layer uses to explain thought-only/truncated turns).
            const stopReason = (data.delta as any)?.stop_reason as string | undefined
            if (data.usage?.output_tokens) outputTokens = data.usage.output_tokens
            const toolCalls = this.flushToolUseBlocks(toolUseBlocks)
            yield {
              content: '',
              toolCalls: toolCalls.length ? toolCalls : undefined,
              done: true,
              finishReason: stopReason === 'max_tokens' ? 'length' : (stopReason || 'stop'),
              promptEvalCount: inputTokens || undefined,
              evalCount: outputTokens || undefined,
            }
            return
          }

          case 'message_stop': {
            const toolCalls2 = this.flushToolUseBlocks(toolUseBlocks)
            yield {
              content: '', toolCalls: toolCalls2.length ? toolCalls2 : undefined, done: true, finishReason: 'stop',
              promptEvalCount: inputTokens || undefined, evalCount: outputTokens || undefined,
            }
            return
          }
        }
      }
    } catch (err) {
      // The watchdog fired: the stream did not fail, it went quiet. Terminal
      // chunk, same as a clean cut, instead of a raw error.
      if (isStreamIdleTimeout(err)) {
        yield {
          content: '', done: true, finishReason: 'disconnect',
          promptEvalCount: inputTokens || undefined, evalCount: outputTokens || undefined,
        }
        return
      }
      throw err
    } finally {
      guard.release()
    }

    // Stream ended without an explicit message_delta/message_stop — the
    // connection was cut mid-generation (same semantics as the OpenAI
    // provider's missing-[DONE] path).
    const toolCalls = this.flushToolUseBlocks(toolUseBlocks)
    yield {
      content: '', toolCalls: toolCalls.length ? toolCalls : undefined, done: true, finishReason: 'disconnect',
      promptEvalCount: inputTokens || undefined, evalCount: outputTokens || undefined,
    }
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number }> {
    const { system, anthropicMessages } = this.convertMessages(messages)

    const body: MessagesBody = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : 4096,
    }

    if (system) body.system = system
    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    if (options?.topK !== undefined) body.top_k = options.topK
    // Same extended-thinking gate as chatStream.
    this.applyThinking(body, options)

    // Convert OpenAI tool format to Anthropic format
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    }

    applyCacheControl(body)

    let res = await this.send(body, options?.signal, false)

    // Retry without extended thinking if the model rejects it.
    if (!res.ok && res.status === 400 && 'thinking' in body) {
      delete body.thinking
      res = await this.send(body, options?.signal, false)
    }

    if (!res.ok) {
      throw await this.parseError(res)
    }

    const data: AnthropicResponse = await res.json()

    let content = ''
    const toolCalls: ToolCall[] = []

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text || ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name!,
            arguments: (typeof block.input === 'object' && block.input) ? block.input : {},
          },
        })
      }
    }

    // Real usage (audit B7): without it the TokenCounter stayed on the
    // char/4 estimate for every Anthropic agent turn.
    return {
      content,
      toolCalls,
      promptEvalCount: data.usage?.input_tokens || undefined,
      evalCount: data.usage?.output_tokens || undefined,
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    // Anthropic has no public /models endpoint
    return [...CLAUDE_MODELS]
  }

  async checkConnection(): Promise<boolean> {
    if (!this.config.apiKey) return false

    try {
      // Send a minimal request to verify the API key
      const res = await this.send({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }, undefined, false)
      // 200 or 400 (bad request but auth worked) both mean the key is valid
      return res.status !== 401 && res.status !== 403
    } catch {
      return false
    }
  }

  async getContextLength(model: string): Promise<number> {
    const known = CLAUDE_MODELS.find(m => model.includes(m.id.split('-').slice(0, 2).join('-')))
    return known?.contextLength || 200000
  }

  // ── Message conversion ───────────────────────────────────────

  private convertMessages(messages: ChatMessage[]): {
    system: string
    anthropicMessages: Record<string, any>[]
  } {
    let system = ''
    const anthropicMessages: Record<string, any>[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic: system goes in a separate parameter
        system += (system ? '\n\n' : '') + msg.content
        continue
      }

      if (msg.role === 'tool') {
        // Anthropic tool results are user messages with tool_result content blocks
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || 'unknown',
            content: msg.content,
          }],
        })
        continue
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Assistant with tool calls → include tool_use content blocks
        const content: any[] = []
        if (msg.content) content.push({ type: 'text', text: msg.content })
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id || `toolu_${Math.random().toString(36).slice(2, 11)}`,
            name: tc.function.name,
            input: tc.function.arguments,
          })
        }
        anthropicMessages.push({ role: 'assistant', content })
        continue
      }

      // Regular user/assistant message — with optional images
      if (msg.images?.length && msg.role === 'user') {
        const content: any[] = []
        for (const img of msg.images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.data },
          })
        }
        content.push({ type: 'text', text: msg.content })
        anthropicMessages.push({ role: 'user', content })
      } else {
        anthropicMessages.push({ role: msg.role, content: msg.content })
      }
    }

    // Anthropic requires messages to alternate user/assistant.
    // Merge consecutive same-role messages. Block-array contents merge too
    // (audit B7): the agent loop pushes one tool-result message PER call, and
    // Anthropic requires all tool_result blocks answering one assistant turn
    // to arrive in ONE user message. The old string-only merge left two
    // parallel tool calls as two consecutive user messages, which the API
    // rejects — so any multi-tool batch broke the whole Anthropic agent path.
    const asBlocks = (content: string | Record<string, any>[]): Record<string, any>[] =>
      typeof content === 'string' ? [{ type: 'text', text: content }] : content
    const merged: Record<string, any>[] = []
    for (const msg of anthropicMessages) {
      const last = merged[merged.length - 1]
      if (!last || last.role !== msg.role) {
        merged.push(msg)
        continue
      }
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n\n' + msg.content
      } else {
        last.content = [...asBlocks(last.content), ...asBlocks(msg.content)]
      }
    }

    return { system, anthropicMessages: merged }
  }

  // ── Tool call helpers ────────────────────────────────────────

  private flushToolUseBlocks(blocks: Map<number, { id: string; name: string; input: string }>): ToolCall[] {
    if (blocks.size === 0) return []

    const calls: ToolCall[] = []
    for (const [, block] of blocks) {
      let args: Record<string, any> = {}
      try { args = JSON.parse(block.input) } catch { /* empty */ }

      calls.push({
        id: block.id,
        function: { name: block.name, arguments: args },
      })
    }
    blocks.clear()
    return calls
  }

  // ── Error parsing ────────────────────────────────────────────

  private async parseError(res: Response): Promise<ProviderError> {
    let message = 'Anthropic: Request failed'
    let code: string = 'network'

    try {
      const data = await res.json()
      if (data.error?.message) message = data.error.message
    } catch { /* use default */ }

    if (res.status === 401 || res.status === 403) {
      code = 'auth'
      message = 'Invalid Anthropic API key. Check Settings > Providers.'
    } else if (res.status === 429) {
      code = 'rate_limit'
      message = 'Rate limited by Anthropic. Wait a moment and try again.'
    } else if (res.status === 404) {
      code = 'not_found'
    } else if (res.status === 529) {
      code = 'overloaded'
      message = 'Anthropic API is overloaded. Try again in a few seconds.'
    }

    // The throttle's own number, so the agent's retry ladder waits out the real
    // window instead of its 1.5 s guess (lib/http-status retryDelayMs).
    return new ProviderError(message, 'anthropic', code, res.status, undefined, parseRetryAfter(res))
  }
}
