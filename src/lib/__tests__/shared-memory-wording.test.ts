import { describe, it, expect } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'
import { chatModelBudgetGb, pcHardwareLeft, sharedFitWords, sharedMemoryWording, SHARED_MEMORY_MODEL_SHARE } from '../shared-memory-wording'

// The chat catalogue is written from a PC. On a Mac (one memory pool, no
// card) the same sentences are rewritten at the point of display.

const catalogue = [...getMainstreamTextModels(), ...getUncensoredTextModels()]
const sentences = catalogue.flatMap((m) => [m.description, m.blurb ?? ''].filter(Boolean))

describe('the chat catalogue as a Mac reads it', () => {
  it('a card becomes free memory, with the number kept', () => {
    expect(sharedMemoryWording('smallest quant, fits a 12 GB card.', true)).toBe('smallest quant, fits in 12 GB of free memory.')
    expect(sharedMemoryWording('smallest dynamic quant, runs on an 8 GB card.', true)).toBe('smallest dynamic quant, runs in 8 GB of free memory.')
    expect(sharedMemoryWording('Q5, higher quality. For 24 GB cards.', true)).toBe('Q5, higher quality. For 24 GB of free memory.')
    expect(sharedMemoryWording('For 20 GB+ cards.', true)).toBe('For 20 GB+ of free memory.')
    expect(sharedMemoryWording('Close to Q4_K_M on 16 GB cards.', true)).toBe('Close to Q4_K_M in 16 GB of free memory.')
    expect(sharedMemoryWording('30B unfiltered, fits 12GB VRAM.', true)).toBe('30B unfiltered, fits in 12 GB of free memory.')
    expect(sharedMemoryWording('For high-VRAM setups.', true)).toBe('For Macs with a lot of memory.')
  })

  it('NVFP4 and MXFP8 say at the source what they are: MLX builds for Apple Silicon', () => {
    // Ollama labels these tags "MLX" (ollama.com/library/qwen3.6/tags) and
    // refuses them on a standard Windows or Linux install. The names are
    // NVIDIA's, so the sentence must not send an NVIDIA owner to them.
    const builds = catalogue.filter((m) => /-(?:nvfp4|mxfp8)$/.test(m.ollamaModel ?? ''))
    expect(builds.map((m) => m.ollamaModel).sort()).toEqual([
      // N1, 30.10.2026: the LFM3 family's MLX builds, read off ollama.com/library/lfm3*.
      'lfm3-audio:2b-nvfp4',
      'lfm3-omni:2b-nvfp4',
      'lfm3-vl:2b-nvfp4',
      'lfm3:1.7b-nvfp4',
      'qwen3.6:35b-a3b-coding-mxfp8',
      'qwen3.6:35b-a3b-coding-nvfp4',
      'qwen3.6:35b-a3b-mxfp8',
      'qwen3.6:35b-a3b-nvfp4',
    ])
    for (const m of builds) {
      // The same sentence on a PC and on a Mac: nothing is left to rewrite.
      expect(sharedMemoryWording(m.description, true)).toBe(m.description)
      expect(m.description).toContain('an MLX build in Ollama made for Apple Silicon Macs')
      expect(m.description).toContain('Not officially supported on Windows or Linux')
      expect(m.description).not.toMatch(/RTX|Blackwell|H100|MI300X|datacenter|NVIDIA|\bcards?\b|VRAM/)
      expect(m.tags).toContain('MLX')
      // The size is the one Ollama lists for the tag.
      if (m.ollamaModel!.startsWith('qwen3.6')) {
        expect(m.sizeGB).toBe(/nvfp4$/.test(m.ollamaModel!) ? 24 : 38)
        expect(m.tags).toContain(`${m.sizeGB} GB`)
      } else {
        // The LFM3 builds are a few GB; the tag rounds the manifest layer sum.
        expect(m.tags).toContain(`${m.sizeGB!.toFixed(1)} GB`)
      }
    }
  })

  it('GUARD: no sentence of the catalogue still names PC hardware on a Mac', () => {
    const left = sentences
      .map((s) => ({ s, hits: pcHardwareLeft(sharedMemoryWording(s, true)) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.hits.join(', ')}: ${x.s}`)
    expect(left).toEqual([])
  })

  it('COUNTER-CHECK: the guard is not blind, the untouched catalogue does name cards', () => {
    expect(sentences.filter((s) => pcHardwareLeft(s).length > 0).length).toBeGreaterThan(10)
  })

  it('a PC reads every sentence exactly as it is written', () => {
    for (const s of sentences) expect(sharedMemoryWording(s, false)).toBe(s)
  })

  it('"model card" is a document and stays', () => {
    const s = 'The model card names no license.'
    expect(sharedMemoryWording(s, true)).toBe(s)
    expect(pcHardwareLeft(s)).toEqual([])
  })
})

describe('what a chat model is compared with', () => {
  it('on a PC it is the detected card, untouched', () => {
    expect(chatModelBudgetGb(false, 12, 64)).toBe(12)
    expect(chatModelBudgetGb(false, null, 64)).toBeNull()
  })

  it('on a Mac it is a share of the one pool, never the whole of it', () => {
    expect(SHARED_MEMORY_MODEL_SHARE).toBeLessThan(1)
    expect(chatModelBudgetGb(true, null, 16)).toBe(11)
    expect(chatModelBudgetGb(true, null, 32)).toBe(22)
    // The pool wins over whatever a graphics probe reported.
    expect(chatModelBudgetGb(true, 8, 64)).toBe(45)
    expect(chatModelBudgetGb(true, null, null)).toBeNull()
  })
})

describe('the verdict in words', () => {
  it('names this Mac and its memory, never a PC, a GPU or a CPU', () => {
    for (const fit of ['fits', 'tight', 'big', 'unknown'] as const) {
      const w = sharedFitWords(fit)
      expect(`${w.label} ${w.title}`).not.toMatch(/\bPC\b|GPU|CPU|VRAM|card/)
    }
    expect(sharedFitWords('fits').label).toBe('Runs on this Mac')
    expect(sharedFitWords('big').label).toBe('Needs more memory')
  })
})
