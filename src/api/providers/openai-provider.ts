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
import { signalCreditsExhausted } from '../../lib/credits-exhausted'
import { parseRetryAfter } from '../../lib/http-status'
import { localFetch, localFetchStream, isPrivateOrLanHost, isDirectFetchAllowed, hostnameOf, ensureProxyAllowsHost, backendCall } from '../backend'
import { ensureBuiltinEngineAlive, explainDeadEngine, explainEngineTransportMessage, isManagedBuiltinSlot } from '../builtin-ensure'
import { applyTemplateContract } from './normalize-system'

// Transport routing lives in the `useLocalProxy` getter (below) plus the shared
// host helpers in backend.ts. A direct webview fetch only works for hosts the
// pinned CSP lists; everything else — LAN backends (also CORS-blocked, GH #49)
// and any cloud endpoint LU ships no preset for — goes through the Rust proxy.
// `isLanBackend` stays separate: it decides local-only BEHAVIOUR (context
// probing), which must not follow the transport decision.

// ── OpenAI API Types ───────────────────────────────────────────

interface OpenAIStreamChunk {
  choices?: [{
    delta?: {
      content?: string
      // Native reasoning channel — DeepInfra (LU Cloud) reasoning models
      // stream thinking as `reasoning_content`, some as `reasoning`.
      reasoning_content?: string
      reasoning?: string
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
      reasoning_content?: string
      reasoning?: string
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
  // Catalogue metadata some OpenAI-compat servers attach (LU Cloud does):
  // display name, real context window, vision modality, think capability.
  // Absent everywhere else — the mapping below falls back to heuristics.
  name?: string
  context_length?: number
  input_modalities?: string[]
  // LU Cloud /models declares per-model tool-calling support. Some cloud chat
  // models (Hermes 3, Euryale, MythoMax, Llama-4-Maverick, …) can't do function
  // calling; the server marks them false so Agent/Code mode can gate them up
  // front instead of eating a mid-run 400. Absent on backends that don't send
  // it → the mapping falls back to `true` (optimistic, corrected at runtime).
  supports_tools?: boolean
  think?: 'toggle' | 'always' | 'never'
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

// Real context windows from the provider's /models catalogue (LU Cloud sends
// context_length per model). The name heuristic underestimates new cloud
// models badly (Qwen3.6-35B-A3B → 32k guess vs 262k real), which shrinks the
// applyMaxTokens headroom toward the 256 floor on long chats and truncates
// answers. Module-level and keyed by endpoint — NOT an instance field: the
// lu-cloud provider builds a FRESH OpenAIProvider delegate on every call (its
// bearer token rotates), so an instance map is always empty exactly where it
// matters. listModels fills it through one delegate; chatStream's
// applyMaxTokens and getContextLength read it through another.
const catalogContext = new Map<string, number>()

/**
 * Which accumulator slot a tool-call delta without an `index` belongs to. The
 * field is required by the OpenAI spec but several compatible servers omit it.
 * A delta carrying a fresh id opens the next slot; anything else continues the
 * call currently being filled.
 */
function keyForUnindexedDelta(
  accum: Map<number, { id: string; name: string; args: string }>,
  id?: string,
): number {
  if (id) {
    for (const [key, call] of accum) {
      if (call.id === id) return key
    }
    return accum.size
  }
  return Math.max(0, accum.size - 1)
}

/** Test-only: reset the endpoint catalogue between test cases. */
export function __clearContextCatalogForTests(): void {
  catalogContext.clear()
}

// ── Provider Implementation ────────────────────────────────────

export class OpenAIProvider implements ProviderClient {
  readonly id = 'openai' as const

  constructor(private config: ProviderConfig) {}

  private catalogKey(model: string): string {
    return `${this.baseUrl}|${model}`
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  /**
   * A backend on this machine or the LAN — declared by the preset
   * (`config.isLocal`) OR detected from the host (localhost, RFC1918, CGNAT,
   * IPv6 ULA/link-local, .local, bare machine name). Drives behaviour that only
   * makes sense locally: per-model context probing and the LM Studio enhanced
   * API. Cloud endpoints must not do those (N+1 requests → rate limits).
   */
  private get isLanBackend(): boolean {
    return this.config.isLocal === true || isPrivateOrLanHost(hostnameOf(this.baseUrl))
  }

  /**
   * Whether requests must go through the Rust proxy instead of a direct webview
   * fetch. Two reasons: a LAN endpoint has no CORS headers for the
   * tauri.localhost origin (GH #49), and a public host outside the pinned CSP
   * allow-list gets killed inside the webview before it hits the network — that
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
   * fresh Windows install introduced itself to applejames on 2026-08-01 before
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
   * kevinmlynch traced what that means elsewhere (#112, 2026-08-13): DwarfStar
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
  private thinkingEffort(model: string, thinking: boolean | undefined): string | undefined {
    if (thinking === undefined) return undefined
    const walked = OpenAIProvider.effortMemory.get(this.catalogKey(model))
    if (thinking === true) return walked?.on === 'omit' ? undefined : 'high'
    if (walked?.off === 'omit') return undefined
    return walked?.off === 'minimal' ? 'minimal' : 'none'
  }

  /** Remember a walk, for one direction of the switch only. */
  private rememberEffort(model: string, lane: 'on' | 'off', value: 'minimal' | 'omit'): void {
    const key = this.catalogKey(model)
    const prev = OpenAIProvider.effortMemory.get(key) ?? {}
    OpenAIProvider.effortMemory.set(key, { ...prev, [lane]: value })
  }

  /**
   * POST a chat body, stepping the thinking knob down rather than dropping it
   * at the first complaint: 'none', then 'minimal', then gone. The last step
   * also drops stream_options, the other field an endpoint that predates both
   * rejects. The LU Cloud proxy deliberately passes upstream 400 AND 422
   * (DeepInfra's bad-parameter status) through so this path can engage.
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
    body: Record<string, any>,
    signal: AbortSignal | undefined,
    fetcher: (url: string, init: any) => Promise<Response>,
  ): Promise<Response> {
    const post = () => fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    })
    const refused = (res: Response) => !res.ok && (res.status === 400 || res.status === 422)

    const asked = body.reasoning_effort as string | undefined
    const lane: 'on' | 'off' | undefined =
      asked === undefined ? undefined : asked === 'high' ? 'on' : 'off'

    // Stop ends the walk. The real fetch rejects on an aborted signal on its
    // own, but localFetchStream's proxy path used to fire the request anyway,
    // so the ladder could keep spending steps after the user was done.
    const stopped = () => signal?.aborted === true

    let res = await this.sendOrExplain(post)

    if (!stopped() && refused(res) && body.reasoning_effort === 'none') {
      body.reasoning_effort = 'minimal'
      res = await post()
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
      const survived = body.reasoning_effort as string | undefined
      if (survived === undefined) this.rememberEffort(model, lane, 'omit')
      else if (survived !== asked) this.rememberEffort(model, lane, 'minimal')
    }

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
   * Bound `max_tokens` so prompt + completion can never exceed the model's real
   * context window. Some cloud backends (DeepInfra) otherwise default the
   * completion budget to nearly the whole window and then 400 the moment the
   * real prompt (agent system prompt + tool definitions) tips it over —
   * surfaced as "[network] inference upstream error" on tool turns (Bug 5,
   * 2026-07-11). Under-estimating the context is safe (a shorter cap); we never
   * over-request. Runs for every request, so an UNSET budget (settings.maxTokens
   * = 0) sends the full safe remainder instead of letting the server over-default.
   */
  private async applyMaxTokens(
    model: string,
    body: Record<string, any>,
    options?: ChatOptions,
  ): Promise<void> {
    const requested = options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : 0
    let ctxLen = 0
    try { ctxLen = await this.getContextLength(model) } catch { ctxLen = 0 }
    if (ctxLen <= 0) {
      // No context info at all — honor an explicit request, else a safe default.
      body.max_tokens = requested || 4096
      return
    }
    const RESERVE = 512
    const promptChars =
      JSON.stringify(body.messages || '').length + JSON.stringify(body.tools || '').length
    const promptTokens = Math.ceil(promptChars / 4)
    const headroom = Math.max(256, ctxLen - promptTokens - RESERVE)
    // Audit E6: an UNSET budget used to send the whole remaining window as
    // max_tokens — six figures on a 128k model. Servers that validate
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
    const body: Record<string, any> = {
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
    const effort = this.thinkingEffort(model, options?.thinking)
    if (effort) body.reasoning_effort = effort
    // Ask the server for REAL token usage in a final stream chunk
    // (choices:[] + usage:{...}). OpenAI, DeepInfra (LU Cloud), Groq, vLLM and
    // LM Studio all honor stream_options; an endpoint that rejects unknown
    // params 400/422s and the retry below drops it. Real usage is what keeps
    // the TokenCounter honest — a char/4 estimate can't see the system prompt.
    body.stream_options = { include_usage: true }

    // Managed built-in engine: Create/Music renders stop the llama-server
    // child to free VRAM ("reloads lazily on the next message") — this is that
    // lazy reload. Restart-before-send instead of letting the fetch hit a dead
    // 127.0.0.1:8127 and look like a crashed backend.
    if (this.config.managed === true) await ensureBuiltinEngineAlive(model)

    if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher = this.useLocalProxy ? localFetchStream : fetch
    const res = await this.sendChat(model, body, options?.signal, fetcher as any)

    if (!res.ok) {
      throw await this.parseError(res)
    }

    // Accumulate tool call arguments across chunks (OpenAI streams them in pieces)
    const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map()
    let promptTokens = 0
    let completionTokens = 0
    let finishReason: string | undefined
    const doneChunk = (fallbackReason: string): ChatStreamChunk => {
      const toolCalls = this.flushToolCalls(toolCallAccum)
      return {
        content: '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
        done: true,
        finishReason: finishReason ?? fallbackReason,
        promptEvalCount: promptTokens || undefined,
        evalCount: completionTokens || undefined,
      }
    }

    for await (const event of parseSSEStream(res)) {
      if (event.data === '[DONE]') {
        yield doneChunk('stop')
        return
      }

      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(event.data)
      } catch {
        continue
      }

      // LM Studio (and some OpenAI-compat servers) report a mid-stream failure
      // as a 200 response carrying an SSE error chunk ({ error: { message } } or
      // a bare { error: "..." }) instead of a non-2xx status, so the !res.ok
      // guard above never fires. Such a chunk has no `choices`, so the old loop
      // just skipped it → the user got a SILENT EMPTY reply. Surface it as a
      // thrown error so the chat layer can map it to a friendly message (e.g.
      // the #67 image-on-text-model case). Verified live: LM Studio + image on a
      // text-only model returns `event: error` with HTTP 200 (2026-06-21).
      const streamErr = (chunk as { error?: { message?: string } | string }).error
      if (streamErr) {
        throw new Error(typeof streamErr === 'string' ? streamErr : (streamErr.message || 'Streaming error'))
      }

      // Real token usage — the include_usage final chunk carries `usage` with
      // an empty choices[], so capture it BEFORE the choice guard below.
      const u = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
      if (u) {
        promptTokens = u.prompt_tokens || promptTokens
        completionTokens = u.completion_tokens || completionTokens
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue

      // Capture WHY the model stopped ('stop', 'length', 'content_filter').
      // 'length' with zero content is the reasoning-loop failure mode: the
      // whole token budget went into thinking and no answer was ever written
      // (David, cloud Qwen3.6, 2026-07-12) — the chat layer needs the reason
      // to explain the empty bubble.
      if (choice.finish_reason) finishReason = choice.finish_reason

      const content = choice.delta?.content || ''

      // Yield native reasoning as `thinking` so the panel fills live —
      // without this the entire reasoning phase of a cloud reasoner is
      // silently dropped and the chat sits in dead air (uselu fc55c91).
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? ''
      if (reasoning) {
        yield { content: '', thinking: reasoning, done: false }
      }

      // Accumulate streamed tool calls
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const key = tc.index ?? keyForUnindexedDelta(toolCallAccum, tc.id)
          const existing = toolCallAccum.get(key)
          if (existing) {
            // id and name do NOT always arrive in the first delta — several
            // OpenAI-compat servers send the id one chunk later, or open with a
            // bare index. Ignoring them left a call with an empty name (dispatch
            // fails on "") or an empty tool_call_id, which 422s the follow-up
            // turn — the exact break the server-side normalizer had to heal.
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
        }
      }

      if (content) {
        yield { content, done: false }
      }

      // NB: we intentionally do NOT early-return on finish_reason. With
      // stream_options.include_usage the server sends the usage chunk AFTER
      // the finish_reason chunk — returning early would discard it. The [DONE]
      // sentinel (or the end-of-stream fallback below) emits the single done
      // chunk, which now carries the captured usage.
    }

    // Stream ended without an explicit [DONE] sentinel. If the server also
    // never sent a finish_reason, the connection was cut mid-generation
    // (proxy idle-timeout, upstream drop) — a clean FIN ends parseSSEStream
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
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number; thinking?: string }> {
    const body: Record<string, any> = {
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
    await this.applyMaxTokens(model, body, options)
    // Same reasoning_effort gate as chatStream.
    const effort = this.thinkingEffort(model, options?.thinking)
    if (effort) body.reasoning_effort = effort

    // Same self-heal as chatStream: agent/tool turns after a Create render
    // must revive the offloaded built-in engine before hitting its port.
    if (this.config.managed === true) await ensureBuiltinEngineAlive(model)

    if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher = this.useLocalProxy ? localFetch : fetch
    const res = await this.sendChat(model, body, options?.signal, fetcher as any)

    if (!res.ok) {
      throw await this.parseError(res, tools.length > 0)
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

    // Real consumed-context usage (non-streaming response carries it directly).
    const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    return {
      content: choice?.message?.content || '',
      toolCalls,
      promptEvalCount: usage?.prompt_tokens,
      evalCount: usage?.completion_tokens,
      thinking: choice?.message?.reasoning_content || choice?.message?.reasoning || undefined,
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
    const fetcher = this.useLocalProxy ? localFetch : fetch
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
    if (this.isLanBackend) {
      // G32 (R20-Mac, 2026-08-07): the standard /v1/models listing says
      // nothing about tools, so `?? true` declared every LM Studio model
      // tool-capable and the layered resolution downstream had nothing to
      // downgrade on — a tool-less model got a native `tools` payload. LM
      // Studio's enhanced listing answers it per model in `capabilities`
      // (['tool_use', ...]); one fetch covers all models. Backends without
      // the enhanced API leave the map empty → optimistic as before.
      const { lanCaps, serverTools } = await this.liveToolCaps()
      return Promise.all(models.map(async m => ({
        id: m.id,
        name: m.id,
        provider: 'openai' as const,
        providerName: this.config.name,
        contextLength:
          KNOWN_CONTEXT[m.id] ??
          (await this.probeContextFromServer(m.id)) ??
          guessContextFromName(m.id),
        supportsTools: lanCaps.has(m.id)
          ? lanCaps.get(m.id)!.includes('tool_use')
          : (serverTools ?? m.supports_tools ?? true),
      })))
    }

    return models.map(m => {
      // Remember the server-declared window for applyMaxTokens (see
      // catalogContext). Server value beats every heuristic — it reflects
      // what THIS deployment actually serves.
      if (m.context_length && m.context_length > 0) {
        catalogContext.set(this.catalogKey(m.id), m.context_length)
      }
      return {
        id: m.id,
        name: m.name ?? m.id,
        provider: 'openai' as const,
        providerName: this.config.name,
        contextLength: m.context_length ?? KNOWN_CONTEXT[m.id] ?? guessContextFromName(m.id),
        // Server-authoritative tool capability. `false` for the cloud chat
        // models that can't do function calling → the whole chain (Agent
        // toggle, dropdown icon, Code mode) gates them without a failed run.
        // Fallback `true` keeps older deployments (no field) optimistic.
        supportsTools: m.supports_tools ?? true,
        supportsVision: m.input_modalities?.includes('image') || undefined,
        thinkMode: m.think,
      }
    })
  }

  async checkConnection(): Promise<boolean> {
    try {
      if (this.useLocalProxy) await ensureProxyAllowsHost(this.baseUrl)
      const fetcher = this.useLocalProxy ? localFetch : fetch
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
    if (!this.isLanBackend) return null

    // Probe cache (audit E5): applyMaxTokens calls getContextLength on EVERY
    // request, and a LAN backend without a catalog entry paid one or two HTTP
    // probes per agent iteration. A loaded model's window does not move
    // between iterations; 5 minutes covers an LM Studio reload with changed
    // settings. Negative answers cache too — a server that has no context
    // endpoint will not grow one mid-run.
    const cacheKey = `${this.baseUrl}|${model}`
    const hit = OpenAIProvider.probeCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 300_000) return hit.ctx
    const remember = (ctx: number | null): number | null => {
      OpenAIProvider.probeCache.set(cacheKey, { at: Date.now(), ctx })
      return ctx
    }

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
        if (max && Number(max) > 0) return remember(Number(max))
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
        if (ctx && Number(ctx) > 0) return remember(Number(ctx))
      }
    } catch { /* fall through */ }

    return remember(null)
  }

  /**
   * G32: per-model tool capability from LM Studio's enhanced listing
   * (/api/v0/models). Only entries that carry a `capabilities` array land in
   * the map — a generic OpenAI-compat backend (vLLM, llama.cpp server) 404s
   * or answers without the field, and an absent entry means "nobody said",
   * which keeps the optimistic default. LAN only, same rule as the context
   * probe: a cloud endpoint must not get an extra request per listing.
   */
  private async fetchLanCapabilities(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    const enhancedBase = this.baseUrl.replace(/\/v1\/?$/, '/api/v0')
    if (enhancedBase === this.baseUrl) return map
    try {
      const res = await localFetch(`${enhancedBase}/models`, { headers: this.headers } as any)
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
   * template, and a native `tools` payload is then accepted but IGNORED — no
   * refusal to learn from, the model just never sees a tool contract. false
   * means every model here needs the prompt transport; true means native is
   * fine; a 404 or a props answer without the field means nobody said, and
   * the optimistic default stands (vLLM and friends are untouched).
   */
  private async fetchServerToolCaps(): Promise<boolean | undefined> {
    const propsUrl = this.baseUrl.replace(/\/v1\/?$/, '') + '/props'
    try {
      const res = await localFetch(propsUrl, { headers: this.headers } as any)
      if (!res.ok) return undefined
      const data = await res.json()
      const flag = data?.chat_template_caps?.supports_tools
      return typeof flag === 'boolean' ? flag : undefined
    } catch {
      return undefined
    }
  }

  /** Probe results per endpoint+model (audit E5). Static, not an instance
   *  field: the lu-cloud provider builds a fresh delegate per call. */
  private static probeCache = new Map<string, { at: number; ctx: number | null }>()

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
  private static effortMemory = new Map<string, { on?: 'omit'; off?: 'minimal' | 'omit' }>()

  /** Live tool-capability answers per endpoint (G37b). Static for the same
   *  reason as probeCache, and TTL-bound like it: an LM Studio reload or an
   *  engine swap with a different template lands within 5 minutes. */
  private static toolCapsCache = new Map<string, { at: number; lanCaps: Map<string, string[]>; serverTools: boolean | undefined }>()

  /**
   * G37 (R21c, 2026-08-07): llama.cpp answers the tool question on /props,
   * server-wide. The bundled engine loads the GGUF's template WITHOUT tool
   * support and then silently ignores a native `tools` payload — the model
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
   * instead — so the run still put a native `tools` payload on 8127 and the
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
   * model's maximum, and hard-truncates any prompt beyond it — a run budgeted
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
    const lmStudioBase = this.baseUrl.replace(/\/v1\/?$/, '/api/v0')
    if (lmStudioBase === this.baseUrl) return remember(null)
    try {
      const res = await localFetch(
        `${lmStudioBase}/models/${encodeURIComponent(model)}`,
        { headers: this.headers } as any,
      )
      if (!res.ok) return remember(null)
      const data = await res.json()
      const loaded = data?.loaded_context_length
      if (loaded && Number(loaded) > 0) return remember(Number(loaded))
    } catch { /* not LM Studio — no enhanced API */ }
    return remember(null)
  }

  async getContextLength(model: string): Promise<number> {
    // Cascade:
    //   1. Server-declared context_length from the /models catalogue (LU
    //      Cloud) — authoritative for the deployment, beats every heuristic
    //   2. KNOWN_CONTEXT lookup (kein Network, instant)
    //   3. probeContextFromServer (LM Studio enhanced + generic /v1/models/<id>)
    //   4. Heuristik aus dem Modell-Namen
    //   5. Konservativer 8192er-Fallback (in guessContextFromName)
    const catalog = catalogContext.get(this.catalogKey(model))
    if (catalog && catalog > 0) return catalog
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

  private safeParseArgs(args: string): Record<string, any> {
    try {
      return JSON.parse(args)
    } catch {
      const repaired = repairJson(args)
      return repaired && typeof repaired === 'object' ? repaired : {}
    }
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
      const data = await res.json() as { error?: unknown; message?: string; code?: string }
      const err = data.error
      if (typeof data.code === 'string' && data.code.trim()) serverCode = data.code
      // OpenAI & most servers: { error: { message, code } }. But LM Studio and
      // llama.cpp commonly send a BARE string ({ error: "..." }) or a top-level
      // { message: "..." }. The old object-only read missed both → the real
      // reason (e.g. a context-window overflow) was swallowed and the user saw
      // the opaque "Request failed". Handle all three shapes.
      if (typeof err === 'string' && err.trim()) {
        message = err
        hasServerMessage = true
      } else if (err && typeof err === 'object') {
        const eo = err as { message?: string; code?: string }
        if (eo.message) {
          message = eo.message
          hasServerMessage = true
        }
        if (eo.code) code = eo.code
      } else if (typeof data.message === 'string' && data.message.trim()) {
        message = data.message
        hasServerMessage = true
      }
    } catch { /* non-JSON body → keep default */ }

    // Map HTTP status to error code. The canned texts are FALLBACKS for
    // opaque bodies only — a server that sends an honest message (LU Cloud:
    // "monthly credit budget exhausted", "LU Cloud is in closed beta (Max
    // plan only)", …) must surface it verbatim, not a wrong API-key /
    // wait-a-moment hint the user can't act on.
    if (res.status === 401 || res.status === 403) {
      code = 'auth'
      if (!hasServerMessage) message = `Invalid API key for ${this.config.name}. Check Settings > Providers.`
    } else if (res.status === 429) {
      code = 'rate_limit'
      if (!hasServerMessage) message = `Rate limited by ${this.config.name}. Wait a moment and try again.`
    } else if (res.status === 404) {
      code = 'not_found'
    }

    // A tool-augmented request rejected for the tools themselves. DeepInfra /
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
    else if (serverCode === 'credits_exhausted') {
      // Out of credits, top-up wallet empty (HTTP 429). Raise the global
      // signal so the "Load up your credits" dialog opens on top of the
      // honest error line already carried in `message`.
      code = 'credits_exhausted'
      signalCreditsExhausted()
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
    }

    return new ProviderError(message, 'openai', code, res.status, undefined, parseRetryAfter(res))
  }
}
