/**
 * RAG ranking must survive a chunk whose embedding does not line up (2026-07-28)
 *
 * Chunk vectors and the query vector can legitimately differ in length — the
 * user switched embedding models, or the app moved from Ollama embeddings to
 * the built-in engine — and a chunk whose embedding call failed can be stored
 * empty. cosineSimilarity used to read past the shorter vector and return NaN,
 * and hybridSearch then normalized every score against Math.max(..., NaN),
 * which is NaN. The sort compared NaNs, so retrieval quietly handed back the
 * document's first chunks instead of the relevant ones.
 *
 * Run: npx vitest run src/api/__tests__/rag-ranking-nan.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../engine', () => ({
  isManagedBuiltinActive: () => false,
  embedBaseUrl: () => 'http://127.0.0.1:8128/v1',
}))

const localFetch = vi.fn()
vi.mock('../backend', () => ({
  localFetch: (...args: unknown[]) => localFetch(...args),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
}))

import { cosineSimilarity, retrieveContext } from '../rag'
import type { TextChunk } from '../../types/rag'

function chunk(id: string, content: string, embedding: number[]): TextChunk {
  return { id, documentId: 'doc1', content, embedding, index: Number(id) } as TextChunk
}

describe('cosineSimilarity', () => {
  it('scores identical vectors at 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
  })

  it('returns 0 instead of NaN for vectors of different length', () => {
    expect(cosineSimilarity([1, 2, 3, 4], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0)
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0)
  })

  it('never returns a non-finite score', () => {
    expect(Number.isFinite(cosineSimilarity([0, 0, 0], [0, 0, 0]))).toBe(true)
  })
})

describe('retrieveContext ranking', () => {
  beforeEach(() => {
    localFetch.mockReset()
    // Ollama /api/embed shape — one vector for the single query.
    localFetch.mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  it('still ranks the matching chunk first when another chunk has a stale-dimension vector', async () => {
    const chunks = [
      // Irrelevant, and embedded by a different model → wrong dimensions.
      chunk('0', 'completely unrelated filler text about gardening tools', [0.2, 0.9]),
      // The one that actually answers the query.
      chunk('1', 'the deployment key rotation procedure', [1, 0, 0]),
    ]
    const { scoredChunks } = await retrieveContext('key rotation', chunks, 'nomic-embed-text', 2)
    expect(scoredChunks[0].chunk.id).toBe('1')
    expect(scoredChunks.every(r => Number.isFinite(r.score))).toBe(true)
  })

  it('survives a chunk whose embedding never arrived', async () => {
    const chunks = [
      chunk('0', 'unrelated filler about gardening tools', []),
      chunk('1', 'the deployment key rotation procedure', [1, 0, 0]),
    ]
    const { scoredChunks } = await retrieveContext('key rotation', chunks, 'nomic-embed-text', 2)
    expect(scoredChunks[0].chunk.id).toBe('1')
    expect(scoredChunks.every(r => Number.isFinite(r.score))).toBe(true)
  })
})
