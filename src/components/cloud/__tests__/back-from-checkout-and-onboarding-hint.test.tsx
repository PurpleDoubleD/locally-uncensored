// @vitest-environment jsdom
/**
 * Funnel 3.1.0:
 *   Nr. 11 the way back from a checkout, locallyuncensored://cloud/open, is
 *          taken out of the same inbox as the Hugging Face link and opens the
 *          gate. It proves nothing about a purchase: the gate checks the
 *          account as on every opening.
 *   Nr. 14 a small card hears about LU Cloud in the onboarding, quietly,
 *          with a tagged and counted link.
 *
 * Run: npx vitest run src/components/cloud/__tests__/back-from-checkout-and-onboarding-hint.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const openExternal = vi.fn(async () => {})
const backendCall = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined)
const mac = { on: false }
vi.mock('../../../api/backend', () => ({
  openExternal,
  backendCall: (cmd: string, args?: unknown) => backendCall(cmd, args),
  isMacOS: () => mac.on,
  isTauri: () => false,
}))
const vram = { gb: 8 }
vi.mock('../../../lib/hardware', () => ({ getMaxVramGb: () => Promise.resolve(vram.gb) }))

const { takeHfLink } = await import('../../models/HfLinkInbox')
const { readInbound } = await import('../../../lib/hf-link')
const { useUIStore } = await import('../../../stores/uiStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { OnboardingCloudHint, smallCard } = await import('../OnboardingCloudHint')

const events = () => backendCall.mock.calls
  .filter((c) => c[0] === 'funnel_ping')
  .map((c) => (c[1] as { event: string }).event)

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockResolvedValue(undefined)
  openExternal.mockClear()
  mac.on = false
  vram.gb = 8
  useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: true })
})
afterEach(() => {
  cleanup()
  useUIStore.getState().setCloudGateOpen(false)
  useUIStore.getState().setCloudGateReturn(null)
})

describe('the way back from a checkout', () => {
  it('reads only paid or cancelled', () => {
    expect(readInbound({ kind: 'cloudReturn', status: 'paid' })).toEqual({ kind: 'cloudReturn', status: 'paid' })
    expect(readInbound({ kind: 'cloudReturn', status: 'cancelled' })).toEqual({ kind: 'cloudReturn', status: 'cancelled' })
    expect(readInbound({ kind: 'cloudReturn', status: 'refunded' })).toBeNull()
    expect(readInbound({ kind: 'cloudReturn' })).toBeNull()
  })

  it('opens the gate from the inbox, marked as a return', async () => {
    backendCall.mockImplementation(async (cmd: string) => (cmd === 'hf_link_take' ? { kind: 'cloudReturn', status: 'paid' } : undefined))
    await takeHfLink()
    const ui = useUIStore.getState()
    expect(ui.cloudGateOpen).toBe(true)
    expect(ui.cloudGateReturn).toBe('paid')
    expect(ui.cloudGateFrom).toBe('checkout-return')
    // The app never switches to Cloud on the link alone.
    expect(useSettingsStore.getState().settings.appMode).not.toBe('cloud')
  })
})

describe('the onboarding hint for a small card', () => {
  it('shows at 8 GB and below, never for an unknown or a bigger card', () => {
    expect(smallCard(8)).toBe(true)
    expect(smallCard(6)).toBe(true)
    expect(smallCard(8.5)).toBe(false)
    expect(smallCard(12)).toBe(false)
    expect(smallCard(0)).toBe(false)
  })

  it('says the size, links to the pricing page with its place and counts the click', async () => {
    await act(async () => { render(<OnboardingCloudHint />) })
    const hint = screen.getByTestId('onboarding-cloud-hint')
    expect(hint.textContent).toContain('Your GPU has 8 GB.')
    fireEvent.click(screen.getByText('Run it in LU Cloud instead'))
    expect(events()).toEqual(['cloud_onboarding_hint'])
    const u = new URL(String((openExternal.mock.calls[0] as unknown[])[0]))
    expect(u.pathname).toBe('/pricing')
    expect(u.searchParams.get('utm_source')).toBe('desktop')
    expect(u.searchParams.get('utm_medium')).toBe('onboarding')
  })

  it('stays away on a big card, on a Mac and with the Cloud features off', async () => {
    vram.gb = 16
    await act(async () => { render(<OnboardingCloudHint />) })
    expect(screen.queryByTestId('onboarding-cloud-hint')).toBeNull()
    cleanup()
    vram.gb = 6
    mac.on = true
    await act(async () => { render(<OnboardingCloudHint />) })
    expect(screen.queryByTestId('onboarding-cloud-hint')).toBeNull()
    cleanup()
    mac.on = false
    useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: false })
    await act(async () => { render(<OnboardingCloudHint />) })
    expect(screen.queryByTestId('onboarding-cloud-hint')).toBeNull()
  })
})
