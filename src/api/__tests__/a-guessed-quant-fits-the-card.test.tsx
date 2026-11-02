/**
 * @vitest-environment jsdom
 *
 * D7, GitHub #215 (Windows, RTX 5070 Ti 16 GB): the Hugging Face search in
 * Models offered Huihui-Qwen3.8-27B-…-GGUF and fetched its Q4_K_M, 15.8 GB,
 * on a 16 GB card. No room for the context, so it ran mostly on the CPU. The
 * search only guessed Q4_K_M from the repo name, and the download took the
 * guess although the repository's file list had every quant with its size.
 *
 * Now a quant nobody chose is taken by size: the largest that leaves the
 * memory minus max(1.5 GB, 10 %). A file the user or the catalog names is
 * never swapped. The link dialog preselects the same way and marks the
 * files that won't fit.
 *
 * Run: npx vitest run src/api/__tests__/a-guessed-quant-fits-the-card.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const backend = vi.hoisted(() => ({
  fetchExternal: vi.fn(async (_url: string) => ''),
  backendCall: vi.fn(async (_cmd: string): Promise<unknown> => null),
}))
vi.mock('../backend', () => ({
  ...backend,
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  openExternal: vi.fn(),
}))
const memory = vi.hoisted(() => ({ gb: 16 }))
vi.mock('../../lib/hardware', async (orig) => ({
  ...(await orig<typeof import('../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => memory.gb),
}))

import {
  ggufRequestFor, quantBudgetBytes, searchHuggingFaceModels, selectGgufFromTree, type HfTreeEntry,
} from '../discover'
import { quantFitNote } from '../../components/models/DiscoverModels'
import { defaultChoice, ggufChoicesFromTree, overBudgetLabel } from '../../lib/hf-link'
import { HfLinkDialog } from '../../components/models/HfLinkDialog'

const GB = 1_000_000_000 // Hugging Face states sizes in bytes; it shows decimal GB.
const REPO = 'huihui-ai/Huihui-Qwen3.8-27B-Coder-abliterated-GGUF'
const file = (quant: string, gb: number): HfTreeEntry => ({
  type: 'file', path: `Huihui-Qwen3.8-27B-Coder-abliterated-${quant}.gguf`, size: Math.round(gb * GB),
})
// The sizes of the report: Q4_K_M 15.8 GB, Q4_K_L 16.8 GB, Q3_K_M below.
const TREE: HfTreeEntry[] = [
  file('Q2_K', 10.2), file('Q3_K_M', 12.9), file('Q4_K_M', 15.8), file('Q4_K_L', 16.8), file('Q5_K_M', 18.4),
  { type: 'file', path: 'README.md', size: 2000 },
]
const BUDGET_16 = quantBudgetBytes(16)!

afterEach(() => { cleanup(); vi.clearAllMocks(); memory.gb = 16 })

describe('the memory budget', () => {
  it('is the memory minus max(1.5 GB, 10 %), in bytes of GiB', () => {
    expect(BUDGET_16).toBe(Math.floor(14.4 * 1_073_741_824))
    expect(quantBudgetBytes(8)).toBe(Math.floor(6.5 * 1_073_741_824))
    expect(quantBudgetBytes(24)).toBe(Math.floor(21.6 * 1_073_741_824))
    expect(quantBudgetBytes(null)).toBeUndefined()
    expect(quantBudgetBytes(1)).toBeUndefined()
  })
})

describe('a search hit with a guessed quant', () => {
  it('THE REPORT: on 16 GB the download takes Q3_K_M, not the 15.8 GB Q4_K_M', () => {
    const picked = selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, BUDGET_16)
    expect(picked?.quant).toBe('Q3_K_M')
    expect(picked?.fitSwap).toEqual({ from: 'Q4_K_M', fromBytes: 15.8 * GB })
    expect(picked?.files.map((f) => f.filename)).toEqual(['Huihui-Qwen3.8-27B-Coder-abliterated-Q3_K_M.gguf'])
  })

  it('a card with room keeps Q4_K_M, a bigger one still never gets more than the guess fits', () => {
    expect(selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, quantBudgetBytes(24))?.quant).toBe('Q4_K_M')
    expect(selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, quantBudgetBytes(24))?.fitSwap).toBeUndefined()
  })

  it('when nothing fits, the guess stays and says so', () => {
    const picked = selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, quantBudgetBytes(8))
    expect(picked?.quant).toBe('Q4_K_M')
    expect(picked?.overBudget).toBe(true)
  })

  it('a file the caller names is never swapped, however big', () => {
    const named = selectGgufFromTree(TREE, REPO, 'Q4_K_M', TREE[3].path, BUDGET_16)
    expect(named?.quant).toBe('Q4_K_L')
    expect(named?.fitSwap).toBeUndefined()
  })

  it('the search marks a repo name without a quant as guessed, and its request names no file', async () => {
    backend.fetchExternal.mockResolvedValueOnce(JSON.stringify([
      { id: REPO, downloads: 5000 },
      { id: 'org/Model-7B-Q5_K_M-GGUF', downloads: 10 },
    ]))
    const [guessed, named] = await searchHuggingFaceModels('huihui qwen')
    expect(guessed.quantGuessed).toBe(true)
    expect(guessed.tags).toEqual(['GGUF'])
    expect(named.quantGuessed).toBeUndefined()
    const request = ggufRequestFor(guessed)
    expect(request?.quantGuessed).toBe(true)
    expect(request?.exactPath).toBeUndefined()
    expect(ggufRequestFor(named)?.exactPath).toBe('Model-7B-Q5_K_M.gguf')
  })

  it('the line under the list says what was picked and why', () => {
    const picked = selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, BUDGET_16)
    const note = quantFitNote('Huihui-Qwen3.8-27B', picked, 16, false)
    expect(note).toContain('LU picked Q3_K_M (12.0 GB)')
    expect(note).toContain('your 16 GB of graphics memory')
    expect(note).toContain('Q4_K_M (14.7 GB) would not fit fully')
    expect(quantFitNote('x', selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, quantBudgetBytes(24)), 24, false)).toBeNull()
    expect(quantFitNote('x', selectGgufFromTree(TREE, REPO, 'Q4_K_M', undefined, quantBudgetBytes(8)), 8, false)).toContain("no quant of it fits fully")
  })
})

describe('the Hugging Face link dialog', () => {
  it('preselects the largest file that fits and marks the bigger ones', async () => {
    const choices = ggufChoicesFromTree(TREE)
    expect(defaultChoice(choices, BUDGET_16)?.quant).toBe('Q3_K_M')
    expect(defaultChoice(choices)?.quant).toBe('Q4_K_M')
    expect(overBudgetLabel(15.8 * GB, BUDGET_16)).toBe(" · won't fit fully in GPU memory")
    expect(overBudgetLabel(12.9 * GB, BUDGET_16)).toBe('')

    backend.fetchExternal.mockResolvedValue(JSON.stringify(TREE))
    render(<HfLinkDialog link={{ repo: REPO, file: null }} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(screen.getByTestId('hf-link-quant').textContent).toBe('Q3_K_M')
    const options = [...(screen.getByTestId('hf-link-file-select') as HTMLSelectElement).options].map((o) => o.textContent ?? '')
    expect(options.find((o) => o.includes('Q4_K_M'))).toContain("won't fit fully in GPU memory")
    expect(options.find((o) => o.includes('Q3_K_M'))).not.toContain("won't fit")
  })
})
