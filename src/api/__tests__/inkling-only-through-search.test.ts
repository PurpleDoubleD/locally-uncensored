import { describe, it, expect, vi, afterEach } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels, searchHuggingFaceModels } from '../discover'

const POLICY = 'https://thinkingmachines.ai/model-acceptable-use-policy/'

afterEach(() => vi.unstubAllGlobals())

function answer(repos: Array<{ id: string; downloads: number }>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(repos), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('uncensored Inkling variants are found by search and nowhere else', () => {
  const repos = [
    { id: 'unsloth/Inkling-2-Mini-GGUF', downloads: 238152 },
    { id: 'AtomicChat/Inkling-2-Mini-Uncensored-GGUF', downloads: 9540 },
    { id: 'JoaoZaokk/Inkling-2-Mini-Heretic-GGUF', downloads: 180 },
  ]

  it('keeps the order Hugging Face gave, without a boost', async () => {
    answer([...repos].reverse())
    const hits = await searchHuggingFaceModels('inkling')
    expect(hits.map((h) => h.description)).toEqual([...repos].reverse().map((r) => r.id))
  })

  it('asks Hugging Face by downloads and adds no word of its own', async () => {
    const fetchMock = answer(repos)
    await searchHuggingFaceModels('inkling')
    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('sort=downloads')
    expect(decodeURIComponent(url)).not.toMatch(/uncensored|abliterated|heretic/i)
  })

  it('gives such a hit no badge or flag, and the same policy note as the plain one', async () => {
    answer(repos)
    const [plain, uncensored] = await searchHuggingFaceModels('inkling')
    expect(uncensored.hot).toBeUndefined()
    expect(uncensored.agent).toBeUndefined()
    expect(uncensored.tags).toEqual(plain.tags)
    expect(plain.usagePolicyUrl).toBe(POLICY)
    expect(uncensored.usagePolicyUrl).toBe(POLICY)
  })

  it('puts no policy note on other models', async () => {
    answer([{ id: 'unsloth/Qwen3.8-27B-GGUF', downloads: 1 }])
    const [hit] = await searchHuggingFaceModels('qwen')
    expect(hit.usagePolicyUrl).toBeUndefined()
  })

  it('has no uncensored Inkling in the curated catalog', () => {
    const rows = [...getMainstreamTextModels(), ...getUncensoredTextModels()].filter((m) =>
      /inkling/i.test(`${m.name} ${m.downloadUrl ?? ''} ${m.ollamaModel ?? ''}`),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((m) => /uncensored|abliterat|heretic/i.test(`${m.name} ${m.description} ${m.downloadUrl ?? ''}`))).toEqual([])
    expect(getUncensoredTextModels().filter((m) => /inkling/i.test(m.name))).toEqual([])
  })
})
