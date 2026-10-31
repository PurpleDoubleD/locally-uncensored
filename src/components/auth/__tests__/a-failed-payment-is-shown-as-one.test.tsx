// @vitest-environment jsdom
/**
 * A renewal payment that failed (license.pastDue in /api/me, web ee31e7f9).
 *
 * Until 3.0.5 the panel said "No active plan" and "Pick a plan" to a customer
 * whose card had merely bounced, and offered the plans again. The server
 * refuses that purchase until the open invoice is paid, so the one honest
 * thing to show is the failed payment and the way to the invoice.
 *
 * Run: npx vitest run src/components/auth/__tests__/a-failed-payment-is-shown-as-one.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

vi.mock('../../../hooks/useCloudAuth', () => ({
  useCloudAuth: () => ({ status: 'signed-in', login: vi.fn(), signup: vi.fn(), logout: vi.fn() }),
}))
vi.mock('../../../api/cloud/supabase', () => ({ loginWithProvider: vi.fn() }))
const openExternal = vi.fn(async () => {})
vi.mock('../../../api/backend', () => ({ openExternal }))

const { AccountPanel } = await import('../AccountPanel')
const { useCloudAuthStore } = await import('../../../stores/cloudAuthStore')

const SENTENCE = 'The last payment for your Hosted Pro plan failed, so the plan is paused. Pay the open invoice to bring it back.'
const WALLET = 'Credits you bought stay usable in the meantime.'

const walletQuota: CloudQuota = {
  tier: 'starter',
  period: '2026-10',
  limits: { credits: 5000 },
  costs: { image: 10, video: 100 },
  used: { credits_used: 1200 },
  remaining: { credits: 3800 },
}

const signIn = (account: Partial<Parameters<ReturnType<typeof useCloudAuthStore.getState>['setSignedIn']>[1]>) =>
  useCloudAuthStore.getState().setSignedIn(
    { id: 'u1', email: 'a@b.c' },
    { licenseActive: false, tier: null, access: true, quota: null, paidPlan: false, ...account },
  )

afterEach(() => {
  cleanup()
  openExternal.mockClear()
  useCloudAuthStore.getState().setSignedOut()
})

describe('a failed renewal without credits', () => {
  it('says so instead of "No active plan" and leads to the invoice', () => {
    signIn({ pastDue: true, pastDueTier: 'hosted-pro' })
    render(<AccountPanel />)

    expect(screen.getByText('Payment failed')).toBeTruthy()
    expect(screen.queryByText('No active plan')).toBeNull()
    expect(screen.getByTestId('past-due-notice').textContent).toContain(SENTENCE)
    expect(screen.getByTestId('past-due-notice').textContent).not.toContain(WALLET)
    // Nothing here sells a new plan: the server refuses one until the invoice is paid.
    expect(screen.queryByText(/Pick a plan/)).toBeNull()
    expect(screen.queryByText(/View plans/)).toBeNull()

    fireEvent.click(screen.getByText('Pay open invoice'))
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://lu-labs.ai/account')
  })

  it('says "your plan" when the server does not name one', () => {
    signIn({ pastDue: true, pastDueTier: null })
    render(<AccountPanel />)
    expect(screen.getByTestId('past-due-notice').textContent).toContain('The last payment for your plan failed')
  })
})

describe('a failed renewal with pack credits left', () => {
  it('keeps the plan line and the meter, and adds the notice with the wallet sentence', () => {
    signIn({ licenseActive: true, tier: 'starter', quota: walletQuota, pastDue: true, pastDueTier: 'hosted-pro' })
    render(<AccountPanel />)

    expect(screen.getByText('Plan: starter')).toBeTruthy()
    expect(screen.queryByText('Payment failed')).toBeNull()
    expect(screen.getByTestId('past-due-notice').textContent).toContain(`${SENTENCE} ${WALLET}`)
    expect(screen.getByText('Cloud credits (this billing period)')).toBeTruthy()
    expect(screen.getByText(/Manage subscription/)).toBeTruthy()
  })
})

describe('no failed payment', () => {
  it('an account without a plan reads as before', () => {
    signIn({})
    render(<AccountPanel />)
    expect(screen.getByText('No active plan')).toBeTruthy()
    expect(screen.getByText(/Pick a plan/)).toBeTruthy()
    expect(screen.getByText(/View plans/)).toBeTruthy()
    expect(screen.queryByTestId('past-due-notice')).toBeNull()
  })

  it('a paying account shows no notice', () => {
    signIn({ licenseActive: true, tier: 'hosted', quota: { ...walletQuota, tier: 'hosted' }, paidPlan: true })
    render(<AccountPanel />)
    expect(screen.getByText('Plan: hosted')).toBeTruthy()
    expect(screen.queryByTestId('past-due-notice')).toBeNull()
  })
})

describe('credits left (FEHLER-T2 #1)', () => {
  it('shows the same "credits left" as the tray under the meter, top-up named', () => {
    signIn({
      licenseActive: true,
      tier: 'hosted-pro',
      quota: { ...walletQuota, limits: { credits: 2000 }, used: { credits_used: 1060 }, remaining: { credits: 940 }, topup: { credits: 300 } },
      paidPlan: true,
    })
    render(<AccountPanel />)
    expect(screen.getByText('1,060 / 2,000')).toBeTruthy()
    expect(screen.getByTestId('credits-left').textContent).toBe('1,240 credits left (incl. 300 top-up)')
  })

  it('without a top-up it is the monthly rest alone', () => {
    signIn({ licenseActive: true, tier: 'hosted', quota: { ...walletQuota, tier: 'hosted' }, paidPlan: true })
    render(<AccountPanel />)
    expect(screen.getByTestId('credits-left').textContent).toBe('3,800 credits left')
  })
})
