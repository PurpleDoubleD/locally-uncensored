/**
 * Stream Parser Tests
 *
 * Tests parseNDJSONStream() from stream.ts:
 * - Valid NDJSON parsing
 * - Empty lines skipped
 * - Malformed lines skipped
 * - Buffer handling for partial lines
 * - Error handling
 *
 * Run: npx vitest run src/api/__tests__/stream-parser.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { parseNDJSONStream } from '../stream'

// ── Helpers ────────────────────────────────────────────────────

/** Create a mock Response from an array of string chunks */
function mockResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let index = 0

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
  })

  return new Response(stream)
}

/** Create a Response with no body */
function emptyBodyResponse(): Response {
  return { body: null } as unknown as Response
}

/** Collect all values from an async generator */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) {
    items.push(item)
  }
  return items
}

describe('stream-parser', () => {
  describe('parseNDJSONStream', () => {
    it('parses multiple NDJSON lines from a single chunk', async () => {
      const response = mockResponse([
        '{"message":"hello"}\n{"message":"world"}\n',
      ])
      const results = await collect(parseNDJSONStream<{ message: string }>(response))
      expect(results).toEqual([
        { message: 'hello' },
        { message: 'world' },
      ])
    })

    it('parses a single NDJSON line', async () => {
      const response = mockResponse(['{"value":42}\n'])
      const results = await collect(parseNDJSONStream<{ value: number }>(response))
      expect(results).toEqual([{ value: 42 }])
    })

    it('handles data split across multiple chunks', async () => {
      // Split a JSON line across two chunks
      const response = mockResponse([
        '{"mess',
        'age":"split"}\n',
      ])
      const results = await collect(parseNDJSONStream<{ message: string }>(response))
      expect(results).toEqual([{ message: 'split' }])
    })

    it('handles multiple lines split across multiple chunks', async () => {
      const response = mockResponse([
        '{"a":1}\n{"b":',
        '2}\n{"c":3}\n',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    })

    it('skips empty lines between data', async () => {
      const response = mockResponse([
        '{"a":1}\n\n\n{"b":2}\n',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ a: 1 }, { b: 2 }])
    })

    it('skips whitespace-only lines', async () => {
      const response = mockResponse([
        '{"a":1}\n   \n{"b":2}\n',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ a: 1 }, { b: 2 }])
    })

    it('skips malformed JSON lines', async () => {
      const response = mockResponse([
        '{"valid":true}\nnot json\n{"also":true}\n',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ valid: true }, { also: true }])
    })

    it('handles final line without trailing newline (buffer flush)', async () => {
      const response = mockResponse([
        '{"a":1}\n{"b":2}',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ a: 1 }, { b: 2 }])
    })

    it('handles only a buffer remainder (no newlines)', async () => {
      const response = mockResponse(['{"single":true}'])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ single: true }])
    })

    it('returns empty array for empty stream', async () => {
      const response = mockResponse([''])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([])
    })

    it('returns empty array for stream with only empty lines', async () => {
      const response = mockResponse(['\n\n\n'])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([])
    })

    it('throws when response has no body', async () => {
      const response = emptyBodyResponse()
      await expect(collect(parseNDJSONStream(response))).rejects.toThrow('No response body')
    })

    it('handles boolean and null JSON values', async () => {
      const response = mockResponse([
        'true\n42\nnull\n"hello"\n',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([true, 42, null, 'hello'])
    })

    it('handles nested JSON objects', async () => {
      const response = mockResponse([
        '{"user":{"name":"test","settings":{"theme":"dark"}}}\n',
      ])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([
        { user: { name: 'test', settings: { theme: 'dark' } } },
      ])
    })

    it('handles arrays as NDJSON lines', async () => {
      const response = mockResponse(['[1,2,3]\n[4,5]\n'])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([[1, 2, 3], [4, 5]])
    })

    it('skips malformed final buffer line', async () => {
      const response = mockResponse([
        '{"valid":1}\nbroken',
      ])
      const results = await collect(parseNDJSONStream(response))
      // "broken" in buffer is malformed, should be skipped
      expect(results).toEqual([{ valid: 1 }])
    })

    it('handles many small chunks correctly', async () => {
      // Each character in its own chunk
      const json = '{"k":"v"}\n'
      const chunks = json.split('').map(c => c)
      const response = mockResponse(chunks)
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ k: 'v' }])
    })

    it('handles chunks with Windows-style line endings', async () => {
      // \r\n splitting: \n splits, \r is trimmed
      const response = mockResponse(['{"a":1}\r\n{"b":2}\r\n'])
      const results = await collect(parseNDJSONStream(response))
      expect(results).toEqual([{ a: 1 }, { b: 2 }])
    })

    it('releases reader lock in finally block', async () => {
      const encoder = new TextEncoder()
      let lockReleased = false

      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: encoder.encode('{"a":1}\n') })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(() => { lockReleased = true }),
      }

      const response = {
        body: {
          getReader: () => mockReader,
        },
      } as unknown as Response

      await collect(parseNDJSONStream(response))
      expect(lockReleased).toBe(true)
      expect(mockReader.releaseLock).toHaveBeenCalledTimes(1)
    })
  })
})
