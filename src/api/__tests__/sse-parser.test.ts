/**
 * SSE Parser Tests
 *
 * Tests the Server-Sent Events parser used by OpenAI and Anthropic providers.
 * Run: npx vitest run src/api/__tests__/sse-parser.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  parseSSEStream, parseSSEJsonStream, parseSSEWithEvents, SSEMalformedDataError,
} from '../sse'

/**
 * Verengung auf den Fehler, den der Parser wirklich wirft.
 *
 * `let caught: any` hat drei Felder von einem Wert gelesen, ueber den nichts
 * feststand — und wenn nichts geworfen worden waere, haetten `caught.raw` &
 * Co. still `undefined` geliefert. Der `instanceof`-Test hier ist dieselbe
 * Pruefung wie das `toBeInstanceOf` daneben, nur so, dass TypeScript sie sieht.
 */
function asMalformed(e: unknown): SSEMalformedDataError {
  if (!(e instanceof SSEMalformedDataError)) {
    throw new Error(
      `expected an SSEMalformedDataError, got: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    )
  }
  return e
}

// Helper: create a Response from a string
function mockResponse(text: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream)
}

// Helper: create a Response that sends chunks one at a time
function mockChunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream)
}

describe('parseSSEStream', () => {
  it('parses basic SSE events', async () => {
    const res = mockResponse('data: {"content":"hello"}\n\ndata: {"content":"world"}\n\n')
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('{"content":"hello"}')
    expect(events[1].data).toBe('{"content":"world"}')
  })

  it('handles [DONE] sentinel', async () => {
    const res = mockResponse('data: {"content":"hi"}\n\ndata: [DONE]\n\n')
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
    expect(events[1].data).toBe('[DONE]')
  })

  it('parses event types (Anthropic format)', async () => {
    const res = mockResponse(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    )
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('content_block_delta')
    expect(events[1].event).toBe('message_stop')
  })

  it('handles empty lines and whitespace', async () => {
    const res = mockResponse('\n\ndata: {"a":1}\n\n\n\ndata: {"b":2}\n\n')
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
  })

  it('handles chunked delivery (split across boundaries)', async () => {
    const res = mockChunkedResponse([
      'data: {"con',
      'tent":"he',
      'llo"}\n\ndata: {"content":"world"}\n\n',
    ])
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('{"content":"hello"}')
  })

  // The spec allows CRLF and lone CR as terminators. Splitting on '\n\n' only
  // glued a CRLF stream into a single block whose JSON never parsed, so the
  // answer arrived silently empty.
  it('parses events separated by CRLF', async () => {
    const res = mockResponse('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\ndata: [DONE]\r\n\r\n')
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events.map(e => e.data)).toEqual(['{"a":1}', '{"a":2}', '[DONE]'])
  })

  it('parses events separated by lone CR', async () => {
    const res = mockResponse('data: {"a":1}\r\rdata: {"a":2}\r\r')
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events.map(e => e.data)).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('does not split an event when a CRLF straddles two reads', async () => {
    const res = mockChunkedResponse([
      'event: content_block_delta\r',
      '\ndata: {"a":1}\r\n\r\n',
    ])
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('content_block_delta')
    expect(events[0].data).toBe('{"a":1}')
  })

  // Regression fence for the idle-watchdog rework: the byte reader moved into
  // stream-idle.ts, and the terminator handling — CRLF, lone CR, a terminator
  // torn across two reads — has to come through it unchanged. Most SSE clients
  // get this wrong; this is the part that must not be lost.
  describe('line terminators survive the byte reader', () => {
    it('holds a lone CR that turns out to be a separator in the next read', async () => {
      const res = mockChunkedResponse(['data: {"a":1}\r', '\rdata: {"a":2}\r\r'])
      const events = []
      for await (const event of parseSSEStream(res)) {
        events.push(event)
      }
      expect(events.map(e => e.data)).toEqual(['{"a":1}', '{"a":2}'])
    })

    it('parses a CRLF stream delivered one byte at a time', async () => {
      const wire = 'data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n'
      const res = mockChunkedResponse(wire.split(''))
      const events = []
      for await (const event of parseSSEStream(res)) {
        events.push(event)
      }
      expect(events.map(e => e.data)).toEqual(['{"a":1}', '{"a":2}'])
    })

    it('keeps a multi-byte character whole across a read boundary', async () => {
      // '€' is three bytes; the decoder must still be streaming.
      const bytes = new TextEncoder().encode('data: {"t":"€"}\r\n\r\n')
      const res = new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes.slice(0, 12))
          c.enqueue(bytes.slice(12))
          c.close()
        },
      }))
      const events = []
      for await (const event of parseSSEStream(res)) {
        events.push(event)
      }
      expect(events.map(e => e.data)).toEqual(['{"t":"€"}'])
    })

    it('still flushes a trailing event that never got its terminator', async () => {
      const res = mockResponse('data: {"a":1}\r\n\r\ndata: {"a":2}')
      const events = []
      for await (const event of parseSSEStream(res)) {
        events.push(event)
      }
      expect(events.map(e => e.data)).toEqual(['{"a":1}', '{"a":2}'])
    })
  })

  it('ignores comment lines', async () => {
    const res = mockResponse(': this is a comment\ndata: {"a":1}\n\n')
    const events = []
    for await (const event of parseSSEStream(res)) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"a":1}')
  })
})

describe('parseSSEJsonStream', () => {
  it('yields parsed JSON objects', async () => {
    const res = mockResponse('data: {"id":1}\n\ndata: {"id":2}\n\ndata: [DONE]\n\n')
    const items = []
    for await (const item of parseSSEJsonStream<{ id: number }>(res)) {
      items.push(item)
    }
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe(1)
    expect(items[1].id).toBe(2)
  })

  // Was "skips malformed JSON". The skip WAS the bug: the payload that lands
  // here is a provider error object in an unexpected shape (a relay's HTML
  // error page, a gateway's bare string), and swallowing it left the user an
  // empty bubble with nothing to look at. Everything valid before it is still
  // delivered; the junk itself is now named.
  it('surfaces malformed JSON instead of swallowing it', async () => {
    const res = mockResponse('data: {"valid":true}\n\ndata: not-json\n\ndata: {"also":true}\n\n')
    const items: { valid?: boolean }[] = []
    let caught: unknown
    try {
      for await (const item of parseSSEJsonStream<{ valid?: boolean }>(res)) {
        items.push(item)
      }
    } catch (e) {
      caught = e
    }
    expect(items).toHaveLength(1)
    expect(items[0].valid).toBe(true)
    expect(caught).toBeInstanceOf(SSEMalformedDataError)
    const malformed = asMalformed(caught)
    expect(malformed.raw).toBe('not-json')
    expect(malformed.message).toContain('not-json')
  })

  it('names the event a malformed payload arrived under', async () => {
    const res = mockResponse('event: error\ndata: <html>502 Bad Gateway</html>\n\n')
    let caught: unknown
    try {
      for await (const _ of parseSSEJsonStream<unknown>(res)) { /* drain */ }
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SSEMalformedDataError)
    const malformed = asMalformed(caught)
    expect(malformed.event).toBe('error')
    expect(malformed.code).toBe('sse_malformed_data')
  })

  it('stops at [DONE]', async () => {
    const res = mockResponse('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n')
    const items = []
    for await (const item of parseSSEJsonStream<{ a?: number; b?: number }>(res)) {
      items.push(item)
    }
    expect(items).toHaveLength(1)
    // Und es ist die ERSTE, nicht irgendeine: `[DONE]` schneidet ab, es
    // ueberspringt nicht.
    expect(items[0].a).toBe(1)
  })
})

describe('parseSSEWithEvents', () => {
  it('yields event type alongside data', async () => {
    const res = mockResponse(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n'
    )
    const items = []
    for await (const item of parseSSEWithEvents<{ type?: string; delta?: { text?: string } }>(res)) {
      items.push(item)
    }
    expect(items).toHaveLength(2)
    expect(items[0].event).toBe('message_start')
    expect(items[1].event).toBe('content_block_delta')
    expect(items[1].data.delta?.text).toBe('hi')
  })
})
