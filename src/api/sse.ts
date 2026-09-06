/**
 * SSE (Server-Sent Events) Stream Parser
 *
 * Parses the `data: {...}\n\n` format used by OpenAI and Anthropic APIs.
 * Companion to stream.ts which handles Ollama's NDJSON format.
 *
 * Format:
 *   data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n
 *   data: [DONE]\n\n
 *
 * Anthropic also uses event types:
 *   event: content_block_delta\n
 *   data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n
 */

import {
  readChunks, STREAM_IDLE_TIMEOUT_MS, type StreamIdleOptions,
} from './stream-idle'

export type { StreamIdleOptions }

export interface SSEEvent {
  event?: string   // e.g. "content_block_delta", "message_stop"
  data: string     // raw JSON string (or "[DONE]")
}

/**
 * A `data:` line that is not JSON.
 *
 * It used to be swallowed without a trace, and the shape that hits this is
 * precisely a provider error object in an unexpected form — a relay that
 * answers with an HTML error page, a gateway that writes a bare string. The
 * user got an empty bubble and there was nothing to look at. Structured and
 * thrown beats silent: the chat layer already renders a thrown error.
 */
export class SSEMalformedDataError extends Error {
  readonly code = 'sse_malformed_data'
  /** The offending payload, truncated — enough to recognise, not enough to
   *  paste a whole HTML page into a chat bubble. */
  readonly raw: string
  /** The `event:` field it arrived under, when the server sent one. */
  readonly event?: string

  constructor(raw: string, event?: string) {
    const shown = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
    super(
      `Stream sent data that is not JSON${event ? ` (event: ${event})` : ''}: ${shown}`,
    )
    this.name = 'SSEMalformedDataError'
    this.raw = raw
    this.event = event
  }
}

/**
 * Parse an SSE stream into individual events.
 * Handles multi-line data fields, event types, and the [DONE] sentinel.
 */
/** One `event:`/`data:` block into an SSEEvent, or null if it carries no data. */
function parseEventBlock(block: string): SSEEvent | null {
  const trimmed = block.trim()
  if (!trimmed) return null

  let event: string | undefined
  let data = ''

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      // Accumulate data lines (multi-line data support)
      if (data) data += '\n'
      data += line.slice(5).trim()
    }
    // Ignore other fields (id:, retry:, comments starting with :)
  }

  return data ? { event, data } : null
}

/** JSON out of one event's data, or a named error instead of silence. */
function parseEventJson<T>(event: SSEEvent): T {
  try {
    return JSON.parse(event.data) as T
  } catch {
    throw new SSEMalformedDataError(event.data, event.event)
  }
}

/**
 * `opts` reaches the idle watchdog in stream-idle.ts. The budget defaults to
 * ON here because every SSE stream in this app is a chat completion, i.e. the
 * exact surface where an endless silent read strands the user; pass
 * `{ idleMs: 0 }` to opt out.
 */
export async function* parseSSEStream(
  response: Response,
  opts?: StreamIdleOptions,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const value of readChunks(response, {
    idleMs: opts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS,
    firstChunkMs: opts?.firstChunkMs,
    onIdle: opts?.onIdle,
  })) {
    buffer += decoder.decode(value, { stream: true })

    // The SSE spec allows CRLF and lone CR as line terminators, and some
    // servers and proxies use them. Splitting on '\n\n' alone glued every
    // event of such a stream into one block whose JSON never parsed — the
    // whole answer came back silently empty.
    // A trailing '\r' may be the first half of a CRLF split across two reads,
    // so it waits in the buffer until we can see what follows it.
    const carry = buffer.endsWith('\r') ? '\r' : ''
    const normalized = (carry ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n')

    // SSE events are separated by double newline
    const parts = normalized.split('\n\n')
    buffer = (parts.pop() || '') + carry

    for (const part of parts) {
      const parsed = parseEventBlock(part)
      if (parsed) yield parsed
    }
  }

  // Process any remaining buffer
  const tail = parseEventBlock(buffer.replace(/\r\n?/g, '\n'))
  if (tail) yield tail
}

/**
 * Parse SSE stream and yield parsed JSON objects, skipping [DONE].
 */
export async function* parseSSEJsonStream<T>(
  response: Response,
  opts?: StreamIdleOptions,
): AsyncGenerator<T> {
  for await (const event of parseSSEStream(response, opts)) {
    if (event.data === '[DONE]') return
    yield parseEventJson<T>(event)
  }
}

/**
 * Parse SSE stream with event types (Anthropic format).
 * Yields both the event type and parsed data.
 */
export async function* parseSSEWithEvents<T>(
  response: Response,
  opts?: StreamIdleOptions,
): AsyncGenerator<{ event?: string; data: T }> {
  for await (const event of parseSSEStream(response, opts)) {
    if (event.data === '[DONE]') return
    yield { event: event.event, data: parseEventJson<T>(event) }
  }
}
