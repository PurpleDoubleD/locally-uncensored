/**
 * @vitest-environment jsdom
 *
 * W42 (Discord, 17.11.2026): Image and Video searched both catalogue tabs,
 * Text only the open one, and a Mainstream hit under the Unfiltered tab was
 * taken for an unfiltered model. Every catalogue now searches both tabs, and
 * the hits stand in two groups under the names Unfiltered and Mainstream,
 * the open tab's first. Measured on the rendered page.
 *
 * Run: npx vitest run src/components/models/__tests__/w42-search-shows-which-catalogue.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { catalogueSections } from '../../../lib/discover-bundle-search'
import { getVideoBundles } from '../../../api/model-bundles'

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
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

import { DiscoverModels } from '../DiscoverModels'
import { getUncensoredTextModels, getMainstreamTextModels } from '../../../api/discover'

const pageText = () => document.body.textContent ?? ''
/** Where a heading of that exact text stands in the page, -1 if absent. */
function headAt(title: string): number {
  const all = Array.from(document.querySelectorAll('h2,h3,h4,[role="heading"],div,span,p'))
  const el = all.find((e) => e.children.length === 0 && e.textContent?.trim() === title)
  if (!el) return -1
  return Array.from(document.querySelectorAll('*')).indexOf(el)
}

beforeEach(() => {
  cleanup()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the rule', () => {
  const byTab = { uncensored: ['u1'], mainstream: ['m1', 'm2'] }
  it('without a search: the open tab alone, no name over it', () => {
    expect(catalogueSections('mainstream', '', byTab)).toEqual([{ tab: null, items: ['m1', 'm2'] }])
    expect(catalogueSections('uncensored', '  ', byTab)).toEqual([{ tab: null, items: ['u1'] }])
  })
  it('with a search: both tabs, the open one first, an empty one left out', () => {
    expect(catalogueSections('uncensored', 'x', byTab).map((s) => s.tab)).toEqual(['uncensored', 'mainstream'])
    expect(catalogueSections('mainstream', 'x', byTab).map((s) => s.tab)).toEqual(['mainstream', 'uncensored'])
    expect(catalogueSections('mainstream', 'x', { uncensored: ['u'], mainstream: [] })).toEqual([{ tab: 'uncensored', items: ['u'] }])
  })
})

describe('on the page', () => {
  // A word both text catalogues carry, so the test needs no fixture.
  const word = (() => {
    const names = (l: { name: string }[]) => l.map((m) => m.name.toLowerCase())
    const u = names(getUncensoredTextModels())
    const m = names(getMainstreamTextModels())
    return ['qwen', 'gemma', 'llama', 'mistral', 'glm'].find((w) => u.some((n) => n.includes(w)) && m.some((n) => n.includes(w))) ?? 'qwen'
  })()

  it('Text: a search shows the hits of both catalogues, each under its name', async () => {
    render(<DiscoverModels category="text" search={word} />)
    await waitFor(() => expect(headAt('Unfiltered')).toBeGreaterThan(-1))
    expect(headAt('Mainstream')).toBeGreaterThan(-1)
  })

  it('Video: the FramePack hit (Unfiltered) stands under Unfiltered, not among Mainstream', async () => {
    expect(getVideoBundles().find((b) => b.name.startsWith('FramePack'))?.uncensored).toBe(true)
    render(<DiscoverModels category="video" search="framepack" />)
    await waitFor(() => expect(document.querySelector('[data-bundle-tile^="FramePack"]')).toBeTruthy())
    const tile = Array.from(document.querySelectorAll('*')).indexOf(document.querySelector('[data-bundle-tile^="FramePack"]')!)
    const head = headAt('Unfiltered')
    expect(head).toBeGreaterThan(-1)
    expect(head).toBeLessThan(tile)
  })

  it('without a search no catalogue name stands over the grid', async () => {
    render(<DiscoverModels category="video" />)
    await waitFor(() => expect(document.querySelector('[data-bundle-tile]')).toBeTruthy())
    expect(headAt('Unfiltered')).toBe(-1)
    expect(headAt('Mainstream')).toBe(-1)
    expect(pageText()).toBeTruthy()
  })
})
