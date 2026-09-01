/**
 * Wire shapes and boundary guards for the three foreign HTTP APIs the
 * providers talk to (Ollama, OpenAI-compatible, Anthropic).
 *
 * Everything in here describes data we did NOT produce. `res.json()` hands
 * back `unknown`; the helpers below are the only sanctioned way to walk into
 * it. They check before they claim: `isRecord` before a property read,
 * `Array.isArray` before an iteration, `typeof` before a string/number is
 * handed on. That is the difference between "the server said so" and "we
 * assumed so and it happened to hold".
 *
 * Deliberately dependency-free (no zod, no imports from the providers) so it
 * stays a leaf module and cannot participate in an import cycle.
 */

// ── Primitive accessors ────────────────────────────────────────

/** True for a plain object we may index. Arrays and null are rejected. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read a property without asserting anything about the container. */
export function prop(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined
}

/** Follow a property path, giving up (undefined) at the first non-record. */
export function propPath(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v
  for (const k of keys) {
    if (!isRecord(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** Array of records, or [] — the shape every "list" endpoint claims to send. */
export function asRecordArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : []
}

/** Array of strings, or [] — e.g. Ollama's `capabilities`. */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// ── Streamed tool-call accumulators ────────────────────────────

/**
 * Which accumulator slot a streamed tool-call block belongs to when the server
 * left out the `index` that is supposed to identify it.
 *
 * Both streaming protocols in this file number their tool-call blocks, and
 * both are served by things that do not: OpenAI-compatible servers omit
 * `index` on a tool_call delta, Anthropic-compatible proxies (LiteLLM,
 * claude-relay-server) omit it on `content_block_start`. The rule is the same
 * on both, which is why this lives here and not twice in two providers:
 *
 *   an event carrying an id  → the slot already holding that id, else a new one
 *   an event carrying none   → the slot currently being filled
 *
 * It maps onto both wire formats because both put the id on the event that
 * OPENS a call and leave it off the ones that continue it — OpenAI on the
 * first delta, Anthropic on `content_block_start`.
 *
 * Reading a missing index as an assertion instead was a real outage on both
 * sides: `set(undefined)` opened a block under a key no lookup would ever
 * produce, and the whole tool call went out with `{}` arguments.
 *
 * Limit, and the same one on both providers: a stream that omits BOTH the
 * index and the id can only be read as one call at a time. A second block
 * opened that way continues the first instead of starting its own.
 */
export function keyForUnindexedBlock<T extends { id: string }>(
  accum: ReadonlyMap<number, T>,
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

// ── Ollama: /api/chat ──────────────────────────────────────────

/**
 * A tool call as Ollama emits it. `arguments` arrives as an already-parsed
 * object (unlike OpenAI, which sends a JSON string), so it is only ever
 * `unknown` until a caller decides what it wants from it.
 */
export interface OllamaWireToolCall {
  function?: {
    name?: string
    arguments?: unknown
  }
}

/** One NDJSON line of Ollama's streaming `/api/chat` response. */
export interface OllamaChatChunk {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: OllamaWireToolCall[]
  }
  done?: boolean
  done_reason?: string
  eval_count?: number
  prompt_eval_count?: number
  eval_duration?: number
  error?: string
}

/** Parse one NDJSON line into the fields we actually read, checking each. */
export function parseOllamaChatChunk(raw: unknown): OllamaChatChunk {
  const msg = prop(raw, 'message')
  const toolCalls = prop(msg, 'tool_calls')
  return {
    message: isRecord(msg)
      ? {
          content: asString(msg.content),
          thinking: asString(msg.thinking),
          tool_calls: Array.isArray(toolCalls)
            ? toolCalls.filter(isRecord).map((tc): OllamaWireToolCall => {
                const fn = prop(tc, 'function')
                return isRecord(fn)
                  ? { function: { name: asString(fn.name), arguments: fn.arguments } }
                  : {}
              })
            : undefined,
        }
      : undefined,
    done: asBoolean(prop(raw, 'done')),
    done_reason: asString(prop(raw, 'done_reason')),
    eval_count: asNumber(prop(raw, 'eval_count')),
    prompt_eval_count: asNumber(prop(raw, 'prompt_eval_count')),
    eval_duration: asNumber(prop(raw, 'eval_duration')),
    error: asString(prop(raw, 'error')),
  }
}

// ── OpenAI-compatible: /v1/chat/completions ────────────────────

/**
 * One tool-call delta of an OpenAI SSE stream. Every field is optional on
 * purpose: the protocol splits a single call across many chunks — the first
 * carries `id`/`function.name`, the rest only append to
 * `function.arguments`, and `index` is the only thing tying them together.
 */
export interface OpenAIToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: {
    name?: string
    /** JSON *text*, streamed in fragments. Never an object. */
    arguments?: string
  }
}

/** The non-streaming form: `arguments` is complete JSON text. */
export interface OpenAIToolCall {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** `choices[].delta` of a streaming chunk. */
export interface OpenAIStreamDelta {
  role?: string
  content?: string
  /** Non-standard but widely used: DeepSeek/vLLM/LM Studio reasoning output. */
  reasoning_content?: string
  /** OpenRouter's spelling of the same thing. */
  reasoning?: string
  tool_calls?: OpenAIToolCallDelta[]
}

export interface OpenAIStreamChunk {
  choices?: {
    delta?: OpenAIStreamDelta
    finish_reason?: string | null
  }[]
  usage?: OpenAIUsage
  error?: unknown
}

function parseToolCallDeltas(v: unknown): OpenAIToolCallDelta[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter(isRecord).map((tc): OpenAIToolCallDelta => {
    const fn = prop(tc, 'function')
    return {
      index: asNumber(tc.index),
      id: asString(tc.id),
      type: asString(tc.type),
      function: isRecord(fn)
        ? { name: asString(fn.name), arguments: asString(fn.arguments) }
        : undefined,
    }
  })
}

/** Parse one `data:` payload of an OpenAI-compatible SSE stream. */
export function parseOpenAIStreamChunk(raw: unknown): OpenAIStreamChunk {
  const choices = prop(raw, 'choices')
  const usage = prop(raw, 'usage')
  return {
    choices: Array.isArray(choices)
      ? choices.filter(isRecord).map((c) => {
          const delta = prop(c, 'delta')
          const finish = c.finish_reason
          return {
            delta: isRecord(delta)
              ? {
                  role: asString(delta.role),
                  content: asString(delta.content),
                  reasoning_content: asString(delta.reasoning_content),
                  reasoning: asString(delta.reasoning),
                  tool_calls: parseToolCallDeltas(delta.tool_calls),
                }
              : undefined,
            finish_reason: typeof finish === 'string' ? finish : null,
          }
        })
      : undefined,
    usage: isRecord(usage)
      ? {
          prompt_tokens: asNumber(usage.prompt_tokens),
          completion_tokens: asNumber(usage.completion_tokens),
          total_tokens: asNumber(usage.total_tokens),
        }
      : undefined,
    error: prop(raw, 'error'),
  }
}

/** `choices[0].message` of a non-streaming completion. */
export interface OpenAIResponseMessage {
  content?: string
  reasoning_content?: string
  reasoning?: string
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIChatResponse {
  message?: OpenAIResponseMessage
  finish_reason?: string
  usage?: OpenAIUsage
}

/** Parse a non-streaming `/v1/chat/completions` body. */
export function parseOpenAIChatResponse(raw: unknown): OpenAIChatResponse {
  const choice = asRecordArray(prop(raw, 'choices'))[0]
  const message = prop(choice, 'message')
  const usage = prop(raw, 'usage')
  const toolCalls = prop(message, 'tool_calls')
  return {
    message: isRecord(message)
      ? {
          content: asString(message.content),
          reasoning_content: asString(message.reasoning_content),
          reasoning: asString(message.reasoning),
          tool_calls: Array.isArray(toolCalls)
            ? toolCalls.filter(isRecord).map((tc): OpenAIToolCall => {
                const fn = prop(tc, 'function')
                return {
                  id: asString(tc.id),
                  type: asString(tc.type),
                  function: isRecord(fn)
                    ? { name: asString(fn.name), arguments: asString(fn.arguments) }
                    : undefined,
                }
              })
            : undefined,
        }
      : undefined,
    finish_reason: asString(prop(choice, 'finish_reason')),
    usage: isRecord(usage)
      ? {
          prompt_tokens: asNumber(usage.prompt_tokens),
          completion_tokens: asNumber(usage.completion_tokens),
          total_tokens: asNumber(usage.total_tokens),
        }
      : undefined,
  }
}

// ── Anthropic: /v1/messages ────────────────────────────────────

/**
 * One SSE event of Anthropic's streaming Messages API. The interesting
 * fields live at three different depths depending on `type`, which is why
 * this stays a flat optional bag rather than a discriminated union: the
 * provider reads them defensively and a new event type must not throw.
 */
export interface AnthropicStreamEvent {
  type?: string
  index?: number
  /** `content_block_start` — the block being opened. */
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  /** `content_block_delta` — the payload appended to that block. */
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  /** `message_start` carries input tokens, `message_delta` the output count. */
  message?: {
    usage?: AnthropicUsage
  }
  usage?: AnthropicUsage
  error?: {
    type?: string
    message?: string
  }
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

function parseAnthropicUsage(v: unknown): AnthropicUsage | undefined {
  if (!isRecord(v)) return undefined
  return {
    input_tokens: asNumber(v.input_tokens),
    output_tokens: asNumber(v.output_tokens),
  }
}

/** Parse one `data:` payload of an Anthropic SSE stream. */
export function parseAnthropicStreamEvent(raw: unknown): AnthropicStreamEvent {
  const block = prop(raw, 'content_block')
  const delta = prop(raw, 'delta')
  const message = prop(raw, 'message')
  const error = prop(raw, 'error')
  return {
    type: asString(prop(raw, 'type')),
    index: asNumber(prop(raw, 'index')),
    content_block: isRecord(block)
      ? { type: asString(block.type), id: asString(block.id), name: asString(block.name) }
      : undefined,
    delta: isRecord(delta)
      ? {
          type: asString(delta.type),
          text: asString(delta.text),
          thinking: asString(delta.thinking),
          partial_json: asString(delta.partial_json),
          stop_reason: asString(delta.stop_reason),
        }
      : undefined,
    message: isRecord(message)
      ? { usage: parseAnthropicUsage(message.usage) }
      : undefined,
    usage: parseAnthropicUsage(prop(raw, 'usage')),
    error: isRecord(error)
      ? { type: asString(error.type), message: asString(error.message) }
      : undefined,
  }
}

/** One entry of a non-streaming `/v1/messages` `content` array. */
export interface AnthropicContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
}

export interface AnthropicMessageResponse {
  content: AnthropicContentBlock[]
  stop_reason?: string
  usage?: AnthropicUsage
}

/** Parse a non-streaming `/v1/messages` body. */
export function parseAnthropicMessageResponse(raw: unknown): AnthropicMessageResponse {
  return {
    content: asRecordArray(prop(raw, 'content')).map((b): AnthropicContentBlock => ({
      type: asString(b.type),
      text: asString(b.text),
      thinking: asString(b.thinking),
      id: asString(b.id),
      name: asString(b.name),
      input: b.input,
    })),
    stop_reason: asString(prop(raw, 'stop_reason')),
    usage: parseAnthropicUsage(prop(raw, 'usage')),
  }
}
