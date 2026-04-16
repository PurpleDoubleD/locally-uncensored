import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  precomputeToolEmbeddings,
  rankToolsByEmbedding,
  selectToolsByEmbedding,
  clearEmbeddingCache,
  __internal,
} from '../embedding-router'

// Deterministic fake embeddings: character-frequency vectors of length 26
// ('a'..'z'). Two similar-topic strings will share character distribution
// and hence a high cosine similarity without needing real nomic-embed.
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    const v = new Array(26).fill(0)
    const s = t.toLowerCase()
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i)
      if (code >= 97 && code <= 122) v[code - 97] += 1
    }
    return v
  })

describe('embedding-router — precompute / cache', () => {
  beforeEach(() => clearEmbeddingCache())

  it('embeds tools on first pass and caches them', async () => {
    const tools = [
      { name: 'a', description: 'apple' },
      { name: 'b', description: 'banana' },
    ]
    const added = await precomputeToolEmbeddings(tools, fakeEmbed)
    expect(added).toBe(2)
    expect(__internal.CACHE.size).toBe(2)
  })

  it('skips tools whose description has not changed', async () => {
    const tools = [{ name: 'a', description: 'apple' }]
    await precomputeToolEmbeddings(tools, fakeEmbed)
    const embedSpy = vi.fn(fakeEmbed)
    const added = await precomputeToolEmbeddings(tools, embedSpy)
    expect(added).toBe(0)
    expect(embedSpy).not.toHaveBeenCalled()
  })

  it('re-embeds a tool whose description changed', async () => {
    await precomputeToolEmbeddings([{ name: 'a', description: 'apple' }], fakeEmbed)
    const embedSpy = vi.fn(fakeEmbed)
    const added = await precomputeToolEmbeddings(
      [{ name: 'a', description: 'apple banana' }],
      embedSpy
    )
    expect(added).toBe(1)
    expect(embedSpy).toHaveBeenCalledOnce()
  })
})

describe('embedding-router — ranking', () => {
  beforeEach(() => clearEmbeddingCache())

  it('ranks the most similar-text tool first', async () => {
    const tools = [
      { name: 'search_web', description: 'find things on the internet and return results' },
      { name: 'read_file', description: 'open a file on disk and return contents' },
      { name: 'run_shell', description: 'execute a terminal command and return output' },
    ]
    await precomputeToolEmbeddings(tools, fakeEmbed)
    const ranked = await rankToolsByEmbedding(
      'please open the readme file on my disk',
      tools,
      fakeEmbed,
      { topN: 3 }
    )
    expect(ranked[0].tool.name).toBe('read_file')
  })

  it('respects topN truncation', async () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({
      name: `t${i}`,
      description: `description ${i}`,
    }))
    await precomputeToolEmbeddings(tools, fakeEmbed)
    const ranked = await rankToolsByEmbedding('query', tools, fakeEmbed, { topN: 3 })
    expect(ranked).toHaveLength(3)
  })

  it('skips uncached tools silently', async () => {
    const tools = [{ name: 'a', description: 'apple' }, { name: 'b', description: 'banana' }]
    // Only embed "a" first
    await precomputeToolEmbeddings([tools[0]], fakeEmbed)
    const ranked = await rankToolsByEmbedding('apple', tools, fakeEmbed, { topN: 5 })
    expect(ranked.map((r) => r.tool.name)).toEqual(['a'])
  })

  it('returns [] on empty query embedding', async () => {
    const tools = [{ name: 'a', description: 'apple' }]
    await precomputeToolEmbeddings(tools, fakeEmbed)
    const ranked = await rankToolsByEmbedding(
      'x',
      tools,
      async () => [] as number[][], // pathological — returns no vector
      { topN: 3 }
    )
    expect(ranked).toEqual([])
  })
})

describe('embedding-router — selectToolsByEmbedding', () => {
  beforeEach(() => clearEmbeddingCache())

  it('precomputes, ranks topN tools, unions with alwaysInclude', async () => {
    const tools = [
      { name: 'search_web', description: 'find things on the internet' },
      { name: 'read_file', description: 'open a file on disk' },
      { name: 'get_current_time', description: 'return current local time' },
    ]
    const out = await selectToolsByEmbedding(
      'any query — topN is the contract being tested, not specific ranking',
      tools,
      fakeEmbed,
      { topN: 1, alwaysInclude: ['get_current_time'] }
    )
    // Exactly 1 ranked + get_current_time always appended = 2 (unless the
    // top-ranked happens to be get_current_time, then 1).
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out).toContain('get_current_time')
  })

  it('does not duplicate when an always-include name is already ranked', async () => {
    const tools = [
      { name: 'get_current_time', description: 'return current local date and time now' },
    ]
    const out = await selectToolsByEmbedding(
      'what time is it',
      tools,
      fakeEmbed,
      { topN: 3, alwaysInclude: ['get_current_time'] }
    )
    expect(out.filter((n) => n === 'get_current_time')).toHaveLength(1)
  })
})

describe('embedding-router — cosine edge cases', () => {
  it('zero vector → similarity 0', () => {
    expect(__internal.cosine([0, 0, 0], [1, 1, 1])).toBe(0)
  })
  it('identical vector → 1', () => {
    expect(__internal.cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5)
  })
  it('opposite vector → -1', () => {
    expect(__internal.cosine([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 5)
  })
  it('different-length vectors use the shorter length', () => {
    const v = __internal.cosine([1, 2, 3], [1, 2])
    expect(Number.isFinite(v)).toBe(true)
  })
})

describe('embedding-router — hashDescription', () => {
  it('is stable', () => {
    expect(__internal.hashDescription('hello')).toBe(__internal.hashDescription('hello'))
  })
  it('differs for different descriptions', () => {
    expect(__internal.hashDescription('a')).not.toBe(__internal.hashDescription('b'))
  })
})
