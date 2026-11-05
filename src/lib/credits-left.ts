// The credits an account has left: the monthly allowance still open plus the
// bought ones (top-up). One sum for the tray line and for Settings → LU Cloud
// Account, so the click on "Plan & Credits…" lands on the same number it
// came from (FEHLER-T2 #1, 3.0.9).

import { formatCount } from './formatters'
import type { CloudQuota } from './render/cloud-jobs'

export interface CreditsLeft {
  total: number
  topup: number
}

const whole = (n: unknown): number => Math.max(0, Math.floor(Number(n) || 0))

export function creditsLeft(quota: Pick<CloudQuota, 'remaining' | 'topup'>): CreditsLeft {
  const topup = whole(quota.topup?.credits)
  return { total: whole(quota.remaining?.credits) + topup, topup }
}

/** "1,240 credits left (incl. 300 top-up)"; `short` drops the brackets (tray). */
export function creditsLeftLine(c: CreditsLeft, opts: { short?: boolean } = {}): string {
  const line = `${formatCount(c.total)} credits left`
  return !opts.short && c.topup > 0 ? `${line} (incl. ${formatCount(c.topup)} top-up)` : line
}
