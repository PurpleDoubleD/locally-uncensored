/**
 * What the LU Cloud account has spent, read from the server's own counter
 * (CA, 14.11.2026). The credit ledger calibrates its full-price estimate
 * against it (credit-ledger.ts, "Reconciling with the server").
 *
 * Spent = monthly credits used minus the top-up wallet: a step paid from the
 * wallet lowers the wallet instead of raising `credits_used`. Buying credits
 * or a new month moves this backwards, which the ledger reads as "no
 * measurement" and keeps full price.
 */
import { getQuota } from '../../api/cloud/jobs'
import { setSpentReader, type SpentReader } from './credit-ledger'

const ASK_TIMEOUT_MS = 8_000

export const luCloudSpent: SpentReader = async () => {
  try {
    const q = await Promise.race([
      getQuota(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ASK_TIMEOUT_MS)),
    ])
    const used = q?.used?.credits_used
    if (typeof used !== 'number' || !Number.isFinite(used)) return null
    const wallet = typeof q?.topup?.credits === 'number' && Number.isFinite(q.topup.credits) ? q.topup.credits : 0
    return used - wallet
  } catch {
    return null
  }
}

let wired = false

/** Wires the reader once per app run; a second call keeps the baseline. */
export function ensureCloudSpentReader(): void {
  if (wired) return
  wired = true
  setSpentReader(luCloudSpent)
}
