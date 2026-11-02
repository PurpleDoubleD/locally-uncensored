/**
 * D7, GitHub #215: the behaviour alone, through functions that existed before
 * the fix, so this file is red on the old code by its answer and not by a
 * missing export. 16 GB card, budget 14.4 GiB in bytes.
 *
 * Run: npx vitest run src/api/__tests__/a-guessed-quant-fits-the-card-behaviour.test.ts
 */
import { describe, it, expect } from 'vitest'
import { selectGgufFromTree, type HfTreeEntry } from '../discover'
import { defaultChoice, ggufChoicesFromTree } from '../../lib/hf-link'

const GB = 1_000_000_000
const file = (quant: string, gb: number): HfTreeEntry => ({ type: 'file', path: `M-27B-${quant}.gguf`, size: Math.round(gb * GB) })
const TREE = [file('Q2_K', 10.2), file('Q3_K_M', 12.9), file('Q4_K_M', 15.8), file('Q4_K_L', 16.8)]
const BUDGET_16 = Math.floor(14.4 * 1_073_741_824)

describe('GitHub #215 on a 16 GB card', () => {
  it('a guessed Q4_K_M of 15.8 GB becomes the Q3_K_M', () => {
    const select = selectGgufFromTree as (...a: unknown[]) => ReturnType<typeof selectGgufFromTree>
    expect(select(TREE, 'o/M-27B-GGUF', 'Q4_K_M', undefined, BUDGET_16)?.quant).toBe('Q3_K_M')
  })
  it('the link dialog preselects the Q3_K_M', () => {
    const pick = defaultChoice as (...a: unknown[]) => ReturnType<typeof defaultChoice>
    expect(pick(ggufChoicesFromTree(TREE), BUDGET_16)?.quant).toBe('Q3_K_M')
  })
})
