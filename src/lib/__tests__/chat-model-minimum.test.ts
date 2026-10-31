import { describe, expect, it } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'
import { canAutoSelectChat, chatRecommendationGroups, installedChatSizeB, isBelowChatMinimum } from '../chat-model-minimum'
import { pickForMode } from '../active-model-mode'

describe('chat catalog minimum', () => {
  it('uses explicit installed metadata and safe total-size name boundaries', () => {
    expect(installedChatSizeB({ name: 'alias', details: { parameter_size: '7600M' } })).toBe(7.6)
    expect(installedChatSizeB({ name: 'alias-8B', details: { parameter_size: '3.8B' } })).toBe(3.8)
    expect(installedChatSizeB({ name: 'qwen3-30B-A3B' })).toBe(30)
    expect(installedChatSizeB({ name: 'unknown-A3B' })).toBeNull()
    expect(installedChatSizeB({ name: 'file-3GB-Q4_K_M' })).toBeNull()
    expect(canAutoSelectChat({ name: 'opaque-api-model' })).toBe(false)
    expect(canAutoSelectChat({ name: 'model-8B', type: 'image' })).toBe(false)
    expect(canAutoSelectChat({ name: 'model-7B', type: 'text' })).toBe(true)
  })

  it('applies the same minimum to mode fallback while honoring named choices', () => {
    const small = { name: 'test-3B', type: 'text', provider: 'openai' }
    const large = { name: 'test-7B', type: 'text', provider: 'openai' }
    const opaque = { name: 'opaque', type: 'text', provider: 'openai' }
    expect(pickForMode(null, [small, opaque, large], 'local').next).toBe(large.name)
    expect(pickForMode(null, [small, opaque], 'local').next).toBeNull()
    expect(pickForMode(small.name, [small, large], 'local').change).toBe(false)
    expect(pickForMode(null, [small, large], 'local', small.name)).toMatchObject({ next: small.name, usedRequest: true })
  })
  it('uses parameter counts, not quantization, file size or MoE active counts', () => {
    for (const tag of ['0.5B', '3B', '3.8B', '4B', '6.9B']) expect(isBelowChatMinimum({ tags: [tag] })).toBe(true)
    for (const tag of ['7B', '8B', '70B', '3 GB', 'Q4_K_M', 'A3B', '30B-A3B', 'unknown']) expect(isBelowChatMinimum({ tags: [tag] })).toBe(false)
  })

  it('covers every explicitly tagged sub-7B entry in both text catalogs', () => {
    const models = [...getUncensoredTextModels(), ...getMainstreamTextModels()]
    const small = models.filter(isBelowChatMinimum)
    // 12 -> 31 on 2026-10-08, catalog refresh: three old small entries left
    // (Qwen3 4B, Granite 4.0 Micro, Gemma 3 4B Abliterated), 22 came in, the
    // quants of nine current small models for 8 GB machines.
    // 31 -> 32 the same day: Gemma 4 E4B HauhauCS Q8_K_P (4.5B), reachable
    // once the download took the named file instead of resolving by quant.
    // 32 -> 40 on 2026-10-30 (N1): LFM3 1.7B, VL 2B, Omni 2B and Audio 2B,
    // each as Ollama tag and as MLX NVFP4 build.
    // 40 -> 46 the same day, after E1: six LFM3 GGUF rows (1.7B Q4_K_M, QAD
    // Q4_0, Q8_0; VL Q4_K_M, Q8_0; Omni Q4_K_M).
    expect(small.length).toBe(46)
    const picks = chatRecommendationGroups(models.map(model => [model]))
    expect(picks.flat().some(isBelowChatMinimum)).toBe(false)
    expect(picks.length).toBe(models.length - small.length)
    expect(small.find(model => model.filename === 'Hermes-3-Llama-3.2-3B.Q4_K_M.gguf')).toBeDefined()
  })

  it('excludes mixed-size groups so a selected small variant cannot become a pick', () => {
    const models = getUncensoredTextModels()
    const small = models.find(isBelowChatMinimum)!
    const large = models.find(model => model.tags.includes('8B'))!
    expect(chatRecommendationGroups([[], [small, large], [large]])).toEqual([[large]])
  })
})
