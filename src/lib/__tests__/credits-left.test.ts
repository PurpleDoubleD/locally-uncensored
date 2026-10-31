/**
 * One sum of the credits left, for the tray line and for Settings → LU Cloud
 * Account (FEHLER-T2 #1, 3.0.9): the tray said "1,240 credits left" while the
 * panel the click lands on showed only "1,060 / 2,000" used.
 *
 * Run: npx vitest run src/lib/__tests__/credits-left.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { CloudQuota } from '../render/cloud-jobs'
import { creditsLeft, creditsLeftLine } from '../credits-left'

const quota = (over: Partial<CloudQuota> = {}): CloudQuota => ({
  tier: 'hosted-pro',
  period: '2026-10',
  limits: { credits: 2000 },
  costs: { image: 10, video: 100 },
  used: { credits_used: 1060 },
  remaining: { credits: 940 },
  topup: { credits: 300 },
  ...over,
})

describe('credits left', () => {
  it('is the monthly rest plus the bought credits', () => {
    expect(creditsLeft(quota())).toEqual({ total: 1240, topup: 300 })
    expect(creditsLeftLine(creditsLeft(quota()))).toBe('1,240 credits left (incl. 300 top-up)')
  })

  it('names no top-up when there is none', () => {
    const c = creditsLeft(quota({ topup: undefined }))
    expect(c).toEqual({ total: 940, topup: 0 })
    expect(creditsLeftLine(c)).toBe('940 credits left')
  })

  it('never goes below zero or shows fractions', () => {
    expect(creditsLeft(quota({ remaining: { credits: -20 }, topup: { credits: 12.7 } }))).toEqual({ total: 12, topup: 12 })
  })

  it('the tray line is the same number without the brackets', () => {
    expect(creditsLeftLine(creditsLeft(quota()), { short: true })).toBe('1,240 credits left')
  })
})
