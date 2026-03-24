export async function* parseNDJSONStream<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

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
  } finally {
    reader.releaseLock()
  }
}
