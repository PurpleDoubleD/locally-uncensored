/** N1: LFM3 Audio's part is a sound part; the Get button said "image input". */
import { describe, expect, it } from 'vitest'
import { partInputWord } from '../image-part'
import { getMainstreamTextModels } from '../../api/discover'

describe('was der Teil neben dem Modell tut', () => {
  it('Audio ohne Vision ist Toneingang, alles andere bleibt Bildeingang', () => {
    expect(partInputWord({ tags: ['2B', 'Audio'] })).toBe('sound input')
    expect(partInputWord({ tags: ['2B', 'Vision', 'Audio'] })).toBe('image input')
    expect(partInputWord({ tags: ['27B', 'Vision'] })).toBe('image input')
    expect(partInputWord({})).toBe('image input')
  })

  it('der Katalogeintrag LFM3 Audio 2B (GGUF) heisst Toneingang', () => {
    const audio = getMainstreamTextModels().find((m) => m.filename === 'LFM3-Audio-2B-Q4_K_M.gguf')!
    expect(partInputWord(audio)).toBe('sound input')
  })
})
