/**
 * Coalescing PersistStorage for zustand's `persist` (2.6.3).
 *
 * WHY: zustand writes on EVERY set() with no debounce — `api.setState` is
 * wrapped as `savedSetState(...); return setItem()` (zustand/esm/middleware.mjs).
 * `createJSONStorage` then runs `JSON.stringify` over the WHOLE persisted state
 * inside that call. The chat store flushes once per animation frame while a
 * reply streams (useChat.ts), so a 30 s answer serialised the entire chat
 * history ~1800 times.
 *
 * With images in the history that history is multi-megabyte (ImageAttachment
 * carries base64 inline), and an IndexedDB put of that size takes far longer
 * than the 16 ms until the next frame. Every flush therefore minted another
 * multi-MB string AND another pending transaction, none of which could be
 * collected while the write was outstanding. Measured on a normal profile
 * (30 chats, 3 screenshots): 8.1 GB of string churn and 5.1 GB held live in
 * ~1100 queued writes across one answer. That is the renderer's Out of Memory.
 *
 * FIX: keep only the LATEST state reference and serialise it once per window,
 * not once per set(). Because the store updates immutably, holding the
 * reference is free and serialising late yields the newest snapshot — exactly
 * the value the last write would have produced. At most one write is ever in
 * flight; anything that arrives during it collapses into a single follow-up.
 *
 * Durability: a trailing write lands `waitMs` after the last change, and
 * `maxWaitMs` caps how long a continuously-changing store can go unwritten, so
 * a long stream still checkpoints. `flush()` forces the pending write out; the
 * call site fires it when a turn finishes and on pagehide/visibilitychange.
 *
 * The flush is best effort on the way out, and cannot be anything else: an
 * IndexedDB write is asynchronous and the window does not wait for it during
 * unload. That is why `waitMs` is short and why the call site flushes when a
 * turn ENDS rather than relying on the unload path.
 *
 * What that flush is worth, precisely — the old wording here said a finished
 * answer is "already on disk by the time anyone can close the app", and that
 * was not measured. It is now (stores/durability.ts carries the numbers, taken
 * in a real Chromium against real IndexedDB):
 *
 *   - `flush()` resolves when the put has LANDED, so awaiting it is a real
 *     guarantee, and the three chat hooks now await it before they report a
 *     turn finished. Once the app says the turn is over, the turn is readable
 *     out of the store. On an idle Mac that costs under 2 ms; with the CPU
 *     throttled 20x on a 6.5 MB profile it cost 323-545 ms, and that is the
 *     Stop button waiting, not the text — the answer is painted long before.
 *   - It is NOT true that the answer is on disk as soon as it is on screen.
 *     The paint comes first and always will. A reload fired inside that window
 *     still loses the tail of the turn: six of six throttled runs, and four
 *     runs in twelve unthrottled on a busy machine — the same four in twelve
 *     with and without the awaited turn end, because the write starts at the
 *     same instant either way.
 *   - A stream killed mid-sentence still loses its last `waitMs` of tokens,
 *     which the pre-existing per-set() write could lose too (it was equally
 *     asynchronous, just with a narrower window).
 */
import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware'
import { log } from './logger'

export interface CoalescedOptions {
  /** Quiet period after the last change before writing. */
  waitMs?: number
  /** Hard cap on how long a continuously-changing store stays unwritten. */
  maxWaitMs?: number
}

export interface CoalescedStorage<S> extends PersistStorage<S> {
  /** Write any pending state immediately. Resolves once it has landed. */
  flush: () => Promise<void>
}

export function coalescedJSONStorage<S>(
  base: StateStorage,
  { waitMs = 250, maxWaitMs = 2000 }: CoalescedOptions = {}
): CoalescedStorage<S> {
  let pending: { name: string; value: StorageValue<S> } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstQueuedAt = 0
  let inFlight: Promise<void> | null = null

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * Drains `pending` until it is empty, one write at a time. Anything that
   * arrives mid-write is picked up by the next turn of the loop, so N changes
   * during a slow put cost ONE extra write rather than N queued multi-MB
   * strings. Re-entrant calls join the run in progress instead of starting a
   * second, interleaved chain.
   */
  function drain(): Promise<void> {
    if (inFlight) return inFlight
    clearTimer()
    inFlight = (async () => {
      while (pending) {
        const next = pending
        pending = null
        firstQueuedAt = 0
        try {
          // The single stringify this whole module exists to make rare.
          await base.setItem(next.name, JSON.stringify(next.value))
        } catch (err) {
          log.error('[coalescedStorage] persist write failed', { key: next.name, err: String(err) })
        }
      }
    })().finally(() => { inFlight = null })
    return inFlight
  }

  function schedule(): void {
    const now = Date.now()
    if (firstQueuedAt === 0) firstQueuedAt = now
    // Never let the trailing timer push the write past maxWaitMs: a stream that
    // changes the store every frame would otherwise reset the timer forever and
    // never checkpoint.
    const delay = Math.max(0, Math.min(waitMs, firstQueuedAt + maxWaitMs - now))
    clearTimer()
    timer = setTimeout(() => { void drain() }, delay)
  }

  return {
    getItem: (name) => {
      const raw = base.getItem(name)
      const parse = (v: string | null): StorageValue<S> | null => {
        if (v == null) return null
        try {
          return JSON.parse(v) as StorageValue<S>
        } catch {
          // Unparseable payload must not take the store down with it — start
          // clean rather than throwing out of hydration.
          log.error('[coalescedStorage] persisted state is not valid JSON, ignoring', { key: name })
          return null
        }
      }
      // idbStorage answers synchronously when IndexedDB is absent (node tests,
      // degraded webview). Staying synchronous there keeps hydration synchronous,
      // which is what those tests rely on.
      return raw instanceof Promise ? raw.then(parse) : parse(raw)
    },

    setItem: (name, value) => {
      pending = { name, value }
      schedule()
    },

    removeItem: (name) => {
      // A queued write must not resurrect what was just removed.
      pending = null
      firstQueuedAt = 0
      clearTimer()
      return base.removeItem(name)
    },

    flush: () => {
      if (!pending && !inFlight) return Promise.resolve()
      return drain()
    },
  }
}
