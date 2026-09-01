import type { ChatMessage, ToolCall, ToolDefinition } from '../api/providers/types'
import { ollamaUrl, localFetchStream } from '../api/backend'
import { repairToolCallArgs } from './tool-call-repair'
import { applyTemplateContract } from '../api/providers/normalize-system'
import { parseOllamaChatChunk, type OllamaWireToolCall } from '../api/providers/wire'

/** One entry of the `messages` array as Ollama's /api/chat wants it. */
interface OllamaRequestMessage {
  role: ChatMessage['role']
  content: string
  tool_calls?: ToolCall[]
  /** Bare base64 payloads — Ollama takes no mime type here. */
  images?: string[]
}

/** The POST body this module sends. `think` is deleted again on the 400 retry. */
interface OllamaChatRequest {
  model: string
  messages: OllamaRequestMessage[]
  tools: ToolDefinition[]
  stream: boolean
  keep_alive: string
  options: { temperature?: number; num_predict?: number; num_ctx?: number }
  think?: boolean
}

/** An Error carrying the HTTP status, which the caller's retry logic reads. */
export interface HttpStatusError extends Error {
  statusCode: number
}

/**
 * Streaming Ollama `/api/chat` call with native `tools` support.
 *
 * Originally lived inline in `useCodex.ts` — extracted so the regular
 * Agent path (`useAgentChat.ts`) can share the exact same wire protocol
 * + chunk-state-machine + arg-repair logic. Without this hook, Agent
 * Mode used the non-streaming provider call → UI froze for 30-90 s
 * while the model thought, no live tokens, no live tool-call hint.
 *
 * Behaviour notes:
 *  - Uses `localFetchStream` (Tauri-aware) so Tauri WebView can hit
 *    localhost:11434 via the Rust proxy when the direct fetch fails.
 *  - Falls back to retry-without-`think` on HTTP 400 (old Ollama
 *    builds reject the field).
 *  - `tool_calls` chunks may arrive split across multiple NDJSON
 *    lines — appends instead of overwriting.
 *  - `repairToolCallArgs` handles the case where Ollama emits the
 *    arguments object as a JSON-stringified blob instead of a real
 *    object (the bug behind "file_write needs argument" on small
 *    models).
 */
export async function streamOllamaChatWithTools(
  modelId: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options: { temperature?: number; thinking?: boolean; maxTokens?: number; contextWindow?: number; signal?: AbortSignal },
  onContent: (content: string) => void,
  onThinking: (thinking: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[]; thinking: string; promptEvalCount: number; evalCount: number }> {
  // Bug B3: this path talks to /api/chat behind the provider's back, so it
  // needs the same contract. It always sends a native `tools` payload (the
  // strategy resolution only routes here after Ollama reported the model's
  // `tools` capability), so the tool channel stays native and only the
  // system-first rule is enforced.
  const ollamaMessages = applyTemplateContract(messages, {
    toolRole: 'native',
    alternate: false,
  }).map((m): OllamaRequestMessage => {
    const msg: OllamaRequestMessage = { role: m.role, content: m.content }
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    if (m.images?.length) msg.images = m.images.map((img) => img.data)
    return msg
  })

  // v2.4.6 Bug L: dropped hardcoded `num_gpu: 99` — see src/api/ollama.ts
  // for the full rationale. Ollama now decides layer placement itself,
  // which restores CLI parity on 8 GB laptop cards.
  const body: OllamaChatRequest = {
    model: modelId,
    messages: ollamaMessages,
    tools,
    stream: true,
    // Audit A6: without this Ollama unloads the model after its 5-minute
    // default idle. An agent step that runs a 10-minute build came back to a
    // cold model and paid a multi-GB reload before the next thought — several
    // times per long session. 30m matches the warm-up call in api/ollama.ts.
    keep_alive: '30m',
    options: {},
  }
  if (options.temperature !== undefined) body.options.temperature = options.temperature
  if (options.maxTokens) body.options.num_predict = options.maxTokens
  // Bug AA v2.5.0 — forward num_ctx override (0/undefined = use Ollama default).
  if (options.contextWindow && options.contextWindow > 0) {
    body.options.num_ctx = options.contextWindow
  }
  if (options.thinking === true) body.think = true
  else if (options.thinking === false) body.think = false

  const url = ollamaUrl('/chat')
  let response: Response
  try {
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (fetchErr) {
    throw fetchErr
  }

  if (!response.ok && response.status === 400 && 'think' in body) {
    delete body.think
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  }

  if (!response.ok) {
    const text = await response.text()
    const err: HttpStatusError = Object.assign(new Error(`HTTP ${response.status}: ${text}`), {
      statusCode: response.status,
    })
    throw err
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let thinking = ''
  let toolCalls: ToolCall[] = []
  // Audit F1: some servers repeat the FULL tool_calls array in a later chunk
  // (and the tail-buffer pass could append the same calls once more). Without
  // this, the identical call ran twice. Byte-identical name+args within one
  // turn is never two intended calls — that is what the repeat guard and the
  // in-turn cache treat as one call too.
  const seenCalls = new Set<string>()
  // Every entry is checked before it is read. Ollama's own builds always wrap
  // the call in `function`, but this endpoint is also answered by llama.cpp
  // servers and the Rust proxy, and an entry WITHOUT that wrapper used to make
  // `tc.function.arguments` throw a TypeError. The throw happened inside the
  // NDJSON loop, past the try that only covers JSON.parse, so it escaped the
  // whole stream call: the agent turn died with "Cannot read properties of
  // undefined (reading 'arguments')" and every token the model had already
  // streamed was thrown away. A nameless call cannot be executed either, so it
  // is skipped rather than pushed on as `undefined`.
  const appendCalls = (raw: OllamaWireToolCall[]) => {
    for (const tc of raw) {
      const name = tc.function?.name
      if (!name) continue
      const repaired = repairToolCallArgs(tc.function?.arguments)
      const key = `${name}|${JSON.stringify(repaired)}`
      if (seenCalls.has(key)) continue
      seenCalls.add(key)
      toolCalls = [...toolCalls, { function: { name, arguments: repaired } }]
    }
  }
  // Real token usage from the final Ollama chunk (top-level, not in `message`).
  // prompt_eval_count is the FULL consumed context (system + tools + RAG +
  // history) for THIS turn — the agent/code loop stores the latest so the
  // TokenCounter shows 100% real usage instead of a char/4 estimate.
  let promptEvalCount = 0
  let evalCount = 0

  // No-bytes watchdog (audit A7): a wedged runner behind a live connection
  // ends neither with data nor an error, and read() sat forever. Five silent
  // minutes is a dead stream — thinking models still produce deltas.
  const IDLE_TIMEOUT_MS = 300_000
  while (true) {
    if (options.signal?.aborted) {
      try { await reader.cancel() } catch { /* noop */ }
      break
    }
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let done: boolean, value: Uint8Array | undefined
    try {
      ;({ done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(`Ollama stream stalled: no data received for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s.`)),
            IDLE_TIMEOUT_MS,
          )
        }),
      ]))
    } catch (err) {
      try { await reader.cancel() } catch { /* noop */ }
      throw err
    } finally {
      clearTimeout(idleTimer)
    }
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Parse and process are separated on purpose: the catch only covers the
      // JSON.parse (partial lines are normal in a chunked stream), while a
      // real `{"error":...}` line must THROW past it.
      let raw: unknown
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue // partial JSON line — skip
      }
      const j = parseOllamaChatChunk(raw)
      // Ollama reports mid-stream failures (runner crash, OOM, context
      // overflow on some builds) as an NDJSON line `{"error":"..."}` inside
      // an HTTP-200 stream. Swallowing it produced an EMPTY turn — the agent
      // loop then surfaced a bare "Agent error" with zero context (rikki
      // Discord 2026-06-10). Throw so the caller's retry/classify logic runs.
      if (j.error) {
        throw new Error(`Ollama: ${j.error}`)
      }
      if (j.message) {
        if (j.message.content) {
          content += j.message.content
          onContent(content)
        }
        if (j.message.thinking) {
          thinking += j.message.thinking
          onThinking(thinking)
        }
        if (j.message.tool_calls) {
          appendCalls(j.message.tool_calls)
        }
      }
      if (j.prompt_eval_count !== undefined) promptEvalCount = j.prompt_eval_count
      if (j.eval_count !== undefined) evalCount = j.eval_count
    }
  }

  if (buf.trim()) {
    let raw: unknown
    let ok = true
    try {
      raw = JSON.parse(buf.trim())
    } catch {
      ok = false // ignore tail-buffer parse errors
    }
    if (ok) {
      const j = parseOllamaChatChunk(raw)
      if (j.error) {
        throw new Error(`Ollama: ${j.error}`)
      }
      if (j.message?.tool_calls) {
        appendCalls(j.message.tool_calls)
      }
      if (j.message?.content) {
        content += j.message.content
        onContent(content)
      }
      if (j.message?.thinking) {
        thinking += j.message.thinking
        onThinking(thinking)
      }
      if (j.prompt_eval_count !== undefined) promptEvalCount = j.prompt_eval_count
      if (j.eval_count !== undefined) evalCount = j.eval_count
    }
  }

  return { content, toolCalls, thinking, promptEvalCount, evalCount }
}
