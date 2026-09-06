/**
 * P5 — Embeddings routing: Document-Chat/RAG must embed against the bundled
 * `llama-server --embeddings` (OpenAI `/v1/embeddings`) when the app-managed
 * built-in engine is active, and only fall back to Ollama's `/api/embed`
 * otherwise. This is the frontend half of "onboarding is Ollama-free".
 *
 * We mock the backend transport + the engine active-check so the pure routing
 * decision (which URL, which response shape) is testable without a real server.
 *
 * Run: npx vitest run src/api/__tests__/rag-embeddings-routing.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mutable flags the mock reads so each test can flip the active backend and
// whether the self-heal left a server behind.
let builtinActive = false
let embedRunning = true
const ensureEmbed = vi.fn()

vi.mock('../engine', () => ({
  isManagedBuiltinActive: () => builtinActive,
  embedBaseUrl: () => 'http://127.0.0.1:8128/v1',
  // Post-offload self-heal: rag awaits this before hitting :8128.
  ensureBundledEmbedAlive: (...args: unknown[]) => ensureEmbed(...args),
  bundledEmbedStatus: async () => ({ running: embedRunning, healthy: embedRunning }),
}))

const localFetch = vi.fn()
vi.mock('../backend', () => ({
  localFetch: (...args: unknown[]) => localFetch(...args),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
}))

import { cosineSimilarity, generateEmbeddings, indexDocument, retrieveContext } from '../rag'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('generateEmbeddings routing', () => {
  beforeEach(() => {
    localFetch.mockReset()
    ensureEmbed.mockReset()
    builtinActive = false
    embedRunning = true
  })

  it('hits the bundled /v1/embeddings when the built-in engine is active', async () => {
    builtinActive = true
    // OpenAI shape, deliberately returned out of order to prove we sort by index.
    localFetch.mockResolvedValue(jsonResponse({
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }))

    const out = await generateEmbeddings(['a', 'b'])

    const [url, opts] = localFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8128/v1/embeddings')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(String(opts.body)).input).toEqual(['a', 'b'])
    // Sorted back into input order.
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]])
    // The post-offload self-heal MUST run before the request — a Create render
    // stops the embed sidecar, and without this await RAG dies on a dead port.
    expect(ensureEmbed).toHaveBeenCalledTimes(1)
  })

  it('falls back to Ollama /api/embed when the built-in engine is NOT active', async () => {
    builtinActive = false
    // A running bundled server would win even here (LM Studio setups embed
    // through it), so this case only exists with the server down.
    embedRunning = false
    localFetch.mockResolvedValue(jsonResponse({ embeddings: [[0.9, 0.8]] }))

    const out = await generateEmbeddings(['x'])

    const [url] = localFetch.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/embed')
    expect(out).toEqual([[0.9, 0.8]])
  })

  it('names the missing model when the self-heal could not bring a server up', async () => {
    // The Windows box on 2026-08-15: built-in engine active, no embedding GGUF
    // installed, so ensureBundledEmbedAlive has nothing to start. Before this
    // the request went out anyway and came back as
    // `proxy_localhost: error sending request`, which names the pipe, not the
    // missing part. No request should leave at all in this state.
    builtinActive = true
    embedRunning = false

    await expect(generateEmbeddings(['a'])).rejects.toThrow(/No embedding model is installed/)
    expect(ensureEmbed).toHaveBeenCalledTimes(1)
    expect(localFetch).not.toHaveBeenCalled()
  })

  it('surfaces a built-in-specific error (not an Ollama hint) when the embed server fails', async () => {
    builtinActive = true
    localFetch.mockResolvedValue(jsonResponse({ error: { message: 'model still loading' } }, 503))

    await expect(generateEmbeddings(['a'])).rejects.toThrow(/model still loading/)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Was die Server schicken, ist nicht, was `d.embedding as number[]` behauptet.
// ────────────────────────────────────────────────────────────────────────

describe('generateEmbeddings survives a malformed embedding row', () => {
  beforeEach(() => {
    localFetch.mockReset()
    ensureEmbed.mockReset()
    builtinActive = true
    embedRunning = true
  })

  it('turns a row with no embedding field into an empty vector, never undefined', async () => {
    // llama-server answers per input; a row it could not embed still occupies
    // its index. `d.embedding as number[]` put `undefined` INSIDE the
    // number[][], and cosineSimilarity's own "empty vector" guard (`!a.length`)
    // throws on undefined instead of returning 0 — so the next query against
    // that document died with a raw TypeError.
    localFetch.mockResolvedValue(jsonResponse({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1 },
      ],
    }))

    const out = await generateEmbeddings(['a', 'b'])

    expect(out).toHaveLength(2)
    expect(out[0]).toEqual([0.1, 0.2])
    expect(out[1]).toEqual([])
    // The property that matters downstream: no entry may be undefined, and
    // every entry must survive the ranking path.
    expect(out.every((v) => Array.isArray(v))).toBe(true)
    expect(() => cosineSimilarity([1, 0], out[1])).not.toThrow()
    expect(cosineSimilarity([1, 0], out[1])).toBe(0)
  })

  it('rejects a half-numeric vector rather than shortening it', async () => {
    // A vector with a hole is not a shorter vector. Dropping the bad entries
    // would produce a plausible-looking vector of the wrong dimension, which
    // cosineSimilarity can no longer tell apart from a model change.
    localFetch.mockResolvedValue(jsonResponse({
      data: [{ index: 0, embedding: [0.1, null, 0.3] }],
    }))

    expect(await generateEmbeddings(['a'])).toEqual([[]])
  })

  it('does the same for the Ollama shape', async () => {
    builtinActive = false
    embedRunning = false
    localFetch.mockResolvedValue(jsonResponse({ embeddings: [[0.9, 0.8], null] }))

    const out = await generateEmbeddings(['x', 'y'])
    expect(out).toEqual([[0.9, 0.8], []])
    expect(() => cosineSimilarity([1, 0], out[1])).not.toThrow()
  })
})

describe('an Ollama error body that is not a string still reaches the user', () => {
  beforeEach(() => {
    localFetch.mockReset()
    ensureEmbed.mockReset()
    builtinActive = false
    embedRunning = false
  })

  it('reports the message instead of throwing on detail.includes', async () => {
    // `detail = body?.error || ''` handed an OBJECT to `detail.includes(...)`
    // one line later. An OpenAI-shaped proxy in front of Ollama (LiteLLM,
    // ollama-openai bridges) answers exactly that shape, and the user got
    // `detail.includes is not a function` instead of the real reason.
    localFetch.mockResolvedValue(
      jsonResponse({ error: { message: 'model "nomic-embed-text" not found' } }, 500),
    )

    await expect(generateEmbeddings(['a'])).rejects.toThrow(/nomic-embed-text/)
    await expect(generateEmbeddings(['a'])).rejects.not.toThrow(TypeError)
  })

  it('still turns a 404-adjacent "not found" into the ollama pull hint', async () => {
    localFetch.mockResolvedValue(jsonResponse({ error: 'model not found' }, 500))

    await expect(generateEmbeddings(['a'], 'nomic-embed-text'))
      .rejects.toThrow(/ollama pull nomic-embed-text/)
  })
})


describe('indexDocument never stores a chunk without a vector', () => {
  beforeEach(() => {
    localFetch.mockReset()
    ensureEmbed.mockReset()
    builtinActive = true
    embedRunning = true
  })

  it('gives a chunk an empty vector when the server answered with fewer rows', async () => {
    // `chunkText` splits this into two chunks; the server answers with one row.
    // `embeddings[index]` was therefore `undefined` for the tail chunk, and
    // `TextChunk.embedding` promises `number[]`. The undefined got PERSISTED,
    // and every later query against that document threw out of
    // cosineSimilarity's `!a.length` — permanently, until the file was
    // re-added.
    const text = `${'alpha '.repeat(300)}\n\n${'beta '.repeat(300)}`
    const file = new File([text], 'notes.txt', { type: 'text/plain' })
    localFetch.mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] }))

    const { chunks } = await indexDocument(file)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => Array.isArray(c.embedding))).toBe(true)

    // And the point of it: a query over those chunks still runs.
    localFetch.mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] }))
    await expect(retrieveContext('alpha', chunks)).resolves.toBeDefined()
  })
})
