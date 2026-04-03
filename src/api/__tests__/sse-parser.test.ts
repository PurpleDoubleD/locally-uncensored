/**
 * SSE Parser Tests
 *
 * Tests the Server-Sent Events parser used by OpenAI and Anthropic providers.
 * Run: npx vitest run src/api/__tests__/sse-parser.test.ts
 */
import { describe, it, expect } from 'vitest'
import { parseSSEStream, parseSSEJsonStream, parseSSEWithEvents } from '../sse'

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

  it('skips malformed JSON', async () => {
    const res = mockResponse('data: {"valid":true}\n\ndata: not-json\n\ndata: {"also":true}\n\n')
    const items = []
    for await (const item of parseSSEJsonStream<any>(res)) {
      items.push(item)
    }
    expect(items).toHaveLength(2)
    expect(items[0].valid).toBe(true)
    expect(items[1].also).toBe(true)
  })

  it('stops at [DONE]', async () => {
    const res = mockResponse('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n')
    const items = []
    for await (const item of parseSSEJsonStream<any>(res)) {
      items.push(item)
    }
    expect(items).toHaveLength(1)
  })
})

describe('parseSSEWithEvents', () => {
  it('yields event type alongside data', async () => {
    const res = mockResponse(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n'
    )
    const items = []
    for await (const item of parseSSEWithEvents<any>(res)) {
      items.push(item)
    }
    expect(items).toHaveLength(2)
    expect(items[0].event).toBe('message_start')
    expect(items[1].event).toBe('content_block_delta')
    expect(items[1].data.delta.text).toBe('hi')
  })
})
