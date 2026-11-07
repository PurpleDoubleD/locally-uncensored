// @vitest-environment jsdom
/**
 * Swap Character on the desktop (07.11.2026, port of the web's C52): the
 * panel in the web's order (notes, video and resolution, people, length,
 * consent), people up to four, and Create only once the video, a photo for
 * every person and the consent are there. Nothing is rendered or booked:
 * the Composer's generate is a fake, the catalogue a fixture.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/swap-character-panel.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

const QUOTA = {
  tier: 'pro', period: 'month', limits: { credits: 10_000_000 }, costs: { image: 1000, video: 10000 },
  used: { credits_used: 0 }, remaining: { credits: 10_000_000 },
}

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: QUOTA,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openExternal: vi.fn(),
}))

import { Composer } from '../Composer'
import { SwapStage } from '../SwapStage'
import { useCreateStore } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { SWAP_CONSENT_TEXT, SWAP_LONG_MODEL, SWAP_MAIN_MODEL, SWAP_TIPS } from '../../../../lib/render/swap'

const photo = { filename: 'face.png', url: 'data:image/png;base64,AA', width: 512, height: 768 }
const clip = { blob: new Blob(['x'], { type: 'video/mp4' }), name: 'dance.mp4', url: 'blob:dance' }

beforeEach(() => {
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.setState({
    isGenerating: false, batchRun: null, error: null, gallery: [], source: null, videoInput: null, prompt: '',
    backend: 'cloud', cloudStudioOptions: {}, cloudStudioCredits: null,
    // No pick of an earlier test: the tab resolves to its first model.
    cloudOpModel: '',
  } as never)
  useCreateStore.getState().setIntent('swap_character')
  useCreateStore.setState({ swapFigures: [{ image: null, role: '' }], swapSeconds: null, swapConsent: false })
})
afterEach(() => cleanup())

function open() {
  render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
}
const create = () => screen.getByRole('button', { name: /^Create/ }) as HTMLButtonElement
const panel = () => document.querySelector('[data-swap-controls]') as HTMLElement

describe('the Swap Character panel', () => {
  it('stands in the web order: notes, video, people, length, consent; no prompt field', () => {
    open()
    expect(panel()).toBeTruthy()
    expect(document.querySelector('textarea')).toBeNull()
    const order = ['[data-swap-tips]', '[data-swap-figures]', '[data-clip-length]', '[data-swap-consent]']
      .map((sel) => panel().querySelector(sel) as HTMLElement)
    for (const el of order) expect(el).toBeTruthy()
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(panel().textContent).toContain(SWAP_TIPS.join(' '))
    expect(screen.getByText('Add original video')).toBeTruthy()
    expect(screen.getByText(SWAP_CONSENT_TEXT)).toBeTruthy()
    // The resolution comes from the schema of the running model, 768p default.
    const res = screen.getByRole('radiogroup', { name: 'Resolution' })
    expect([...res.querySelectorAll('[role=radio]')].map((b) => b.textContent)).toEqual(['480p', '540p', '768p', '1080p'])
    expect(res.querySelector('[aria-checked=true]')?.textContent).toBe('768p')
    // The length slider spans 2 to 120 s (main model up to 15, Wan beyond).
    const slider = document.getElementById('swap-length') as HTMLInputElement
    expect([slider.min, slider.max]).toEqual(['2', '120'])
  })

  it('adds people up to four, each with a photo field and a role', () => {
    open()
    const add = () => screen.getByRole('button', { name: /Add person/ }) as HTMLButtonElement
    expect(add().textContent).toBe('+ Add person (1/4)')
    fireEvent.click(add())
    fireEvent.click(add())
    fireEvent.click(add())
    expect(useCreateStore.getState().swapFigures).toHaveLength(4)
    expect(add().textContent).toBe('+ Add person (4/4)')
    expect(add().disabled).toBe(true)
    fireEvent.click(add())
    expect(useCreateStore.getState().swapFigures).toHaveLength(4)
    for (let i = 1; i <= 4; i++) {
      expect(screen.getByRole('button', { name: `Add photo of person ${i}` })).toBeTruthy()
      expect(screen.getByRole('textbox', { name: `Who person ${i} replaces` })).toBeTruthy()
    }
    // Remove brings it back down.
    fireEvent.click(screen.getByRole('button', { name: 'Remove person 2' }))
    expect(useCreateStore.getState().swapFigures).toHaveLength(3)
  })

  it('switches a one-person model to the main model when a second person comes, and says so on SCAIL 2', () => {
    useCreateStore.getState().setCloudOpModel('scail-2')
    open()
    expect(screen.getByRole('button', { name: /Add person/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    expect(useCreateStore.getState().cloudOpModel).toBe(SWAP_MAIN_MODEL)
  })

  it('arms Create only with the video, every photo and the consent', () => {
    open()
    expect(create().disabled).toBe(true)
    act(() => { useCreateStore.setState({ videoInput: clip } as never) })
    expect(create().disabled).toBe(true)
    act(() => { useCreateStore.setState({ swapFigures: [{ image: photo, role: '' }, { image: null, role: '' }] }) })
    expect(create().disabled).toBe(true)
    act(() => { useCreateStore.setState({ swapFigures: [{ image: photo, role: '' }, { image: photo, role: 'the man on the right' }] }) })
    // Every photo is there, the box is not ticked yet.
    expect(create().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(useCreateStore.getState().swapConsent).toBe(true)
    expect(create().disabled).toBe(false)
    // Untick: off again.
    fireEvent.click(screen.getByRole('checkbox'))
    expect(create().disabled).toBe(true)
  })

  it('shows no consent box on SCAIL 2, the one model that does not ask', () => {
    useCreateStore.getState().setCloudOpModel('scail-2')
    open()
    expect(document.querySelector('[data-swap-consent]')).toBeNull()
    act(() => { useCreateStore.setState({ videoInput: clip, swapFigures: [{ image: photo, role: '' }] } as never) })
    expect(create().disabled).toBe(false)
  })

  it('moves to Wan 2.2 Animate past 15 s with one person, and says so', () => {
    open()
    act(() => { useCreateStore.getState().setSwapSeconds(40) })
    expect(useCreateStore.getState().cloudOpModel).toBe(SWAP_LONG_MODEL)
    expect(document.querySelector('[data-swap-note="long-model"]')).toBeTruthy()
    // Wan reads 480p and 720p only.
    const res = screen.getByRole('radiogroup', { name: 'Resolution' })
    expect([...res.querySelectorAll('[role=radio]')].map((b) => b.textContent)).toEqual(['480p', '720p'])
    // A second person brings the main model back.
    fireEvent.click(screen.getByRole('button', { name: /Add person/ }))
    expect(useCreateStore.getState().cloudOpModel).toBe(SWAP_MAIN_MODEL)
  })

  it('names the live price beside the length: credits and credits per second', () => {
    open()
    // No video and no choice yet: the main model runs its whole 15 s at
    // 768p, with one photo: 15 x 0.20 $ + 0.02 $ = 3.02 $. Not the 120 s at
    // the end of the slider, which only the long model reads.
    const price = () => (document.querySelector('[data-clip-price]') as HTMLElement).textContent
    const slider = () => document.getElementById('swap-length') as HTMLInputElement
    expect(slider().value).toBe('15')
    expect(price()).toBe('302,000 credits · 20,000/s')
    act(() => { useCreateStore.getState().setSwapSeconds(10) })
    // 10 s: 2.00 $ + 0.02 $.
    expect(price()).toBe('202,000 credits · 20,000/s')
  })
})

describe('the Swap Stage', () => {
  it('shows original + new person -> result, and one tile per person when there are several', () => {
    render(<SwapStage />)
    expect(screen.getByRole('button', { name: 'Add original video' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add photo of the new person' })).toBeTruthy()
    expect(screen.getByText('Result')).toBeTruthy()
    cleanup()
    useCreateStore.setState({ swapFigures: [{ image: photo, role: '' }, { image: null, role: '' }, { image: photo, role: '' }] })
    render(<SwapStage />)
    expect(document.querySelector('[data-swap-figure-grid]')?.children).toHaveLength(3)
    expect(screen.getByText('3 new people')).toBeTruthy()
  })
})
