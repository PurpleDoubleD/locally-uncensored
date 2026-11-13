/**
 * Bug hunt C3 (Oktober 2026): Models, Discover (Chat). Offline (fetch_external
 * throws "dns error") or rate limited (HF answers {"error": "Rate limit
 * reached..."}), the HuggingFace search said "No models found", as if no such
 * model existed. searchHuggingFaceModels swallowed every error into [].
 * It now throws an HfSearchError that says which of the two it was, and an
 * answer with no hits stays an empty list.
 *
 * Run: npx vitest run src/api/__tests__/a-failed-hf-search-is-not-an-empty-one.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchExternal = vi.fn<(url: string) => Promise<string>>()

vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  isTauri: () => true,
  fetchExternal: (url: string) => fetchExternal(url),
}))

import { searchHuggingFaceModels, HfSearchError, hfSearchFailureText } from '../discover'

beforeEach(() => { fetchExternal.mockReset() })

describe('the HuggingFace search when HuggingFace does not answer', () => {
  it('offline: the search fails as offline instead of returning no hits', async () => {
    fetchExternal.mockRejectedValue('error sending request for url (https://huggingface.co/api/models?...): dns error')
    const err = await searchHuggingFaceModels('offline').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HfSearchError)
    expect((err as HfSearchError).kind).toBe('offline')
    expect(hfSearchFailureText(err)).toBe('Hugging Face could not be reached. Check the connection and search again.')
  })

  it('rate limited: the error JSON is named as the limit, not read as an empty list', async () => {
    fetchExternal.mockResolvedValue(JSON.stringify({ error: 'Rate limit reached. You reached free usage limit' }))
    const err = await searchHuggingFaceModels('ratelimit').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HfSearchError)
    expect((err as HfSearchError).kind).toBe('rate-limit')
    expect(hfSearchFailureText(err)).toMatch(/limiting searches/)
  })

  it('an answer with no hits is still an empty list', async () => {
    fetchExternal.mockResolvedValue('[]')
    await expect(searchHuggingFaceModels('nothing-matches')).resolves.toEqual([])
  })

  it('an answer with hits is still mapped to models', async () => {
    fetchExternal.mockResolvedValue(JSON.stringify([{ id: 'org/Foo-GGUF', downloads: 2500 }]))
    const hits = await searchHuggingFaceModels('foo')
    expect(hits.map((h) => h.name)).toEqual(['Foo'])
    expect(hits[0].filename).toBe('Foo-Q4_K_M.gguf')
  })
})
