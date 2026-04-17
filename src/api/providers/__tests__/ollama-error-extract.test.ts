import { describe, it, expect } from 'vitest'

// Inline copy of extractError for direct testing — keep in sync with
// OllamaProvider.extractError in ../ollama-provider.ts.
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json()
    const raw = data.error || fallback
    const m = typeof raw === 'string' && raw.match(/[\\'"]*([\w.:/\-]+?)[\\'"]*\s+does not support (chat|completion)/i)
    if (m) {
      const name = m[1]
      return `Ollama rejected "${name}" — its manifest is stale (pulled before Ollama 0.15). Open a terminal and run: ollama pull ${name}   Then reload the model.`
    }
    return raw
  } catch {
    return fallback
  }
}

describe('Ollama stale-manifest error extraction', () => {
  it('raw Ollama body with quoted model name', async () => {
    const body = JSON.stringify({ error: '"gemma4:e4b" does not support chat' })
    const res = new Response(body, { status: 400 })
    const msg = await extractError(res, 'fallback')
    expect(msg).toContain('Ollama rejected')
    expect(msg).toContain('gemma4:e4b')
  })

  it('Rust-proxy-wrapped body', async () => {
    const wrapped = `HTTP 400: ${JSON.stringify({ error: '"gemma4:e4b" does not support chat' })}`
    const body = JSON.stringify({ error: wrapped })
    const res = new Response(body, { status: 500 })
    const msg = await extractError(res, 'fallback')
    expect(msg).toContain('Ollama rejected')
    expect(msg).toContain('gemma4:e4b')
  })

  it('unknown 400 error falls through to raw message', async () => {
    const body = JSON.stringify({ error: 'some other error' })
    const res = new Response(body, { status: 400 })
    const msg = await extractError(res, 'fallback')
    expect(msg).toBe('some other error')
  })
})
