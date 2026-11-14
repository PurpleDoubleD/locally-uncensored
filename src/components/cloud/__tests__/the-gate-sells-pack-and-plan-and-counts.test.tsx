// @vitest-environment jsdom
/**
 * Funnel 3.1.0 on the gate and the Create sheet:
 *   Nr. 3  every button into LU Cloud is counted, by name only,
 *   Nr. 4  the pack stands next to the subscription, same size, same weight,
 *   Nr. 11 "Already bought? Sign in" at the top, and a checkout that came
 *          back through the app's link opens the gate on the sign in.
 *
 * Run: npx vitest run src/components/cloud/__tests__/the-gate-sells-pack-and-plan-and-counts.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const openExternal = vi.fn(async () => {})
const backendCall = vi.fn(async () => undefined)
vi.mock('../../../api/backend', () => ({ openExternal, backendCall, isMacOS: () => false, isTauri: () => true }))
vi.mock('../../../hooks/useGraphicsMemory', () => ({ useGraphicsMemoryGb: () => 12 }))
vi.mock('../../../lib/hardware', () => ({ getMaxVramGb: () => Promise.resolve(8), getSharedMemoryGb: () => Promise.resolve(0) }))
const getPublicCatalog = vi.fn()
vi.mock('../../../api/cloud/public-catalog', () => ({ getPublicCatalog }))

const { CloudGateModal } = await import('../CloudGateModal')
const { CloudTeaserModal } = await import('../CloudTeaserModal')
const { useCloudAuthStore } = await import('../../../stores/cloudAuthStore')
const { useUIStore } = await import('../../../stores/uiStore')
const { useCloudGateStore } = await import('../../../stores/cloudGateStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { parseGateCatalog } = await import('../../../lib/cloud-gate')

const live = parseGateCatalog({
  version: 1,
  categories: {
    chat: [{ id: 'moonshotai/Kimi-K3', label: 'Kimi K3' }],
    code: [{ id: 'moonshotai/Kimi-K3', label: 'Kimi K3' }],
    create: [{ id: 'flux-dev', label: 'Flux Dev', kind: 'image' }],
  },
  offers: {
    plans: [{ tier: 'hosted', interval: 'month', eur: 19, images: 3000, clips: 112 }],
    packs: [{ id: 'pack-15', eur: 15, images: 1500, clips: 56 }],
  },
})!

const events = () => backendCall.mock.calls
  .filter((c) => (c as unknown[])[0] === 'funnel_ping')
  .map((c) => ((c as unknown[])[1] as { event: string }).event)
const opened = () => openExternal.mock.calls.map((c) => new URL(String((c as unknown[])[0])))

async function openGate(from?: 'switch' | 'model-picker') {
  useCloudAuthStore.getState().setSignedOut()
  useUIStore.getState().setCloudGateOpen(true, from)
  await act(async () => { render(<CloudGateModal />) })
}

beforeEach(() => {
  getPublicCatalog.mockResolvedValue(live)
  useCloudGateStore.setState({ catalog: null, pick: null })
  useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: true })
})
afterEach(() => {
  cleanup()
  openExternal.mockClear()
  backendCall.mockClear()
  useUIStore.getState().setCloudGateOpen(false)
  useUIStore.getState().setCloudGateReturn(null)
  useUIStore.getState().setCloudTeaser(null)
})

describe('the gate, signed out', () => {
  it('puts "Already bought? Sign in" first and counts it', async () => {
    await openGate()
    const panel = screen.getByTestId('cloud-sales-panel')
    const signIn = screen.getByTestId('cloud-gate-signin-top')
    expect(panel.firstElementChild).toBe(signIn)
    expect(signIn.textContent).toContain('Already bought? Sign in')
    fireEvent.click(signIn)
    expect(events()).toEqual(['cloud_gate_signin'])
    expect(screen.getByText('Sign in with the account you bought with.')).toBeTruthy()
  })

  it('shows subscription and pack side by side, the pack price from the catalogue', async () => {
    await openGate()
    expect(screen.getByTestId('buy-price-sub').textContent).toBe('€19 / month')
    expect(screen.getByTestId('buy-price-pack').textContent).toBe('€15 once')
    expect(screen.getByText('No subscription')).toBeTruthy()
    const grid = screen.getByTestId('buy-choice')
    expect(grid.className).toContain('grid-cols-2')
    // Same button style on both: neither is the lesser way.
    expect(screen.getByTestId('buy-sub').className).toBe(screen.getByTestId('buy-pack').className)
  })

  it('names no pack price without an answer from the server', async () => {
    getPublicCatalog.mockResolvedValue(null)
    await openGate()
    expect(screen.getByTestId('buy-price-pack').textContent).toBe('One payment')
  })

  it('counts each buy button once and opens the checkout start with its place', async () => {
    await openGate('model-picker')
    fireEvent.click(screen.getByTestId('buy-sub'))
    fireEvent.click(screen.getByTestId('buy-pack'))
    expect(events()).toEqual(['cloud_gate_main_sub', 'cloud_gate_main_pack'])
    const [sub, pack] = opened()
    expect(sub.pathname).toBe('/checkout/start')
    expect(sub.searchParams.get('plan')).toBe('hosted')
    expect(pack.searchParams.get('pack')).toBe('pack-15')
    for (const u of [sub, pack]) {
      expect(u.searchParams.get('src')).toBe('app-gate-main')
      expect(u.searchParams.get('utm_source')).toBe('desktop')
      expect(u.searchParams.get('utm_medium')).toBe('gate')
      expect(u.searchParams.get('utm_content')).toBe('model-picker')
      expect(u.searchParams.get('scheme')).toBe('locallyuncensored')
    }
    expect(openExternal.mock.calls.flat().some((u) => /stripe/i.test(String(u)))).toBe(false)
  })

  it('counts "See all plans" as a plan click and tags the pricing page', async () => {
    await openGate()
    fireEvent.click(screen.getByText('See all plans'))
    expect(events()).toEqual(['cloud_gate_plan_click'])
    const [u] = opened()
    expect(u.pathname).toBe('/pricing')
    expect(u.searchParams.get('utm_medium')).toBe('gate')
  })

  it('does not count the opening itself: the switch already does', async () => {
    await openGate()
    expect(events()).toEqual([])
  })
})

describe('back from the checkout', () => {
  it('opens on the sign in with a thank you, not on the offer', async () => {
    useUIStore.getState().setCloudGateReturn('paid')
    await openGate()
    expect(screen.queryByTestId('cloud-sales-panel')).toBeNull()
    expect(screen.getByText(/Thanks for your purchase\. Sign in with the same account you used in the browser/)).toBeTruthy()
  })

  it('a link that arrives while the gate is open switches to the sign in', async () => {
    await openGate()
    expect(screen.getByTestId('cloud-sales-panel')).toBeTruthy()
    await act(async () => { useUIStore.getState().setCloudGateReturn('paid') })
    expect(screen.queryByTestId('cloud-sales-panel')).toBeNull()
  })

  it('a cancelled checkout shows the offer again', async () => {
    useUIStore.getState().setCloudGateReturn('cancelled')
    await openGate()
    expect(screen.getByTestId('cloud-sales-panel')).toBeTruthy()
  })
})

describe('the Create sheet', () => {
  async function openSheet() {
    useUIStore.getState().setCloudTeaser({ surface: 'intent', intent: 'upscale' })
    await act(async () => { render(<CloudTeaserModal />) })
  }

  it('sells the pack next to the subscription, both counted, both tagged', async () => {
    await openSheet()
    expect(screen.getByTestId('buy-price-pack').textContent).toBe('€15 once')
    fireEvent.click(screen.getByTestId('buy-pack'))
    expect(events()).toEqual(['cloud_teaser_pack'])
    const [u] = opened()
    expect(u.pathname).toBe('/checkout/start')
    expect(u.searchParams.get('pack')).toBe('pack-15')
    expect(u.searchParams.get('src')).toBe('gpu8')
    expect(u.searchParams.get('utm_medium')).toBe('create-sheet')
  })

  it('counts the subscription button', async () => {
    await openSheet()
    fireEvent.click(screen.getByTestId('buy-sub'))
    expect(events()).toEqual(['cloud_teaser_sub'])
    expect(opened()[0].searchParams.get('plan')).toBe('hosted')
  })

  it('counts hiding the Cloud features, and Not now stays uncounted', async () => {
    await openSheet()
    fireEvent.click(screen.getByText('Not now'))
    expect(events()).toEqual([])
    cleanup()
    await openSheet()
    fireEvent.click(screen.getByText("Don't show Cloud features in Local mode"))
    expect(events()).toEqual(['cloud_teaser_hide'])
  })
})
