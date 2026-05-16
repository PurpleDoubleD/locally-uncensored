import { describe, it, expect } from 'vitest'
import { parseOllamaError, ModelLoadError, chatStyleMessage, parseShowNotFound } from '../ollama-errors'

describe('parseOllamaError', () => {
  it('detects /api/chat stale-manifest error', async () => {
    const body = JSON.stringify({ error: '"hermes3:8b" does not support chat' })
    const res = new Response(body, { status: 400 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('stale-manifest')
    expect(parsed.model).toBe('hermes3:8b')
  })

  it('detects /api/generate stale-manifest error (Lichtschalter path)', async () => {
    const body = JSON.stringify({ error: '"phi4:14b" does not support generate' })
    const res = new Response(body, { status: 400 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('stale-manifest')
    expect(parsed.model).toBe('phi4:14b')
  })

  it('detects /api/chat stale-manifest for "completion" variant', async () => {
    const body = JSON.stringify({ error: '"foo:7b" does not support completion' })
    const res = new Response(body, { status: 400 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('stale-manifest')
    expect(parsed.model).toBe('foo:7b')
  })

  it('detects Rust-proxy-wrapped stale-manifest (fake-500 from localFetch)', async () => {
    // localFetch wraps as: Response(JSON.stringify({error: "HTTP 400: {...}"}), {status:500})
    const wrapped = `HTTP 400: ${JSON.stringify({ error: '"phi4:14b" does not support generate' })}`
    const body = JSON.stringify({ error: wrapped })
    const res = new Response(body, { status: 500 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('stale-manifest')
    expect(parsed.model).toBe('phi4:14b')
  })

  it('detects stale-manifest for namespaced models (mannix/llama3.1-8b-abliterated:agent)', async () => {
    const body = JSON.stringify({ error: '"mannix/llama3.1-8b-abliterated:agent" does not support generate' })
    const res = new Response(body, { status: 400 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('stale-manifest')
    expect(parsed.model).toBe('mannix/llama3.1-8b-abliterated:agent')
  })

  // "model X not found" is NOT flagged as stale by parseOllamaError alone —
  // it also fires for genuinely non-existent models, and we must not misclassify
  // those. Disambiguation is done by the scanner via cross-reference with
  // /api/tags. parseShowNotFound extracts the name for scanner use.
  it('does NOT flag /api/show 404 as stale from parseOllamaError alone', async () => {
    const body = JSON.stringify({ error: "model 'phi4:14b' not found" })
    const res = new Response(body, { status: 404 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('other')
    expect(parsed.model).toBeNull()
  })

  it('returns other for unknown 400 errors', async () => {
    const body = JSON.stringify({ error: 'unrelated error message' })
    const res = new Response(body, { status: 400 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('other')
    expect(parsed.model).toBeNull()
    expect(parsed.message).toBe('unrelated error message')
  })

  it('falls back to default when body is empty', async () => {
    const res = new Response('', { status: 503 })
    const parsed = await parseOllamaError(res, 'server unavailable')
    expect(parsed.kind).toBe('other')
    expect(parsed.message).toBe('server unavailable')
  })

  it('falls back to default when body is non-JSON text (HTML gateway page, etc.)', async () => {
    const res = new Response('<html>gateway timeout</html>', { status: 504 })
    const parsed = await parseOllamaError(res, 'request failed')
    expect(parsed.kind).toBe('other')
    expect(parsed.raw).toBe('request failed')
  })

  // Bug C (v2.4.5 — Anson192 GH #39): "unable to load model: <blob-path>"
  // means the manifest references a blob that isn't on disk. Classified as
  // missing-blob so the Lichtschalter offers a one-click `ollama pull` repair.
  it('detects missing-blob error from Anson192 GH Discussion #39', async () => {
    const body = JSON.stringify({
      error: 'unable to load model: C:\\Users\\yipan.ollama\\models\\blobs\\sha256-4974d885253dceff1f68b81592f515796d1eb7cfb2cb7775e0df193e96251e2a',
    })
    const res = new Response(body, { status: 500 })
    const parsed = await parseOllamaError(res, 'HTTP 500', 'qwen3:8b')
    expect(parsed.kind).toBe('missing-blob')
    expect(parsed.model).toBe('qwen3:8b')
    expect(parsed.message).toContain('blob')
    expect(parsed.message).toContain('qwen3:8b')
  })

  it('missing-blob with no fallbackModel still classifies but leaves model null', async () => {
    const body = JSON.stringify({
      error: 'unable to load model: /var/lib/ollama/blobs/sha256-abc123',
    })
    const res = new Response(body, { status: 500 })
    const parsed = await parseOllamaError(res)
    expect(parsed.kind).toBe('missing-blob')
    expect(parsed.model).toBeNull()
    expect(parsed.message).toContain('<model>')
  })

  it('missing-blob tolerates forward + back slashes in path', async () => {
    const back = 'unable to load model: C:\\path\\blobs\\sha256-deadbeef'
    const fwd  = 'unable to load model: /var/lib/ollama/blobs/sha256-deadbeef'
    for (const body of [back, fwd]) {
      const res = new Response(JSON.stringify({ error: body }), { status: 500 })
      const parsed = await parseOllamaError(res)
      expect(parsed.kind).toBe('missing-blob')
    }
  })

  it('Rust-proxy-wrapped missing-blob still classifies', async () => {
    const wrapped = `HTTP 500: ${JSON.stringify({ error: 'unable to load model: /home/u/.ollama/models/blobs/sha256-abc' })}`
    const body = JSON.stringify({ error: wrapped })
    const res = new Response(body, { status: 500 })
    const parsed = await parseOllamaError(res, 'HTTP 500', 'llama3:8b')
    expect(parsed.kind).toBe('missing-blob')
    expect(parsed.model).toBe('llama3:8b')
  })
})

describe('ModelLoadError', () => {
  it('carries kind + model + raw error for downstream handling', async () => {
    const res = new Response(JSON.stringify({ error: '"phi4:14b" does not support generate' }), { status: 400 })
    const parsed = await parseOllamaError(res)
    const err = new ModelLoadError(parsed, 'phi4:14b')
    expect(err.kind).toBe('stale-manifest')
    expect(err.model).toBe('phi4:14b')
    expect(err.name).toBe('ModelLoadError')
    expect(err.message).toContain('stale manifest')
  })

  it('falls back to callerModel when regex fails to capture', async () => {
    const res = new Response(JSON.stringify({ error: 'server crash' }), { status: 500 })
    const parsed = await parseOllamaError(res)
    const err = new ModelLoadError(parsed, 'phi4:14b')
    expect(err.kind).toBe('other')
    expect(err.model).toBe('phi4:14b')  // caller-supplied fallback
  })
})

describe('parseShowNotFound', () => {
  it('extracts model name from quoted "not found" message', () => {
    expect(parseShowNotFound("model 'phi4:14b' not found")).toBe('phi4:14b')
  })
  it('tolerates double-quotes', () => {
    expect(parseShowNotFound('model "hermes3:8b" not found')).toBe('hermes3:8b')
  })
  it('tolerates no quotes', () => {
    expect(parseShowNotFound('model dolphin3:8b not found')).toBe('dolphin3:8b')
  })
  it('handles namespaced model names', () => {
    expect(parseShowNotFound("model 'mannix/llama3.1-8b-abliterated:agent' not found"))
      .toBe('mannix/llama3.1-8b-abliterated:agent')
  })
  it('returns null for unrelated strings', () => {
    expect(parseShowNotFound('server crashed')).toBeNull()
    expect(parseShowNotFound('')).toBeNull()
    expect(parseShowNotFound('does not support chat')).toBeNull()
  })
})

describe('chatStyleMessage', () => {
  it('produces terminal-instruction wording for stale-manifest', async () => {
    const res = new Response(JSON.stringify({ error: '"gemma4:e4b" does not support chat' }), { status: 400 })
    const parsed = await parseOllamaError(res)
    const msg = chatStyleMessage(parsed)
    expect(msg).toContain('Ollama rejected')
    expect(msg).toContain('ollama pull gemma4:e4b')
  })

  it('returns raw message for non-stale errors', async () => {
    const res = new Response(JSON.stringify({ error: 'CUDA out of memory' }), { status: 500 })
    const parsed = await parseOllamaError(res)
    expect(chatStyleMessage(parsed)).toBe('CUDA out of memory')
  })

  it('produces terminal-instruction wording for missing-blob (with model)', async () => {
    const res = new Response(JSON.stringify({ error: 'unable to load model: /x/blobs/sha256-abc' }), { status: 500 })
    const parsed = await parseOllamaError(res, 'fallback', 'qwen3:8b')
    const msg = chatStyleMessage(parsed)
    expect(msg).toContain('Ollama could not load')
    expect(msg).toContain('qwen3:8b')
    expect(msg).toContain('ollama pull qwen3:8b')
  })

  it('produces generic missing-blob wording when model is unknown', async () => {
    const res = new Response(JSON.stringify({ error: 'unable to load model: /x/blobs/sha256-abc' }), { status: 500 })
    const parsed = await parseOllamaError(res)
    expect(chatStyleMessage(parsed)).toContain('<model>')
  })
})
