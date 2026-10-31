/**
 * N1, 30.10.2026: was die vier LFM3-Modelle koennen, steht in ihren
 * Ollama-Manifesten (config-Blob, "capabilities"), gelesen am selben Tag:
 *
 *   lfm3:1.7b       completion, tools, thinking
 *   lfm3-vl:2b      completion, vision, tools, thinking
 *   lfm3-omni:2b    completion, vision, audio, speech, tools
 *   lfm3-audio:2b   completion, audio, speech, tools
 *
 * LU entscheidet Think-Knopf, Bildeingang und Agent fuer Ollama am Namen.
 * Ohne Eintrag waren alle vier "Text ohne Werkzeuge, ohne Denken".
 */
import { describe, expect, it } from 'vitest'
import { isAgentCompatible, isThinkingCompatible, isVisionCompatible } from '../model-compatibility'

const FAEHIG: Record<string, { tools: boolean; think: boolean; vision: boolean }> = {
  'lfm3:1.7b': { tools: true, think: true, vision: false },
  'lfm3:1.7b-nvfp4': { tools: true, think: true, vision: false },
  'lfm3-vl:2b': { tools: true, think: true, vision: true },
  'lfm3-omni:2b': { tools: true, think: false, vision: true },
  'lfm3-audio:2b': { tools: true, think: false, vision: false },
}

describe('LFM3: Werkzeuge, Denken und Bildeingang wie im Manifest', () => {
  for (const [name, f] of Object.entries(FAEHIG)) {
    it(name, () => {
      expect(isAgentCompatible(name)).toBe(f.tools)
      expect(isThinkingCompatible(name)).toBe(f.think)
      expect(isVisionCompatible(name)).toBe(f.vision)
    })
  }

  it('LFM 2.5 bleibt, wie es war', () => {
    expect(isThinkingCompatible('lfm2.5:2.6b')).toBe(false)
    expect(isVisionCompatible('lfm2.5:2.6b')).toBe(false)
  })
})
