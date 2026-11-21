/**
 * 3.1.3 (David, 21.11.2026): "Get the original Huihui Qwen 3.8 27B" named the
 * abliterated model itself. The original comes from the provenance now.
 *
 * Run: npx vitest run src/lib/__tests__/model-origin.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import {
  cleanModelName, displayName, hasTweakMark, parseCard, pickChoice, quantOfFile, repoFromUrl, resolveOriginal,
  type ModelOrigin, type OriginIo, type OriginalOffer,
} from '../model-origin'
import type { GgufChoice } from '../../api/discover'

const GB = 1_073_741_824
const choice = (quant: string, gb: number, incomplete = false): GgufChoice => ({
  path: `model-${quant}.gguf`, filename: `model-${quant}.gguf`, quant, parts: 1, totalBytes: gb * GB, incomplete,
})
const QUANTS = [choice('Q4_K_M', 16), choice('Q6_K', 22), choice('Q8_0', 29)]

const CARDS: Record<string, string[]> = {
  'Qwen/Qwen3.8-27B': [],
  'Qwen/Qwen3.5-9B': [],
  'Qwen/Qwen3.5-9B-Instruct': ['Qwen/Qwen3.5-9B'],
  'unsloth/Qwen3.8-27B-GGUF': ['Qwen/Qwen3.8-27B'],
  'unsloth/Qwen3.5-9B-GGUF': ['Qwen/Qwen3.5-9B'],
  'bartowski/Qwen_Qwen3.8-27B-GGUF': ['Qwen/Qwen3.8-27B'],
  'huihui-ai/Huihui-Qwen3.8-27B-abliterated': ['Qwen/Qwen3.8-27B'],
  'huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF': ['huihui-ai/Huihui-Qwen3.8-27B-abliterated'],
  'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-GGUF': ['Qwen/Qwen3.8-27B'],
  'someone/loop-a': ['someone/loop-b'],
  'someone/loop-b': ['someone/loop-a'],
  'someone/plain-upload': [],
  'mix/merge-one': ['Qwen/Qwen3.8-27B'],
  'mix/merge-two': ['Qwen/Qwen3.5-9B'],
}
const GGUFS: Record<string, string[]> = {
  'Qwen/Qwen3.8-27B': ['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-GGUF', 'unsloth/Qwen3.8-27B-GGUF', 'bartowski/Qwen_Qwen3.8-27B-GGUF'],
  'Qwen/Qwen3.5-9B': ['unsloth/Qwen3.5-9B-GGUF'],
}

function hub(over: Partial<OriginIo> = {}): OriginIo {
  return {
    card: vi.fn(async (r: string) => (r in CARDS ? { id: r, baseModels: CARDS[r] } : null)),
    search: vi.fn(async (n: string) => Object.keys(CARDS).filter((r) => r.toLowerCase().includes(n.split(' ')[0].toLowerCase()))),
    ggufsOf: vi.fn(async (r: string) => GGUFS[r] ?? []),
    choices: vi.fn(async () => QUANTS),
    ...over,
  }
}

const url = (r: string) => `https://huggingface.co/${r}`
const Q38: OriginalOffer = { kind: 'exact', name: 'Qwen 3.8 27B', repo: 'Qwen/Qwen3.8-27B', ggufRepo: 'unsloth/Qwen3.8-27B-GGUF', file: 'model-Q4_K_M.gguf', quant: 'Q4_K_M' }

const TABLE: Array<[string, ModelOrigin, OriginalOffer | null]> = [
  ['Huihui Qwen 3.8 27B abliterated (GGUF names its base)',
    { basename: 'Huihui-Qwen3.8', sizeLabel: '27B', file: 'x-Q4_K_M', bases: [{ name: 'Huihui Qwen3.8 27B abliterated', organization: 'Huihui Ai', repoUrl: url('huihui-ai/Huihui-Qwen3.8-27B-abliterated') }] }, Q38],
  ['HauhauCS Qwen 3.8 27B Uncensored (only a source repo)',
    { basename: 'Qwen3.8-Uncensored-HauhauCS-Aggressive', sizeLabel: '27B', file: 'x-Q4_K_M', sourceRepos: [url('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-GGUF')] }, Q38],
  ['DavidAU Qwen 3.5 9B Defiant (only a name)',
    { basename: 'DavidAU-Qwen3.5-9B-The-Defiant', sizeLabel: '9B', file: 'x-Q4_K_M' },
    { kind: 'exact', name: 'Qwen 3.5 9B', repo: 'Qwen/Qwen3.5-9B', ggufRepo: 'unsloth/Qwen3.5-9B-GGUF', file: 'model-Q4_K_M.gguf', quant: 'Q4_K_M' }],
  ['a real original', { basename: 'Qwen3.8', sizeLabel: '27B', file: 'x-Q4_K_M', sourceRepos: [url('Qwen/Qwen3.8-27B')] }, Q38],
  ['a third party\'s GGUF of an original', { basename: 'Qwen3.8', sizeLabel: '27B', file: 'x-Q4_K_M', sourceRepos: [url('bartowski/Qwen_Qwen3.8-27B-GGUF')] }, Q38],
  ['a model with no origin at all', {}, null],
  ['a base_model loop', { basename: 'LoopModel', sizeLabel: '7B', sourceRepos: [url('someone/loop-a')] }, { kind: 'search', query: 'LoopModel 7B' }],
  ['a repo that is no maker\'s, with no base', { basename: 'PlainThing', sizeLabel: '3B', sourceRepos: [url('someone/plain-upload')] }, { kind: 'search', query: 'PlainThing 3B' }],
  ['a merge of two originals', { basename: 'Blend', sizeLabel: '27B', bases: [{ repoUrl: url('mix/merge-one') }, { repoUrl: url('mix/merge-two') }] }, { kind: 'search', query: 'Blend 27B' }],
  ['27B never becomes 9B', { basename: 'Qwen3.5', sizeLabel: '27B', sourceRepos: [url('Qwen/Qwen3.5-9B')] }, { kind: 'search', query: 'Qwen3.5 27B' }],
]

describe('the original of a model', () => {
  it.each(TABLE)('%s', async (_name, origin, want) => {
    expect(await resolveOriginal(origin, hub())).toEqual(want)
  })

  it('a maker\'s own Instruct is the original, not its base model', async () => {
    const r = await resolveOriginal({ basename: 'Qwen3.5', sizeLabel: '9B', sourceRepos: [url('Qwen/Qwen3.5-9B-Instruct')] }, hub({ ggufsOf: async () => [] }))
    expect(r).toEqual({ kind: 'search', query: 'Qwen 3.5 9B Instruct' })
  })

  it('never offers a changed GGUF, even one Hugging Face lists under the original', async () => {
    const io = hub({ ggufsOf: async () => ['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'x/Qwen3.8-27B-Uncensored-GGUF'] })
    expect(await resolveOriginal(TABLE[0][1], io)).toEqual({ kind: 'search', query: 'Qwen 3.8 27B' })
  })

  it('takes no GGUF whose base_model is another model', async () => {
    const io = hub({ ggufsOf: async () => ['unsloth/Qwen3.5-9B-GGUF'] })
    expect(await resolveOriginal(TABLE[0][1], io)).toEqual({ kind: 'search', query: 'Qwen 3.8 27B' })
  })

  it('offline it says nothing wrong and throws nothing', async () => {
    const io = hub({ card: async () => null, search: async () => null, ggufsOf: async () => null, choices: async () => null })
    expect(await resolveOriginal(TABLE[0][1], io)).toEqual({ kind: 'search', query: 'Qwen3.8 27B' })
  })

  it('sends repo names only: no file name, no address from a foreign host', async () => {
    const io = hub()
    await resolveOriginal({ basename: 'Qwen3.8', sizeLabel: '27B', file: 'my-private-name-Q4_K_M', sourceRepos: ['https://evil.example/Qwen/Qwen3.8-27B', 'file:///etc/passwd'] }, io)
    const asked = [...vi.mocked(io.card).mock.calls, ...vi.mocked(io.search).mock.calls].flat().join(' ')
    expect(asked).not.toMatch(/private|evil|passwd/)
  })
})

describe('the pieces', () => {
  it('keeps the same quant when it fits, else the largest that fits', () => {
    expect(pickChoice(QUANTS, 'Q6_K', 40 * GB)?.quant).toBe('Q6_K')
    expect(pickChoice(QUANTS, 'Q8_0', 25 * GB)?.quant).toBe('Q6_K')
    expect(pickChoice(QUANTS, 'Q8_0', 4 * GB)?.quant).toBe('Q4_K_M')
    expect(pickChoice([choice('Q6_K', 22, true), choice('Q4_K_M', 16)], 'Q6_K')?.quant).toBe('Q4_K_M')
  })

  it.each([
    ['Huihui-Qwen3.8', '27B', 'Qwen3.8 27B'],
    ['Qwen3.8-Uncensored-HauhauCS-Aggressive', '27B', 'Qwen3.8 27B'],
    ['DavidAU-Qwen3.5-9B-The-Defiant', '9B', 'Qwen3.5 9B'],
    ['gemma-3', '270M', 'gemma 3 270M'],
  ])('cleans %s', (base, size, want) => expect(cleanModelName(base, size)).toBe(want))

  it('reads marks, names, quants and links', () => {
    expect(hasTweakMark('huihui-ai/Qwen3.8-27B')).toBe(true)
    expect(hasTweakMark('Qwen/Qwen3.8-27B')).toBe(false)
    expect(displayName('Qwen/Qwen3.8-27B')).toBe('Qwen 3.8 27B')
    expect(quantOfFile('Qwen3.8-27B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(repoFromUrl('https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE')).toBe('Qwen/Qwen3.8-27B')
    expect(repoFromUrl('https://evil.example/Qwen/Qwen3.8-27B')).toBeNull()
    expect(repoFromUrl('https://huggingface.co/../etc')).toBeNull()
  })

  it('reads only the fields it needs from a card', () => {
    expect(parseCard(JSON.stringify({ id: 'a/b', cardData: { base_model: ['c/d'], description: '<script>x</script>' } }), 'a/b')).toEqual({ id: 'a/b', baseModels: ['c/d'] })
    expect(parseCard(JSON.stringify({ id: 'a/b', tags: ['base_model:c/d', 'base_model:quantized:c/d'] }), 'a/b')).toEqual({ id: 'a/b', baseModels: ['c/d'] })
    expect(parseCard('{"error":"nope"}', 'a/b')).toBeNull()
    expect(parseCard('not json', 'a/b')).toBeNull()
  })
})
