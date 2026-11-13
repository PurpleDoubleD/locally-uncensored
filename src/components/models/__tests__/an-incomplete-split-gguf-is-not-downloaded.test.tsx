/**
 * @vitest-environment jsdom
 *
 * Bug hunt C11 (Oktober 2026): a repository where the uploader is still
 * uploading lists `Big-Model-Q4_K_M-00001-of-00003.gguf` and `-00002-of-00003`
 * only. The Hugging Face link dialog offered "Q4_K_M · 74.5 GB · 2 parts" and
 * the download started both parts. llama.cpp loads a split set only with
 * every part, so the model was "installed" and never started. The same
 * resolver serves the Discover cards and the HF search.
 *
 * Run: npx vitest run src/components/models/__tests__/an-incomplete-split-gguf-is-not-downloaded.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const GB = 1_000_000_000
const backend = vi.hoisted(() => ({
  fetchExternal: vi.fn(async (_url: string) => ''),
  backendCall: vi.fn(async (_cmd: string): Promise<unknown> => null),
}))
vi.mock('../../../api/backend', () => ({
  ...backend,
  isTauri: () => false,
  isMacOS: () => false,
  isWindows: () => false,
  openExternal: vi.fn(),
}))

import { HfLinkDialog } from '../HfLinkDialog'
import { selectGgufFromTree, type HfTreeEntry } from '../../../api/discover'
import { ggufChoicesFromTree, defaultChoice } from '../../../lib/hf-link'
import { shardSetGap } from '../../../lib/gguf-shards'

const part = (path: string, oid: string): HfTreeEntry => ({ type: 'file', path, size: 40 * GB, lfs: { oid: oid.repeat(64), size: 40 * GB } })
const P1 = part('Q4_K_M/Big-Model-Q4_K_M-00001-of-00003.gguf', 'a')
const P2 = part('Q4_K_M/Big-Model-Q4_K_M-00002-of-00003.gguf', 'b')
const P3 = part('Q4_K_M/Big-Model-Q4_K_M-00003-of-00003.gguf', 'c')
const INCOMPLETE = [P1, P2]
const REPO = 'uploader/Big-Model-GGUF'

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

describe('a split GGUF set with parts missing', () => {
  it('counts as loadable only with exactly the parts 1..N', () => {
    expect(shardSetGap([P1.path, P2.path, P3.path])).toBeNull()
    expect(shardSetGap(['x-Q4_K_M.gguf'])).toBeNull()
    expect(shardSetGap([P1.path, P2.path])).toEqual({ have: 2, of: 3 })
    expect(shardSetGap([P2.path, P3.path])).toEqual({ have: 2, of: 3 })
    // A stale part of an older two-part upload under the same name.
    expect(shardSetGap([P1.path, P2.path, P3.path, 'Q4_K_M/Big-Model-Q4_K_M-00001-of-00002.gguf'])).not.toBeNull()
  })

  it('the resolver hands out no file of it, for the named file and for its quant', () => {
    const named = selectGgufFromTree(INCOMPLETE, REPO, undefined, P1.path)
    expect(named?.files).toEqual([])
    expect(named?.incomplete).toEqual({ have: 2, of: 3 })
    const byQuant = selectGgufFromTree(INCOMPLETE, REPO, 'Q4_K_M')
    expect(byQuant?.files).toEqual([])
    expect(byQuant?.incomplete).toEqual({ have: 2, of: 3 })
  })

  it('a complete quant next to it is taken where the choice is the resolver\'s own', () => {
    const tree = [...INCOMPLETE, part('Big-Model-Q3_K_M.gguf', 'd')]
    const picked = selectGgufFromTree(tree, REPO)
    expect(picked?.incomplete).toBeUndefined()
    expect(picked?.files.map((f) => f.filename)).toEqual(['Big-Model-Q3_K_M.gguf'])
  })

  it('the complete set still downloads all three parts', () => {
    const picked = selectGgufFromTree([P1, P2, P3], REPO, undefined, P1.path)
    expect(picked?.incomplete).toBeUndefined()
    expect(picked?.files).toHaveLength(3)
  })

  it('the link dialog lists it as incomplete and never preselects it over a complete file', () => {
    const choices = ggufChoicesFromTree([...INCOMPLETE, part('Big-Model-Q3_K_M.gguf', 'd')])
    expect(choices.find((c) => c.path === P1.path)?.incomplete).toEqual({ have: 2, of: 3 })
    expect(defaultChoice(choices)?.path).toBe('Big-Model-Q3_K_M.gguf')
  })

  it('THE REPORT: the link dialog says so and Download stays off', async () => {
    backend.fetchExternal.mockResolvedValue(JSON.stringify(INCOMPLETE))
    const onConfirm = vi.fn()
    render(<HfLinkDialog link={{ repo: REPO, file: null }} onCancel={vi.fn()} onConfirm={onConfirm} />)
    await settle()
    expect(screen.getByTestId('hf-link-incomplete').textContent).toContain('Only 2 of 3 parts')
    const select = screen.getByTestId('hf-link-file-select') as HTMLSelectElement
    expect(select.options[0].textContent).toContain('incomplete: 2 of 3 parts, try again later')
    const button = screen.getByRole('button', { name: /^Download/ }) as HTMLButtonElement
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
