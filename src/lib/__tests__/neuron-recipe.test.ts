/**
 * N2 (3.0.9): neuron recipes, the "coordinates" people share. LU reads the
 * codes in use (neuronary "L13N7956-1.0", gguf-neuron-explorer "14:8949:+1.0",
 * "L9 N9009 +0.7"), its own sliders and links, and refuses everything else
 * with a reason: a recipe carries numbers and example sentences, nothing
 * that could run.
 *
 * Run: npx vitest run src/lib/__tests__/neuron-recipe.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  coordsLine, featureVectorId, modelFit, neuronVectorId, normalizeModelName, parseRecipe, recipeLink, recipeOwnId, recipeText,
  type Recipe,
} from '../neuron-recipe'

const PRESETS = new Set(['creative', 'detailed', 'casual', 'cheerful', 'refusals'])
const ok = (s: string) => {
  const r = parseRecipe(s, PRESETS)
  if (!r.ok) throw new Error(r.error)
  return r
}
const bad = (s: string) => {
  const r = parseRecipe(s, PRESETS)
  if (r.ok) throw new Error(`accepted: ${s}`)
  return r.error
}

describe('reading coordinates people share', () => {
  it('reads the neuronary form with its model', () => {
    const r = ok('Qwen3.5-4B: L13N7956-1.0 L14N8949+1.0')
    expect(r.recipe.model).toBe('Qwen3.5-4B')
    expect(r.recipe.entries).toEqual([
      { kind: 'neuron', layer: 13, neuron: 7956, dose: -1 },
      { kind: 'neuron', layer: 14, neuron: 8949, dose: 1 },
    ])
  })

  it('reads the colon form and the spaced form', () => {
    expect(ok('14:8949:+1.0').recipe.entries).toEqual([{ kind: 'neuron', layer: 14, neuron: 8949, dose: 1 }])
    expect(ok('L9 N9009 +0.7, L26 N6173 +0.3').recipe.entries).toEqual([
      { kind: 'neuron', layer: 9, neuron: 9009, dose: 0.7 },
      { kind: 'neuron', layer: 26, neuron: 6173, dose: 0.3 },
    ])
    expect(ok('L22 N8295 −0.4').recipe.entries).toEqual([{ kind: 'neuron', layer: 22, neuron: 8295, dose: -0.4 }])
  })

  it('reads a negative ready slider, whose id may hold dashes', () => {
    expect(ok('@detailed-0.40 @cheerful+0.5').recipe.entries).toEqual([
      { kind: 'preset', id: 'detailed', strength: -0.4 },
      { kind: 'preset', id: 'cheerful', strength: 0.5 },
    ])
    expect(parseRecipe('@more-refusals-0.3', new Set(['more-refusals'])).ok).toBe(true)
    expect(bad('@cheerful0.5')).toMatch(/not a coordinate/)
  })

  it('reads LU sliders and features', () => {
    expect(ok('@cheerful+0.6 F11690+0.8').recipe.entries).toEqual([
      { kind: 'preset', id: 'cheerful', strength: 0.6 },
      { kind: 'feature', feature: 11690, strength: 0.8 },
    ])
  })

  it('keeps the last value of a coordinate given twice, and says so', () => {
    const r = ok('L1N2+0.5 L1N2-0.5')
    expect(r.recipe.entries).toEqual([{ kind: 'neuron', layer: 1, neuron: 2, dose: -0.5 }])
    expect(r.notes.join(' ')).toMatch(/twice/)
  })
})

describe('refusing what does not fit', () => {
  it('refuses what other programs do that LU cannot', () => {
    expect(bad('L12E12N1234+0.6')).toMatch(/mixture-of-experts/)
    expect(bad('22:2742:x4')).toMatch(/gain/)
    expect(bad('21:H7:x0')).toMatch(/gain/)
    expect(bad('30:dir:yandere:+0.3')).toMatch(/direction file/)
  })

  it('refuses unknown sliders, wild numbers and garbage', () => {
    expect(bad('@pirate+0.5')).toMatch(/no ready slider/)
    expect(bad('@cheerful+1.5')).toMatch(/outside/)
    expect(bad('L1N2+3.5')).toMatch(/outside/)
    expect(bad('L999N2+0.5')).toMatch(/too large/)
    expect(bad('rm -rf /')).toMatch(/not a coordinate/)
    expect(bad('')).toMatch(/Paste/)
    expect(bad('L1N2+0.5 '.repeat(2000))).toMatch(/Too long/)
    expect(bad(Array.from({ length: 30 }, (_, i) => `L1N${i}+0.1`).join(' '))).toMatch(/at most 24/)
  })

  it('refuses hidden characters and foreign addresses', () => {
    expect(bad('L1N2+0.5‮')).toMatch(/hidden/)
    expect(bad('L1N2+0.5\u0007')).toMatch(/hidden/)
    expect(bad('https://example.com/evil.gguf')).toMatch(/no other web addresses/)
    expect(bad('file:///etc/passwd')).toMatch(/no other web addresses/)
  })
})

describe('LU links', () => {
  const recipe: Recipe = {
    model: 'Qwen2.5-0.5B-Instruct',
    entries: [
      { kind: 'preset', id: 'cheerful', strength: 0.6 },
      { kind: 'neuron', layer: 13, neuron: 7956, dose: -1 },
      { kind: 'own', name: 'Pirate', more: ['Talk like a pirate.', 'Say arr.'], less: ['Talk plainly.'], strength: 0.5 },
    ],
  }

  it('goes out and comes back unchanged, own sliders included', () => {
    const link = recipeLink(recipe)
    expect(link.startsWith('locallyuncensored://neuron?v=1&')).toBe(true)
    const back = ok(link)
    expect(back.recipe).toEqual(recipe)
    // The copy line is readable and carries the same link.
    const text = recipeText(recipe)
    expect(text.split('\n')[0]).toBe('LU neurons · Qwen2.5-0.5B-Instruct · @cheerful+0.60 L13N7956-1.00')
    expect(ok(text).recipe).toEqual(recipe)
    expect(coordsLine(recipe)).toBe('@cheerful+0.60 L13N7956-1.00')
  })

  it('reads the copy line alone, without the link', () => {
    const r = ok('LU neurons · Qwen2.5-0.5B-Instruct · @cheerful+0.60 L13N7956-1.00')
    expect(r.recipe.model).toBe('Qwen2.5-0.5B-Instruct')
    expect(r.recipe.entries).toHaveLength(2)
  })

  it('refuses links with anything a neuron link never has', () => {
    expect(bad('locallyuncensored://neuron?v=1&c=L1N2%2B0.5&url=https://x')).toMatch(/never has/)
    expect(bad('locallyuncensored://neuron?v=1&c=L1N2%2B0.5&c=L1N3%2B0.5')).toMatch(/twice/)
    expect(bad('locallyuncensored://open-model?repo=a/b')).toMatch(/not an LU neuron link/)
    expect(bad('locallyuncensored://neuron/../x?v=1&c=L1N2%2B0.5')).toMatch(/not an LU neuron link/)
    expect(bad('locallyuncensored://neuron?v=2&c=L1N2%2B0.5')).toMatch(/newer LU/)
    expect(bad('locallyuncensored://neuron?v=1&o=%5B%7B%22n%22%3A%22x%22%2C%22s%22%3A0.5%2C%22m%22%3A%5B%22a%22%5D%2C%22l%22%3A%5B%22b%22%5D%2C%22cmd%22%3A%22rm%22%7D%5D')).toMatch(/fields LU does not read/)
    expect(bad('locallyuncensored://neuron?v=1&o=not-json')).toMatch(/damaged/)
    expect(bad('locallyuncensored://neuron?v=1&o=' + encodeURIComponent(JSON.stringify([{ n: 'x', s: 0.5, m: ['a\nb'], l: ['c'] }])))).toMatch(/example lines/)
  })
})

describe('model names and ids', () => {
  it('sees the same model in a repo name and a file name', () => {
    expect(normalizeModelName('Qwen/Qwen3.5-4B')).toBe('qwen354b')
    expect(normalizeModelName('qwen3.5-4b-q8_0.gguf')).toBe('qwen354b')
    expect(modelFit('Qwen/Qwen3.5-4B', 'Qwen3.5 4B', 'qwen3.5-4b-q8_0')).toBe('same')
    expect(modelFit('Qwen/Qwen3.5-4B', 'Qwen2.5 0.5B Instruct', 'qwen2.5-0.5b-instruct-q8_0')).toBe('other')
    expect(modelFit(null, 'x')).toBe('unknown')
  })

  it('gives an own slider from a recipe the same id every time, one Rust accepts', () => {
    const e = { kind: 'own' as const, name: 'Pirate talk!', more: ['a'], less: ['b'], strength: 0.5 }
    const id = recipeOwnId(e)
    expect(id).toBe(recipeOwnId({ ...e, strength: -1 }))
    expect(id).not.toBe(recipeOwnId({ ...e, more: ['c'] }))
    expect(id).toMatch(/^own-pirate-talk-r[0-9a-f]+$/)
    expect(id.length).toBeLessThanOrEqual(48)
    expect(featureVectorId('gemma-scope-2-270m-it-l9', 11690)).toBe('f-g270m-11690')
    expect(featureVectorId('gemma-scope-2-1b-it-l13', 5)).toBe('f-g1b-5')
    expect(neuronVectorId(13, 7956)).toBe('n-L13-N7956')
  })
})
