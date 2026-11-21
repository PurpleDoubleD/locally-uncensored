import { describe, it, expect } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'
import { forThisPlatform } from '../mlx-only-builds'
import { isAgentCompatible, isThinkingCompatible, isVisionCompatible } from '../model-compatibility'
import { isOllamaOlderThan, ollamaVersionBlock } from '../ollama-min-version'

const inkling = () => getMainstreamTextModels().find((m) => m.ollamaModel === 'inkling-2-mini')!

describe('a model that names the Ollama it needs', () => {
  it('compares versions by number', () => {
    expect(isOllamaOlderThan('0.40.13', '0.40.17')).toBe(true)
    expect(isOllamaOlderThan('0.40.17', '0.40.17')).toBe(false)
    expect(isOllamaOlderThan('0.40.100', '0.40.17')).toBe(false)
    expect(isOllamaOlderThan('0.41.0', '0.40.17')).toBe(false)
    expect(isOllamaOlderThan('v1.0.0', '0.40.17')).toBe(false)
  })

  it('counts a release candidate as older than its release', () => {
    expect(isOllamaOlderThan('0.40.17-rc4', '0.40.17')).toBe(true)
    expect(isOllamaOlderThan('0.40.18-rc1', '0.40.17')).toBe(false)
  })

  it('does not call a version it cannot read too old', () => {
    for (const v of [null, undefined, '', 'dev', '0.0.0']) {
      expect(isOllamaOlderThan(v, '0.40.17')).toBe(false)
    }
  })

  it('says what to do on an old Ollama and stays quiet on a new one', () => {
    const m = inkling()
    expect(ollamaVersionBlock(m, '0.40.13')).toBe(
      'Inkling 2 Mini (Ollama) needs Ollama 0.40.17 or newer. This Ollama is 0.40.13. Update Ollama, then press Get again.',
    )
    expect(ollamaVersionBlock(m, '0.40.17')).toBeNull()
    expect(ollamaVersionBlock(m, null)).toBeNull()
  })

  it('never blocks a model without a minimum', () => {
    expect(ollamaVersionBlock({ name: 'Other' }, '0.1.0')).toBeNull()
  })
})

describe('Inkling 2 Mini on Ollama', () => {
  it('matches the registry manifest read on 21.11.2026', () => {
    const m = inkling()
    expect(m.minOllama).toBe('0.40.17')
    expect(m.sizeGB).toBe(18.8)
    expect(m.agent).toBe(true)
  })

  it('is a Mac build: its weights are MLX safetensors', () => {
    expect(forThisPlatform([inkling()], false)).toEqual([])
    expect(forThisPlatform([inkling()], true)).toHaveLength(1)
  })

  it('links the maker\'s usage policy', () => {
    expect(inkling().usagePolicyUrl).toBe('https://thinkingmachines.ai/model-acceptable-use-policy/')
  })

  it('has no uncensored row while that decision is open', () => {
    const all = [...getMainstreamTextModels(), ...getUncensoredTextModels()]
    const rows = all.filter((m) => /inkling/i.test(`${m.name} ${m.ollamaModel ?? ''} ${m.downloadUrl ?? ''}`))
    expect(rows.filter((m) => /uncensored|abliterat|heretic/i.test(`${m.name} ${m.downloadUrl ?? ''}`))).toEqual([])
  })

  it.each(['inkling-2-mini', 'inkling-2-mini:26b-a5b-nvfp4', 'unsloth/Inkling-2-Mini-GGUF:Q4_K_M'])(
    '%s takes tools, thinking and images',
    (name) => {
      expect(isAgentCompatible(name)).toBe(true)
      expect(isThinkingCompatible(name)).toBe(true)
      expect(isVisionCompatible(name)).toBe(true)
    },
  )
})
