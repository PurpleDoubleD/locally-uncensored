// @vitest-environment jsdom
/**
 * The Cloud gate for an account whose renewal payment failed (license.pastDue
 * in /api/me).
 *
 * The account panel has said "Payment failed" since d43134b5. The gate in front
 * of the Cloud switch still told the same account "this account has no active
 * plan yet" and showed the three plan buttons, although the server answers a
 * new plan with 409 until the open invoice is paid. Both places now carry the
 * same sentence and the same button.
 *
 * Run: npx vitest run src/components/cloud/__tests__/the-gate-names-a-failed-payment.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

const refresh = vi.fn(async () => {})
vi.mock('../../../hooks/useCloudAuth', () => ({
  useCloudAuth: () => ({ status: 'signed-in', login: vi.fn(), signup: vi.fn(), logout: vi.fn(), refresh }),
}))
vi.mock('../../../api/cloud/supabase', () => ({ loginWithProvider: vi.fn() }))
const openExternal = vi.fn(async () => {})
vi.mock('../../../api/backend', () => ({ openExternal, backendCall: vi.fn(async () => undefined), isMacOS: () => false }))
vi.mock('../../../api/cloud/public-catalog', () => ({ getPublicCatalog: vi.fn(async () => null) }))

const { CloudGateModal } = await import('../CloudGateModal')
const { useCloudAuthStore } = await import('../../../stores/cloudAuthStore')
const { useUIStore } = await import('../../../stores/uiStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { PAST_DUE_ACTION, pastDueLine } = await import('../../../lib/past-due')

const emptyWallet: CloudQuota = {
  tier: 'starter',
  period: '2026-10',
  limits: { credits: 0 },
  costs: { image: 10, video: 100 },
  used: { credits_used: 0 },
  remaining: { credits: 0 },
}

type Account = Parameters<ReturnType<typeof useCloudAuthStore.getState>['setSignedIn']>[1]

async function openGate(account: Partial<Account>) {
  useSettingsStore.getState().updateSettings({ appMode: 'local' })
  useCloudAuthStore.getState().setSignedIn(
    { id: 'u1', email: 'a@b.c' },
    { licenseActive: false, tier: null, access: true, quota: null, paidPlan: false, ...account },
  )
  useUIStore.getState().setCloudGateOpen(true)
  await act(async () => {
    render(<CloudGateModal />)
  })
}

const planButtons = () => screen.queryAllByRole('button', { name: /€\d+/ })

afterEach(() => {
  cleanup()
  openExternal.mockClear()
  refresh.mockClear()
  useUIStore.getState().setCloudGateOpen(false)
  useCloudAuthStore.getState().setSignedOut()
})

describe('a failed renewal without credits', () => {
  it('reads the account panel sentence and leads to the invoice, with no plan on offer', async () => {
    await openGate({ pastDue: true, pastDueTier: 'hosted-pro' })

    const notice = screen.getByTestId('cloud-gate-past-due')
    expect(notice.textContent).toContain(pastDueLine('hosted-pro'))
    expect(notice.textContent).toContain('your Hosted Pro plan')
    expect(screen.queryByText(/no active plan/i)).toBeNull()
    expect(screen.queryByText(/paid plans/i)).toBeNull()
    expect(planButtons()).toHaveLength(0)
    expect(screen.queryByText(/I subscribed/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: PAST_DUE_ACTION }))
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://lu-labs.ai/account?utm_source=desktop&utm_medium=gate')
    // Nothing on this state opens the pricing page.
    expect(openExternal.mock.calls.flat().some((u) => String(u).includes('/pricing'))).toBe(false)
  })

  it('keeps the way back to Local and the re-check, and stays in local mode', async () => {
    await openGate({ pastDue: true, pastDueTier: null })

    expect(screen.getByTestId('cloud-gate-past-due').textContent).toContain(pastDueLine(null))
    refresh.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /I paid, check again/ }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().settings.appMode).toBe('local')

    fireEvent.click(screen.getByRole('button', { name: /Stay on Local/ }))
    expect(useUIStore.getState().cloudGateOpen).toBe(false)
    expect(useSettingsStore.getState().settings.appMode).toBe('local')
  })
})

describe('a failed renewal whose pack credits are used up', () => {
  it('does not call the plan active', async () => {
    await openGate({ licenseActive: true, tier: 'starter', quota: emptyWallet, pastDue: true, pastDueTier: 'hosted' })

    expect(screen.getByTestId('cloud-gate-past-due').textContent).toContain(pastDueLine('hosted'))
    expect(screen.queryByText(/Your plan is active/)).toBeNull()
    expect(screen.getByRole('button', { name: PAST_DUE_ACTION })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stay on Local/ })).toBeTruthy()
  })
})

describe('no failed payment', () => {
  it('an account without a plan sees subscription, pack and the two bigger plans', async () => {
    await openGate({})

    expect(screen.getByText(/no active plan yet/)).toBeTruthy()
    // Since 3.1.0 Hosted is the subscription card next to the pack, and the
    // grid keeps Pro and Max.
    expect(screen.getByTestId('buy-sub')).toBeTruthy()
    expect(screen.getByTestId('buy-pack')).toBeTruthy()
    expect(planButtons()).toHaveLength(2)
    expect(screen.getByRole('button', { name: /I bought, check again/ })).toBeTruthy()
    expect(screen.queryByTestId('cloud-gate-past-due')).toBeNull()
  })

  it('a plan without a credit budget reads as before', async () => {
    await openGate({ licenseActive: true, tier: 'hosted', quota: { ...emptyWallet, tier: 'hosted' }, paidPlan: true })

    expect(screen.getByText(/Your plan is active/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open your account/ })).toBeTruthy()
    expect(screen.queryByTestId('cloud-gate-past-due')).toBeNull()
  })
})
