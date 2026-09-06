import { readChunks, type StreamIdleOptions } from './stream-idle'

/**
 * Ollama's NDJSON wire format: one JSON object per line.
 *
 * `opts` reaches the shared idle watchdog in stream-idle.ts and is OFF by
 * default here — unlike the SSE parser, this generator also carries
 * `ollama pull` progress, where minutes of silence during checksum
 * verification of a multi-gigabyte blob is normal and healthy. The chat path
 * (providers/ollama-provider.ts) opts in explicitly.
 *
 * A malformed line stays skipped on purpose. Ollama's own mid-stream failure
 * is a perfectly VALID JSON line (`{"error":"llama runner ... killed"}`) which
 * the provider raises on, so silence is not the failure mode here the way it
 * is for SSE.
 */
export async function* parseNDJSONStream<T>(
  response: Response,
  opts?: StreamIdleOptions,
): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const value of readChunks(response, opts)) {
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        yield JSON.parse(trimmed) as T
      } catch {
        // skip malformed lines
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as T
    } catch {
      // skip
    }
  }
}
