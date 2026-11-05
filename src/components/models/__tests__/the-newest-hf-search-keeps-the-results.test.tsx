/**
 * @vitest-environment jsdom
 *
 * Bug hunt C2 (Oktober 2026): Models, Chat, Discover. "mistral" + Enter, then
 * at once "qwen" + Enter. The mistral answer took 2 s, the qwen answer 0.1 s.
 * The box said "qwen", the HuggingFace results were the mistral ones: the
 * late answer of the older search overwrote the newer hits, and its
 * setLoading(false) ended the spinner of the search still running.
 *
 * Run: npx vitest run src/components/models/__tests__/the-newest-hf-search-keeps-the-results.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import type { DiscoverModel } from '../../../api/model-bundles'

const pending = new Map<string, (hits: DiscoverModel[]) => void>()

vi.mock('../../../api/discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/discover')>()),
  searchHuggingFaceModels: vi.fn((q: string) => new Promise<DiscoverModel[]>((resolve) => { pending.set(q, resolve) })),
}))
vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  backendCall: vi.fn(async () => []),
  openExternal: vi.fn(),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/comfyui')>()),
  getSystemVRAM: vi.fn(async () => 16),
  readComfyFolderLists: vi.fn(async () => ({})),
  refreshComfyModels: vi.fn(async () => {}),
}))
vi.mock('../../../lib/hardware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => 16),
  getTotalRamGb: vi.fn(async () => 64),
}))
vi.mock('../../../api/kimi-k3-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/kimi-k3-catalog')>()),
  kimiK31CatalogEntries: vi.fn(async () => []),
}))
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

import { DiscoverModels } from '../DiscoverModels'

const hit = (repo: string): DiscoverModel => ({
  name: repo.split('/')[1].replace(/-GGUF$/, ''),
  description: repo,
  pulls: '1K',
  tags: ['Q4_K_M', 'GGUF'],
  updated: '',
  downloadUrl: `https://huggingface.co/${repo}/resolve/main/x-Q4_K_M.gguf`,
  filename: 'x-Q4_K_M.gguf',
  url: `https://huggingface.co/${repo}`,
})

const text = () => document.body.textContent ?? ''

beforeEach(() => {
  cleanup()
  pending.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the HuggingFace search in Discover (Chat)', () => {
  it('THE REPORT: a late answer to the older search does not replace the newer hits', async () => {
    const view = render(<DiscoverModels category="text" search="mistral" searchSubmitToken={1} />)
    await waitFor(() => expect(pending.has('mistral')).toBe(true))
    view.rerender(<DiscoverModels category="text" search="qwen" searchSubmitToken={2} />)
    await waitFor(() => expect(pending.has('qwen')).toBe(true))

    await act(async () => { pending.get('qwen')!([hit('neworg/Qwen-New-Result-GGUF')]) })
    await waitFor(() => expect(text()).toContain('Qwen-New-Result'))

    await act(async () => { pending.get('mistral')!([hit('oldorg/Mistral-Old-Result-GGUF')]) })
    expect(text()).toContain('Qwen-New-Result')
    expect(text()).not.toContain('Mistral-Old-Result')
  })

  it('the older search ending first does not end the spinner of the newer one', async () => {
    const view = render(<DiscoverModels category="text" search="mistral" searchSubmitToken={1} />)
    await waitFor(() => expect(pending.has('mistral')).toBe(true))
    view.rerender(<DiscoverModels category="text" search="qwen" searchSubmitToken={2} />)
    await waitFor(() => expect(pending.has('qwen')).toBe(true))

    // The old search ends with no hits, so only the spinner can tell.
    await act(async () => { pending.get('mistral')!([]) })
    expect(document.querySelector('[role="status"][aria-busy="true"]')).toBeTruthy()

    await act(async () => { pending.get('qwen')!([hit('neworg/Qwen-New-Result-GGUF')]) })
    await waitFor(() => expect(text()).toContain('Qwen-New-Result'))
  })
})
