/**
 * @vitest-environment jsdom
 *
 * Bug hunt C2, CivitAI part (Oktober 2026): Models, LoRAs. "anime" + Enter,
 * then at once "pixel" + Enter. The anime answer came late. The field said
 * "pixel", the hits were the anime ones: the late answer of the older search
 * overwrote the newer hits, and its end also ended the spinner of the newer
 * search still running.
 *
 * Run: npx vitest run src/components/models/__tests__/the-newest-civitai-search-keeps-the-results.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'

const io = vi.hoisted(() => ({
  pending: new Map<string, (hits: unknown[]) => void>(),
}))

vi.mock('../../../api/discover', async (orig) => {
  const real = await orig<typeof import('../../../api/discover')>()
  return {
    searchCivitaiModels: (q: string) => new Promise((resolve) => { io.pending.set(q, resolve) }),
    checkCivitaiInstalled: async () => new Set<number>(),
    civitaiInstalledInFolder: real.civitaiInstalledInFolder,
    startCivitaiDownload: vi.fn(),
    startModelDownloadToPath: vi.fn(),
  }
})
vi.mock('../../../api/backend', () => ({ openExternal: vi.fn(), isTauri: () => true, isMacOS: () => false, backendCall: vi.fn() }))
vi.mock('../../../stores/downloadStore', () => {
  const state = { downloads: {}, setMeta: vi.fn(), startPolling: vi.fn() }
  const useDownloadStore = Object.assign((pick: (s: typeof state) => unknown) => pick(state), { getState: () => state })
  return { useDownloadStore }
})

import { CivitaiSearchPanel } from '../CivitaiSearchPanel'

const hit = (id: number, name: string) => ({
  id, name, description: '', type: 'LORA', sourceUrl: `https://civitai.com/models/${id}`,
  downloadUrl: `https://civitai.com/api/download/models/${id}`, filename: `${id}.safetensors`, subfolder: 'loras', sizeBytes: 1,
})

const props = (search: string, searchSubmitToken: number) => ({
  modelType: 'LORA' as const, title: 'Search CivitAI for LoRAs', placeholder: 'x', search, searchSubmitToken,
})
const text = () => document.body.textContent ?? ''
const searchButton = () => screen.getByRole('button', { name: 'Search CivitAI' }) as HTMLButtonElement

beforeEach(() => { io.pending.clear() })
afterEach(cleanup)

describe('the CivitAI search', () => {
  it('THE REPORT: a late answer to the older search does not replace the newer hits', async () => {
    const view = render(createElement(CivitaiSearchPanel, props('anime', 1)))
    await waitFor(() => expect(io.pending.has('anime')).toBe(true))
    view.rerender(createElement(CivitaiSearchPanel, props('pixel', 2)))
    await waitFor(() => expect(io.pending.has('pixel')).toBe(true))

    await act(async () => { io.pending.get('pixel')!([hit(2, 'NEW Pixel Style')]) })
    await waitFor(() => expect(text()).toContain('NEW Pixel Style'))

    await act(async () => { io.pending.get('anime')!([hit(1, 'OLD Anime Style')]) })
    expect(text()).toContain('NEW Pixel Style')
    expect(text()).not.toContain('OLD Anime Style')
  })

  it('the older search ending first does not end the spinner of the newer one', async () => {
    const view = render(createElement(CivitaiSearchPanel, props('anime', 1)))
    await waitFor(() => expect(io.pending.has('anime')).toBe(true))
    view.rerender(createElement(CivitaiSearchPanel, props('pixel', 2)))
    await waitFor(() => expect(io.pending.has('pixel')).toBe(true))

    await act(async () => { io.pending.get('anime')!([hit(1, 'OLD Anime Style')]) })
    expect(searchButton().disabled).toBe(true)
    expect(text()).not.toContain('OLD Anime Style')

    await act(async () => { io.pending.get('pixel')!([hit(2, 'NEW Pixel Style')]) })
    await waitFor(() => expect(searchButton().disabled).toBe(false))
    expect(text()).toContain('NEW Pixel Style')
  })
})
