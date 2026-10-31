/**
 * FEHLER-N2 #1 (T1, 31.10.2026): "Get the original: Qwen3.5 9B" showed the
 * changed model the user came from as the first Hugging Face hit. In that
 * search the originals come first, the changed versions after them.
 *
 * Run: npx vitest run src/lib/__tests__/original-search.test.ts
 */
import { describe, it, expect } from 'vitest'
import { looksTweaked, originalsFirst } from '../original-search'
import type { DiscoverModel } from '../../api/discover'

const hit = (repo: string): DiscoverModel => ({
  name: repo.split('/')[1].replace(/-GGUF$/i, ''), description: repo, pulls: '1K', tags: [], updated: '',
})

describe('original search', () => {
  it('knows a changed model by its name, and leaves the maker\'s own alone', () => {
    for (const r of [
      'DavidAU/Qwen3.5-9B-The-Defiant-Heretic-Uncensored-GGUF',
      'mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF',
      'someone/Qwen3.5-9B-Claude-Distill-GGUF',
      'someone/Qwen3.5-9B-RP-GGUF',
      'someone/Qwen3.5-9B-MTP-GGUF',
    ]) expect(looksTweaked(r), r).toBe(true)
    for (const r of ['unsloth/Qwen3.5-9B-GGUF', 'Qwen/Qwen3.5-9B-Instruct-GGUF', 'bartowski/Qwen_Qwen3.5-9B-GGUF', 'someone/Sharp-Qwen3.5-9B-GGUF'])
      expect(looksTweaked(r), r).toBe(false)
  })

  it('puts the originals first, plain uploaders on top, and the changed ones after', () => {
    const hf = ['DavidAU/Qwen3.5-9B-The-Defiant-Heretic-GGUF', 'mradermacher/Qwen3.5-9B-GGUF', 'unsloth/Qwen3.5-9B-GGUF', 'x/Qwen3.5-9B-abliterated-GGUF'].map(hit)
    const { originals, changed } = originalsFirst(hf)
    expect(originals.map((m) => m.description)).toEqual(['unsloth/Qwen3.5-9B-GGUF', 'mradermacher/Qwen3.5-9B-GGUF'])
    expect(changed.map((m) => m.description)).toEqual(['DavidAU/Qwen3.5-9B-The-Defiant-Heretic-GGUF', 'x/Qwen3.5-9B-abliterated-GGUF'])
  })
})
