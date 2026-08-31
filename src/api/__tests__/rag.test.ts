/**
 * RAG (Retrieval-Augmented Generation) Tests
 *
 * Tests pure logic functions: chunkText, searchVectors, and the internal cosineSimilarity
 * (tested indirectly via searchVectors).
 * Does NOT test extractText/generateEmbeddings/indexDocument/retrieveContext as they need real backends.
 *
 * Run: npx vitest run src/api/__tests__/rag.test.ts
 */
import { describe, it, expect } from 'vitest'
import { chunkText, searchVectors } from '../rag'
import type { TextChunk } from '../../types/rag'

// ── Helpers ──────────────────────────────────────────────────────

/** Create a TextChunk with the given content and embedding vector. */
function makeChunk(content: string, embedding: number[], index = 0): TextChunk {
  return {
    id: `chunk-${index}`,
    documentId: 'doc-1',
    content,
    embedding,
    index,
  }
}

// ── chunkText ────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([])
  })

  it('returns empty array for whitespace-only text', () => {
    expect(chunkText('   ')).toEqual([])
  })

  it('returns empty array when all chunks are under 20 chars', () => {
    // Short sentences that individually and combined are <= 20 chars
    expect(chunkText('Hi. OK.', 5, 0)).toEqual([])
  })

  it('keeps a single chunk when text fits within chunkSize', () => {
    const text = 'This is a test sentence that is long enough to pass the 20 char filter.'
    const result = chunkText(text, 1000, 50)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(text)
  })

  it('splits on sentence boundaries', () => {
    const s1 = 'First sentence is definitely long enough to keep.'
    const s2 = 'Second sentence is also quite long enough to keep.'
    const s3 = 'Third sentence passes the minimum length filter easily.'
    const text = `${s1} ${s2} ${s3}`
    // chunkSize small enough to force splits
    const result = chunkText(text, 60, 0)
    expect(result.length).toBeGreaterThanOrEqual(2)
    // Each chunk should be a substring of the original text (modulo overlap)
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(20)
    }
  })

  it('produces overlap between consecutive chunks', () => {
    const sentences = [
      'The quick brown fox jumped over the lazy sleeping dog.',
      'A second sentence that has enough words for overlap testing.',
      'A third sentence providing additional content for the chunks.',
    ]
    const text = sentences.join(' ')
    const result = chunkText(text, 70, 30)

    // With overlap > 0 and multiple chunks, consecutive chunks should share some words
    if (result.length >= 2) {
      const wordsFirst = new Set(result[0].split(' '))
      const wordsSecond = new Set(result[1].split(' '))
      const shared = [...wordsSecond].filter((w) => wordsFirst.has(w))
      expect(shared.length).toBeGreaterThan(0)
    }
  })

  it('filters out chunks shorter than 20 characters', () => {
    const result = chunkText(
      'Short. But this sentence is definitely long enough to survive the filter.',
      200,
      0
    )
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(20)
    }
  })

  it('handles a single very long sentence', () => {
    const longSentence = 'word '.repeat(200).trim() + '.'
    const result = chunkText(longSentence, 100, 20)
    // A single sentence without internal sentence-end punctuation won't split,
    // so it should come through as one chunk
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0]).toBe(longSentence)
  })

  it('uses default chunkSize and overlap when not specified', () => {
    const text = 'A reasonably long sentence. '.repeat(50)
    const result = chunkText(text)
    // With default chunkSize=500, should produce multiple chunks
    expect(result.length).toBeGreaterThan(1)
  })
})

// ── searchVectors (also tests cosineSimilarity indirectly) ───────

describe('searchVectors', () => {
  it('returns empty array when chunks is empty', () => {
    const result = searchVectors([1, 0, 0], [], 5)
    expect(result).toEqual([])
  })

  it('ranks identical embedding highest (score ~ 1.0)', () => {
    const query = [1, 0, 0]
    const chunks = [
      makeChunk('exact match', [1, 0, 0], 0),
      makeChunk('orthogonal', [0, 1, 0], 1),
      makeChunk('opposite', [-1, 0, 0], 2),
    ]
    const results = searchVectors(query, chunks, 3)

    expect(results).toHaveLength(3)
    // First result should be the identical vector
    expect(results[0].chunk.content).toBe('exact match')
    expect(results[0].score).toBeCloseTo(1.0, 5)
  })

  it('gives orthogonal vectors a score of 0', () => {
    const query = [1, 0, 0]
    const chunks = [makeChunk('orthogonal', [0, 1, 0], 0)]
    const results = searchVectors(query, chunks, 1)

    expect(results[0].score).toBeCloseTo(0, 5)
  })

  it('gives opposite vectors a score of -1', () => {
    const query = [1, 0, 0]
    const chunks = [makeChunk('opposite', [-1, 0, 0], 0)]
    const results = searchVectors(query, chunks, 1)

    expect(results[0].score).toBeCloseTo(-1.0, 5)
  })

  it('respects topK limit', () => {
    const query = [1, 0, 0]
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk(`chunk-${i}`, [Math.cos(i), Math.sin(i), 0], i)
    )
    const results = searchVectors(query, chunks, 3)
    expect(results).toHaveLength(3)
  })

  it('returns all chunks when topK exceeds chunk count', () => {
    const query = [1, 0, 0]
    const chunks = [
      makeChunk('a', [1, 0, 0], 0),
      makeChunk('b', [0, 1, 0], 1),
    ]
    const results = searchVectors(query, chunks, 100)
    expect(results).toHaveLength(2)
  })

  it('sorts results by descending score', () => {
    const query = [1, 0, 0]
    const chunks = [
      makeChunk('low', [0.1, 0.9, 0], 0),
      makeChunk('high', [0.95, 0.05, 0], 1),
      makeChunk('mid', [0.5, 0.5, 0], 2),
    ]
    const results = searchVectors(query, chunks, 3)

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
    expect(results[0].chunk.content).toBe('high')
  })

  it('uses default topK of 5', () => {
    const query = [1, 0]
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk(`chunk-${i}`, [Math.cos(i), Math.sin(i)], i)
    )
    const results = searchVectors(query, chunks)
    expect(results).toHaveLength(5)
  })
})

// ── cosineSimilarity edge cases (tested via searchVectors) ───────

describe('cosineSimilarity (via searchVectors)', () => {
  it('handles zero-magnitude vector gracefully (returns 0, not NaN)', () => {
    const query = [1, 0, 0]
    const chunks = [makeChunk('zero vec', [0, 0, 0], 0)]
    const results = searchVectors(query, chunks, 1)

    // The implementation divides by (mag || 1), so zero-mag should yield 0
    expect(results[0].score).toBe(0)
    expect(Number.isNaN(results[0].score)).toBe(false)
  })

  it('returns 1.0 for identical non-trivial vectors', () => {
    const vec = [0.3, 0.5, 0.8, 0.1]
    const chunks = [makeChunk('identical', vec, 0)]
    const results = searchVectors(vec, chunks, 1)

    expect(results[0].score).toBeCloseTo(1.0, 5)
  })

  it('handles high-dimensional vectors', () => {
    const dim = 768 // typical embedding dimension
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i))
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 1))
    const chunks = [makeChunk('high-dim', b, 0)]
    const results = searchVectors(a, chunks, 1)

    // Score should be a valid number between -1 and 1
    expect(results[0].score).toBeGreaterThan(-1)
    expect(results[0].score).toBeLessThanOrEqual(1)
    expect(Number.isFinite(results[0].score)).toBe(true)
  })
})
