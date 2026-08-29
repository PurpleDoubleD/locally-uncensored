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
import { normalizeSystemMessages } from './normalize-system'

// ── Ollama-specific types ──────────────────────────────────────

interface OllamaChatChunk {
  message?: { content: string; thinking?: string; tool_calls?: { function: { name: string; arguments: Record<string, any> } }[] }
  done?: boolean
  // Why generation ended ('stop' | 'length' | 'load' | …), final chunk only.
  done_reason?: string
  // Server-reported timing in the final done:true chunk (Bug M v2.4.7).
  // Ollama returns nanoseconds; we convert to ms before yielding upstream.
  eval_count?: number          // tokens the model produced
  eval_duration?: number       // generation phase in nanoseconds
  prompt_eval_count?: number   // tokens in the prompt (unused for tps)
  prompt_eval_duration?: number
  total_duration?: number
  load_duration?: number
}

interface OllamaModelEntry {
  name: string
  model: string
  size: number
  digest: string
  modified_at: string
  /** ['completion','tools','thinking','vision',...]. Ollama states this per
   *  model in /api/tags. Older servers omit it. */
  capabilities?: string[]
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
    // Bug B3: one system message, first, or Ollama's own template rendering
    // raises the same way llama.cpp's does. See providers/normalize-system.ts.
    const ollamaMessages = normalizeSystemMessages(messages).map(m => {
      const msg: Record<string, any> = { role: m.role, content: m.content }
      if (m.images?.length) msg.images = m.images.map(img => img.data)
      return msg
    })

    const body: Record<string, any> = {
      model,
      messages: ollamaMessages,
      stream: true,
      // Audit A6: match the agent transport so a long turn never pays a
      // cold multi-GB reload after Ollama's 5-minute default idle unload.
      keep_alive: '30m',
    }

    // v2.4.6 Bug L: dropped hardcoded `num_gpu: 99`. Old code forced ALL
    // layers onto the GPU on every chat request, which on 8 GB laptop cards
    // pushed the KV cache out into system RAM (nightmare13740 Discord
    // 2026-05-18: 30 tok/s in ollama CLI vs 6.9 tok/s in LU on RTX 4070
    // Laptop + gemma3:4b). Letting Ollama do its own VRAM-aware layer
    // placement restores CLI parity on tight cards and is a no-op on
    // cards with headroom.
    const ollamaOptions: Record<string, any> = {}
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP
    if (options?.topK !== undefined) ollamaOptions.top_k = options.topK
    if (options?.maxTokens && options.maxTokens > 0) ollamaOptions.num_predict = options.maxTokens
    // Bug AA v2.5.0 — forward user's context-window override. Without this
    // Ollama silently uses num_ctx=2048 (its default), which RAG payloads
    // and long-turn chats blow through immediately. Kj103x Discord
    // 2026-05-27: "LU caps VRAM ~5 GB regardless of context window UI
    // setting" — the UI setting was never wired here. Setting num_ctx
    // higher than the loaded model's max is harmless (Ollama clamps).
    // num_ctx comes from the caller (hook): the user override OR the model's
    // real context length (capped for VRAM safety). 0/undefined → Ollama keeps
    // its own default; the hook always passes a real value so a chat never
    // silently sits at Ollama's 2048 default.
    if (options?.contextWindow && options.contextWindow > 0) {
      ollamaOptions.num_ctx = options.contextWindow
    }
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
      throw await this.buildError(res, 'Chat failed', model)
    }

    for await (const chunk of parseNDJSONStream<OllamaChatChunk>(res)) {
      if (options?.signal?.aborted) break

      // Mid-stream `{"error":"..."}` line (runner crash, OOM) inside an
      // HTTP-200 stream — surface it instead of yielding a silent empty
      // chat turn (rikki Discord 2026-06-10, Win11 proxy path).
      const errLine = (chunk as { error?: unknown }).error
      if (typeof errLine === 'string' && errLine) {
        throw new Error(`Ollama: ${errLine}`)
      }

      const toolCalls: ToolCall[] | undefined = chunk.message?.tool_calls?.map(tc => ({
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }))

      yield {
        content: chunk.message?.content || '',
        thinking: chunk.message?.thinking || undefined,
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        done: chunk.done || false,
        finishReason: chunk.done_reason || undefined,
        // Bug M v2.4.7 — pass through server-side generation metrics so the
        // benchmark can report Ollama's own measurement instead of trusting
        // client-side TTFT, which WebView2 release-mode buffers into
        // uselessness for fast small models.
        evalCount: chunk.eval_count,
        promptEvalCount: chunk.prompt_eval_count,
        evalDurationMs: chunk.eval_duration !== undefined ? chunk.eval_duration / 1_000_000 : undefined,
      }
    }
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    // Bug B3: same invariant as chatStream, see providers/normalize-system.ts.
    const ollamaMessages = normalizeSystemMessages(messages).map(m => {
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
      // Audit A6: see chatStream above.
      keep_alive: '30m',
    }

    // v2.4.6 Bug L: see chatStream() above — same num_gpu:99 removal.
    const ollamaOptions: Record<string, any> = {}
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP
    if (options?.topK !== undefined) ollamaOptions.top_k = options.topK
    if (options?.maxTokens && options.maxTokens > 0) ollamaOptions.num_predict = options.maxTokens
    // Bug AA v2.5.0 — see chatStream() for the why.
    // num_ctx comes from the caller (hook): the user override OR the model's
    // real context length (capped for VRAM safety). 0/undefined → Ollama keeps
    // its own default; the hook always passes a real value so a chat never
    // silently sits at Ollama's 2048 default.
    if (options?.contextWindow && options.contextWindow > 0) {
      ollamaOptions.num_ctx = options.contextWindow
    }
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
      throw await this.buildError(res, 'Tool calling failed', model)
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
      // Ollama says per model whether it can call tools, and this dropped that
      // answer on the floor, so every Ollama model reached resolveToolSupport
      // with `undefined` and the decision fell through to the family-name list
      // in model-compatibility. That list matches on substrings, so a
      // completion-only build whose name merely contains a known family was
      // declared native and got a `tools` payload it cannot accept. Measured
      // 2026-08-06 on DESKTOP-D1TO33K: `hf.co/DevQuasar/huihui-ai.Qwen3-4B-
      // abliterated-GGUF:Q4_K_M` reports ['completion'] and was still routed
      // native, purely because the name contains 'qwen3'.
      //
      // The server's own answer wins; the heuristic stays as the fallback for
      // an older Ollama that says nothing, which is why this is `undefined`
      // and not `true` when the field is absent. openai-provider.ts already
      // works exactly this way.
      supportsTools: Array.isArray(m.capabilities) ? m.capabilities.includes('tools') : undefined,
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
    // Bug K: dieselbe Cascade-Logik wie in src/api/ollama.ts::getModelContext.
    // Vorher hat dieser Provider NUR `general.context_length` gecheckt — aber
    // viele Ollama-Modelle (z.B. qwen2.5:*, llama3.x:*) lassen das leer und
    // setzen stattdessen architecture-specific keys wie `qwen2.context_length`
    // oder `llama.context_length`. Mit dem alten Code zeigte LU 4096 obwohl
    // Modelle real 32K-128K koennen. Live-verified auf Arch 2026-05-17 gegen
    // pacman-ollama 0.23.2 + qwen2.5:0.5b (general.context_length=None,
    // qwen2.context_length=32768).
    try {
      const res = await localFetch(this.apiUrl('/show'), {
        method: 'POST',
        body: JSON.stringify({ name: model }),
      })
      if (!res.ok) return 4096
      const info = await res.json()

      // 1. model_info: prefer `general.context_length`, then architecture-specific
      //    `.context_length` keys (gemma2.context_length, qwen2.context_length, etc.)
      const modelInfo = info?.model_info || {}
      const contextFromInfo =
        modelInfo['general.context_length'] ||
        Object.entries(modelInfo).find(([k]) => k.endsWith('.context_length'))?.[1]
      if (contextFromInfo && Number(contextFromInfo) > 0) {
        return Number(contextFromInfo)
      }

      // 2. parameters: can be an object with `num_ctx`, or a Modelfile-style string
      //    like "num_ctx 8192\nstop ..."
      const params = info?.parameters
      if (params) {
        if (typeof params === 'object' && params.num_ctx) {
          return Number(params.num_ctx)
        }
        if (typeof params === 'string') {
          const match = params.match(/num_ctx\s+(\d+)/)
          if (match) return Number(match[1])
        }
      }

      return 4096
    } catch {
      return 4096
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Classify a non-ok Ollama response and wrap it in `ProviderError`. The
   * resulting error carries:
   *   - `code` — one of `ollama_missing_blob`, `ollama_stale_manifest`,
   *     or generic `network` so UI catch sites can branch (and feed the
   *     model-health store via lib/sync-ollama-health.ts) without
   *     re-parsing the message.
   *   - `model` — threaded through from chatStream/chatWithTools so the
   *     UI can name the affected model in a one-click "ollama pull <model>"
   *     repair flow. Missing-blob errors only carry the on-disk blob hash,
   *     not the model name, so we pass `model` into parseOllamaError as the
   *     fallback (Bug C) — that populates `parsed.model`, which
   *     chatStyleMessage then uses for the user-facing wording.
   *
   * Pure function: no store side-effects, no UI imports. The caller
   * (useChat via syncOllamaHealthFromError) translates the error code into
   * a store update.
   *
   * Shares the detection logic with loadModel / unloadModel via
   * ollama-errors. The regex there matches chat, completion, AND generate
   * (the Lichtschalter path uses /api/generate with an empty prompt for
   * preload — same error class).
   */
  private async buildError(res: Response, fallback: string, model?: string): Promise<ProviderError> {
    const status = res.status
    try {
      const { parseOllamaError, chatStyleMessage } = await import('../../lib/ollama-errors')
      const parsed = await parseOllamaError(res, fallback, model)
      const message = chatStyleMessage(parsed)
      let code = 'network'
      if (parsed.kind === 'missing-blob') code = 'ollama_missing_blob'
      else if (parsed.kind === 'stale-manifest') code = 'ollama_stale_manifest'
      // Prefer the parsed model name (e.g. from a stale-manifest string that
      // carries it) and fall back to the request's model arg.
      return new ProviderError(message, 'ollama', code, status, parsed.model || model)
    } catch {
      return new ProviderError(fallback, 'ollama', 'network', status, model)
    }
  }
}
