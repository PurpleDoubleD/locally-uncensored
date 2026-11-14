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
      entries: Array.isArray(s.entries) ? s.entries.filter((e) => typeof e?.at === 'number' && typeof e?.credits === 'number') : [],
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
  if (credits > 0) s.entries.push({ at: now, credits })
  save(s)
  return s.entries.reduce((a, e) => a + e.credits, 0)
}

/** Sum over the last hour, without adding. */
export function hourCredits(now: number = Date.now()): number {
  return prune(load(), now).entries.reduce((a, e) => a + e.credits, 0)
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
}
