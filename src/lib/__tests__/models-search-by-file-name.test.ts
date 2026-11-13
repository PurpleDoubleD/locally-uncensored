// Models search by file name (Discord, 12.11.2026): the user had
// Gemma 4 12B Abliterated on disk under its uploader's file name and could
// not find it again on the Models page.
//
// Run: npx vitest run src/lib/__tests__/models-search-by-file-name.test.ts
import { describe, expect, it } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'
import {
  catalogEntryMatchesSearch,
  catalogNamesByFile,
  catalogNamesFor,
  installedModelMatchesSearch,
} from '../model-search'
import { bundlesForTabAndSearch } from '../discover-bundle-search'

const catalog = [...getUncensoredTextModels(), ...getMainstreamTextModels()]
const ABLIT = catalog.find((m) => m.name === 'Gemma 4 12B Abliterated')!
const FILE = 'Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K'

describe('Get new: a catalogue entry answers to its file', () => {
  it('the real entry is in the catalogue with that file', () => {
    expect(ABLIT?.filename).toBe(`${FILE}.gguf`)
  })

  it('found by the full file name, with or without .gguf', () => {
    expect(catalogEntryMatchesSearch(ABLIT, FILE)).toBe(true)
    expect(catalogEntryMatchesSearch(ABLIT, `${FILE}.gguf`)).toBe(true)
  })

  it('found by a piece of the file name and by the uploader', () => {
    expect(catalogEntryMatchesSearch(ABLIT, 'huihui')).toBe(true)
    expect(catalogEntryMatchesSearch(ABLIT, 'qat q4_0 unquantized')).toBe(true)
    expect(catalogEntryMatchesSearch(ABLIT, 'huihui-ai/Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF')).toBe(true)
  })

  it('found by its image part file', () => {
    expect(catalogEntryMatchesSearch(ABLIT, 'mmproj-model-bf16')).toBe(true)
  })

  it('still found by its name and description, and not by something else', () => {
    expect(catalogEntryMatchesSearch(ABLIT, 'Gemma 4 12B Abliterated')).toBe(true)
    expect(catalogEntryMatchesSearch(ABLIT, 'first solid gemma 4 uncensor')).toBe(true)
    expect(catalogEntryMatchesSearch(ABLIT, 'qwen')).toBe(false)
  })

  it('in the whole catalogue the file name finds exactly that entry', () => {
    const hits = catalog.filter((m) => catalogEntryMatchesSearch(m, FILE))
    expect(hits.map((m) => m.name)).toEqual(['Gemma 4 12B Abliterated'])
  })
})

describe('Installed: a file answers to its catalogue name', () => {
  const byFile = catalogNamesByFile(catalog)

  it('the LU Engine row of that file is found by "Gemma 4 12B Abliterated"', () => {
    const row = `openai::${FILE}`
    expect(catalogNamesFor(row, byFile)).toContain('Gemma 4 12B Abliterated')
    expect(installedModelMatchesSearch(row, catalogNamesFor(row, byFile), 'Gemma 4 12B Abliterated')).toBe(true)
    expect(installedModelMatchesSearch(row, catalogNamesFor(row, byFile), FILE)).toBe(true)
  })

  it('a file the catalogue does not know keeps the old rule', () => {
    const row = 'openai::my-own-finetune-Q5_K_M'
    expect(catalogNamesFor(row, byFile)).toEqual([])
    expect(installedModelMatchesSearch(row, [], 'own finetune')).toBe(true)
    expect(installedModelMatchesSearch(row, [], 'gemma')).toBe(false)
  })
})

describe('Image and video bundles answer to their files', () => {
  it('a bundle is found by one of its file names', () => {
    const bundles = [
      { name: 'Some Video', description: 'video model', files: [{ name: 'x', filename: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors' }] },
      { name: 'Other', description: 'other', files: [{ name: 'y', filename: 'flux1-dev.safetensors' }] },
    ]
    expect(bundlesForTabAndSearch(bundles, 'mainstream', 'wan2.2_t2v_low_noise').map((b) => b.name)).toEqual(['Some Video'])
  })
})
