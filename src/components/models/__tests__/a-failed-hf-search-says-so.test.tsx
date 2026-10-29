/**
 * @vitest-environment jsdom
 *
 * Bug hunt C3 (Oktober 2026): Models, Discover (Chat), HuggingFace search with
 * no connection or over the rate limit. The page said "No models found", as if
 * the model did not exist, and the user went on trying other words instead of
 * checking the connection. A failed search now says so; a search that really
 * finds nothing still says "No models found".
 *
 * Run: npx vitest run src/components/models/__tests__/a-failed-hf-search-says-so.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import type { DiscoverModel } from '../../../api/model-bundles'

const search = vi.fn<(q: string) => Promise<DiscoverModel[]>>()

vi.mock('../../../api/discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/discover')>()),
  searchHuggingFaceModels: (q: string) => search(q),
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
import { HfSearchError } from '../../../api/discover'

const text = () => document.body.textContent ?? ''
// Matches nothing in the curated lists, so only the HF search decides.
const QUERY = 'zzqxnomodel'

beforeEach(() => {
  cleanup()
  search.mockReset()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a failed HuggingFace search in Discover (Chat)', () => {
  it('THE REPORT: offline says Hugging Face could not be reached, not "No models found"', async () => {
    search.mockRejectedValue(new HfSearchError('offline', 'dns error'))
    render(<DiscoverModels category="text" search={QUERY} searchSubmitToken={1} />)
    await waitFor(() => expect(text()).toContain('Hugging Face could not be reached. Check the connection and search again.'))
    expect(document.querySelector('[data-testid="hf-search-failed"]')?.getAttribute('role')).toBe('alert')
    expect(text()).not.toContain('No models found')
  })

  it('rate limited says the limit', async () => {
    search.mockRejectedValue(new HfSearchError('rate-limit', 'Rate limit reached'))
    render(<DiscoverModels category="text" search={QUERY} searchSubmitToken={1} />)
    await waitFor(() => expect(text()).toContain('Hugging Face is limiting searches right now.'))
    expect(text()).not.toContain('No models found')
  })

  it('a search that finds nothing still says "No models found"', async () => {
    search.mockResolvedValue([])
    render(<DiscoverModels category="text" search={QUERY} searchSubmitToken={1} />)
    await waitFor(() => expect(search).toHaveBeenCalled())
    await waitFor(() => expect(text()).toContain('No models found'))
    expect(document.querySelector('[data-testid="hf-search-failed"]')).toBeNull()
  })
})
