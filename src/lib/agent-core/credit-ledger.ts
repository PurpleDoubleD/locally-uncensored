/**
 * Credits agent runs used in the last hour, across runs and chats (CA,
 * 14.11.2026).
 *
 * The per-run brake cannot see a customer who starts run after run: in the
 * support logs of that week one account sent 627 requests in 102 minutes,
 * a few hundred per run. This ledger keeps an upper-bound estimate of the
 * credits every paid agent step used, for one rolling hour, and survives a
 * restart (localStorage, wrapped: a failing store only means a fresh hour).
 */
const KEY = 'lu-agent-credit-hour'
const HOUR_MS = 60 * 60 * 1000

interface Entry { at: number; credits: number }
interface State { entries: Entry[]; pausedAt: number | null }

function load(): State {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return { entries: [], pausedAt: null }
    const s = JSON.parse(raw) as Partial<State>
    return {
      entries: Array.isArray(s.entries) ? s.entries.filter((e) => typeof e?.at === 'number' && typeof e?.credits === 'number' && Number.isFinite(e.credits)) : [],
      pausedAt: typeof s.pausedAt === 'number' ? s.pausedAt : null,
    }
  } catch {
    return { entries: [], pausedAt: null }
  }
}

function save(s: State): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(s)) } catch { /* a fresh hour is the safe failure */ }
}

function prune(s: State, now: number): State {
  return { entries: s.entries.filter((e) => now - e.at < HOUR_MS), pausedAt: s.pausedAt !== null && now - s.pausedAt < HOUR_MS ? s.pausedAt : null }
}

/** Add one step's credits; returns the sum over the last hour. */
export function addHourCredits(credits: number, now: number = Date.now()): number {
  const s = prune(load(), now)
  if (credits > 0) {
    // Priced at the learned factor (full price until the server has been
    // asked once), and the full-price estimate goes to the reconciler.
    s.entries.push({ at: now, credits: credits * recon.factor })
    noteEstimate(credits, now)
  }
  save(s)
  return Math.max(0, s.entries.reduce((a, e) => a + e.credits, 0))
}

// ── Reconciling with the server (CA, 14.11.2026) ─────────────────────────
//
// The step price above is an upper bound: LU Cloud bills cached input for
// less and strips the cache fields from its answer (cache-oracle.ts, a side
// channel guard), so the app cannot see the discount. Measured on Kimi K2.6:
// the ledger counted 1.6–2.7× what the server billed, so the brake paused at
// about half its limit. The server's own counter is the truth; every
// RECONCILE_EVERY estimated credits the ledger asks it, and corrects the
// hour and the factor for the next steps by the real spend.
//
// Safe by construction: without an answer (offline, signed out, a failing
// request, a month change or a top-up in between) nothing changes and every
// step stays at full price. The factor never drops below FACTOR_FLOOR, and a
// real spend ABOVE the estimate (a chat or a render in between) raises it,
// which brakes earlier, never later.

export const RECONCILE_EVERY = 10_000
export const FACTOR_FLOOR = 0.4
const FACTOR_CEIL = 2

/** What the server says this account has spent, in credits; null when unknown. */
export type SpentReader = () => Promise<number | null>

interface Recon {
  factor: number
  reader: SpentReader | null
  baseline: number | null
  estimatedSince: number
  pricedSince: number
  /** When the first step since the baseline was counted. */
  sinceAt: number | null
  inFlight: boolean
}
const recon: Recon = { factor: 1, reader: null, baseline: null, estimatedSince: 0, pricedSince: 0, sinceAt: null, inFlight: false }

/** The account spend counter, e.g. from LU Cloud's quota answer. */
export function setSpentReader(reader: SpentReader | null): void {
  recon.reader = reader
  recon.baseline = null
  recon.estimatedSince = 0
  recon.pricedSince = 0
  recon.sinceAt = null
}

/** Real price per estimated credit, as last measured; 1 until measured. */
export function creditFactor(): number {
  return recon.factor
}

function noteEstimate(credits: number, now: number): void {
  if (!recon.reader) return
  if (recon.sinceAt === null) recon.sinceAt = now
  recon.estimatedSince += credits
  recon.pricedSince += credits * recon.factor
  if (recon.baseline === null || recon.estimatedSince >= RECONCILE_EVERY) void reconcileNow()
}

/** Ask the server now; resolves when the answer is applied (or dropped). */
export async function reconcileNow(now: number = Date.now()): Promise<void> {
  if (!recon.reader || recon.inFlight) return
  recon.inFlight = true
  try {
    const spent = await recon.reader().catch(() => null)
    if (typeof spent !== 'number' || !Number.isFinite(spent)) return
    if (recon.baseline === null) {
      // First answer: the starting point. Steps before it stay at full price.
      recon.baseline = spent
      recon.estimatedSince = 0
      recon.pricedSince = 0
      recon.sinceAt = null
      return
    }
    const real = spent - recon.baseline
    const estimated = recon.estimatedSince
    const priced = recon.pricedSince
    const since = recon.sinceAt ?? now
    recon.baseline = spent
    recon.estimatedSince = 0
    recon.pricedSince = 0
    recon.sinceAt = null
    // A month change or a top-up moves the counter backwards: no measurement.
    if (real < 0 || estimated <= 0) return
    recon.factor = Math.min(FACTOR_CEIL, Math.max(FACTOR_FLOOR, real / estimated))
    // The hour gets the difference between what it counted and what was
    // billed, bounded so the correction never takes it below the real spend.
    // Stamped with the EARLIEST step it corrects: it leaves the hour no later
    // than those steps do, so a lowering never outlives what it lowered.
    const correction = Math.max(real, estimated * FACTOR_FLOOR) - priced
    if (Math.abs(correction) >= 1) {
      const s = prune(load(), now)
      s.entries.push({ at: since, credits: correction })
      save(s)
    }
  } finally {
    recon.inFlight = false
  }
}

/** Sum over the last hour, without adding. */
export function hourCredits(now: number = Date.now()): number {
  return Math.max(0, prune(load(), now).entries.reduce((a, e) => a + e.credits, 0))
}

/**
 * The hourly pause fires once per hour: after it, the user's next message is
 * the go-ahead, and the next pause comes an hour later at the earliest.
 */
export function hourPauseDue(now: number = Date.now()): boolean {
  return prune(load(), now).pausedAt === null
}

export function markHourPause(now: number = Date.now()): void {
  const s = prune(load(), now)
  s.pausedAt = now
  save(s)
}

/** Tests only. */
export function _resetCreditLedger(): void {
  try { globalThis.localStorage?.removeItem(KEY) } catch { /* nothing to reset */ }
  setSpentReader(null)
  recon.factor = 1
  recon.inFlight = false
}
