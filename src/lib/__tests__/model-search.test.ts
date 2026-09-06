/**
 * The Installed search answers to catalogue spelling.
 *
 * Measured 2026-09-05: "Llama 3.2 3B Abliterated" found the catalogue tile and
 * then, on the Installed tab, matched nothing although
 * openai::Llama-3.2-3B-Instruct-abliterated.Q4_K_M was installed.
 *
 * Run: npx vitest run src/lib/__tests__/model-search.test.ts
 */
import { describe, it, expect } from 'vitest'
import { installedRowMatchesSearch } from '../model-search'

const ROW = 'openai::Llama-3.2-3B-Instruct-abliterated.Q4_K_M'

describe('installedRowMatchesSearch', () => {
  it('matches the catalogue name of the file that was just downloaded (the measured case)', () => {
    expect(installedRowMatchesSearch(ROW, 'Llama 3.2 3B Abliterated')).toBe(true)
  })
  it('still matches a plain substring of the row id', () => {
    expect(installedRowMatchesSearch(ROW, 'abliterated.Q4')).toBe(true)
  })
  it('takes the words in any order and any case', () => {
    expect(installedRowMatchesSearch(ROW, 'ABLITERATED llama')).toBe(true)
  })
  it('does not match a word the row does not carry', () => {
    expect(installedRowMatchesSearch(ROW, 'Llama 3.2 3B Heretic')).toBe(false)
    expect(installedRowMatchesSearch(ROW, 'Gemma')).toBe(false)
  })
  it('an empty search matches everything', () => {
    expect(installedRowMatchesSearch(ROW, '')).toBe(true)
    expect(installedRowMatchesSearch(ROW, '   ')).toBe(true)
  })
})
