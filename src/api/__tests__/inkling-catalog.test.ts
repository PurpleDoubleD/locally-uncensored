/**
 * Inkling 2 Mini as GGUF: the rows are exact, and they stay hidden until the
 * pinned engine has really loaded the model.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INKLING_ENGINE_LOADED, INKLING_USAGE_POLICY, inklingCatalogEntries, inklingEntriesUngated,
} from '../inkling-catalog'
import { getMainstreamTextModels, getUncensoredTextModels } from '../discover'
import { parsePinnedLlamaTag } from '../gguf-arch'

const REPO = 'bartowski/thinkingmachines_Inkling-2-Mini-GGUF'
const rows = inklingEntriesUngated()

describe('the Inkling 2 Mini catalog rows', () => {
  it('names each file of the vetted repository once, with its exact size and digest', () => {
    expect(rows).toHaveLength(23)
    expect(new Set(rows.map((m) => m.filename)).size).toBe(rows.length)
    for (const m of rows) {
      expect(m.downloadUrl).toBe(`https://huggingface.co/${REPO}/resolve/main/${m.filename}`)
      expect(m.filename).toMatch(/^thinkingmachines_Inkling-2-Mini-[A-Za-z0-9_]+\.gguf$/)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Number.isSafeInteger(m.sizeBytes)).toBe(true)
      expect(m.sizeGB).toBeCloseTo(m.sizeBytes! / 1024 ** 3, 2)
    }
  })

  it('brings the image part and the maker\'s policy with every row', () => {
    for (const m of rows) {
      expect(m.tags).toContain('Vision')
      expect(m.mmprojUrl).toBe(`https://huggingface.co/${REPO}/resolve/main/mmproj-thinkingmachines_Inkling-2-Mini-f16.gguf`)
      expect(m.mmprojBytes).toBe(639348512)
      expect(m.mmprojSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.usagePolicyUrl).toBe(INKLING_USAGE_POLICY)
    }
  })

  it('leaves out IQ4_NL and the imatrix file, and offers Q4_K_M first', () => {
    expect(rows.some((m) => /IQ4_NL|imatrix/i.test(m.filename!))).toBe(false)
    expect(rows[0].name).toBe('Inkling 2 Mini Q4_K_M')
  })

  it('carries no uncensored variant', () => {
    for (const m of rows) expect(`${m.name} ${m.description} ${m.filename}`).not.toMatch(/uncensored|abliterat|heretic/i)
    expect(getUncensoredTextModels().some((m) => /inkling/i.test(m.name))).toBe(false)
  })

  it('is open only on a pin that knows inkling2_loop', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../scripts/build-llama.sh', import.meta.url)), 'utf8')
    const build = Number(parsePinnedLlamaTag(script)?.replace(/^b/, ''))
    if (INKLING_ENGINE_LOADED) expect(build).toBeGreaterThanOrEqual(12600)
  })

  it('shows nothing until the engine has loaded it', () => {
    expect(inklingCatalogEntries(false)).toEqual([])
    expect(inklingCatalogEntries(true)).toHaveLength(rows.length)
    const shown = getMainstreamTextModels().filter((m) => m.group === 'Inkling 2 Mini')
    expect(shown).toHaveLength(INKLING_ENGINE_LOADED ? rows.length : 0)
  })
})
