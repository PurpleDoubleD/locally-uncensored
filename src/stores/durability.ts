/**
 * When a write counts as landed, and what "this turn is finished" is allowed
 * to mean.
 *
 * ── The finding (2026-09-01) ────────────────────────────────────────────────
 * Three hooks ended a turn with the same four lines and the same mistake:
 *
 *     setIsGenerating(false)                       // the app says: done
 *     useGenerationStore…setGenerating(id, false)  // the app says: done
 *     …
 *     void flushChatPersist()                      // the write STARTS here
 *
 * The `void` is not the bug. Not blocking the render path is a legitimate
 * goal, and the answer is on screen long before any of this runs. The bug is
 * the ORDER: the app published "finished" while the write of that very turn
 * had not begun. Measured in a real Chromium against real IndexedDB, on the
 * profile coalescedStorage.ts itself describes (30 chats, 3 screenshots,
 * 6.48 MB persisted) with the CPU throttled 20x to stand in for a loaded
 * machine, the gap between the app reporting the turn finished and the turn
 * reaching the store was 323 ms, 327 ms and 522 ms across three runs. On an
 * idle Mac the same gap is under 2 ms — which is why this never showed up in
 * casual use and why the comment in coalescedStorage.ts got away with
 * promising that a finished answer is "already on disk".
 *
 * A reload inside that window loses the turn: six of six runs under the same
 * throttle came back from `page.reload()` with the user's line present and the
 * assistant's answer gone. Unthrottled but on a busy machine it is four runs
 * in twelve — the "one in three or four" the finding was reported as.
 *
 * ── What this module changes ────────────────────────────────────────────────
 * The turn's write goes FIRST and the announcement goes last. Nothing about
 * the render path changes: by the time a turn ends, the answer has already
 * been painted, so what waits here is the spinner, not the text. In exchange,
 * "the turn is finished" becomes a signal that can be trusted — by the user
 * closing the app, by an e2e spec, and by anything that reloads. Under the same
 * 20x throttle the gap changed sign: -225 ms, -318 ms, -256 ms, i.e. the store
 * holds the turn a quarter of a second BEFORE the app admits the turn is over.
 *
 * What this does NOT buy, stated plainly so nobody has to rediscover it: the
 * answer is on SCREEN before it is on disk, and it always will be. A reload
 * fired in the window between the paint and the completion signal still loses
 * the tail — four runs in twelve, measured identically with and without this
 * module, because the write starts at the same instant either way. The unload
 * path (pagehide/visibilitychange in chatStore) is best effort and cannot be
 * anything else: an IndexedDB write is asynchronous and the window does not
 * wait for it. The completion signal is the one moment the app is entitled to
 * claim durability, so that is the moment it claims it.
 *
 * ── One trap, paid for once ─────────────────────────────────────────────────
 * WHERE the call sites invoke this is load-bearing, not just THAT they await
 * it. `flushes.map(f => f())` runs synchronously, which is where the whole
 * serialise-and-put happens, so the call belongs at the earliest point where
 * the turn's writes are all in the store — the statement the old
 * `void flushChatPersist()` occupied. Moving it to the bottom of the hooks'
 * `finally` blocks (past the TTS and memory blocks) pushed the START of the
 * write about 5 ms past the paint and took the reload race from never to three
 * runs in ten. Awaiting late is free; starting late is not.
 *
 * That paragraph used to be the whole enforcement, which is this project's
 * standing failure: a rule that lives only in prose while the code is free to
 * break it. It is a gate now. stores/__tests__/a-turn-is-finished-when-it-is-
 * stored.test.ts reads all four `finally` blocks and fails if the call sits
 * below anything that takes time, or if anything is awaited above it.
 */
import { log } from '../lib/logger'
import { flushChatPersist } from './chatStore'

/**
 * Resolve when `work` resolves, or after `ms`, whichever comes first, and
 * never reject. The caller wants to know it may proceed, not what happened.
 *
 * Exported for the test: a flush that never settles is not something a store
 * can be talked into from the outside.
 */
export function settledOrTimedOut(work: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    work.then(
      () => { clearTimeout(timer); resolve('settled') },
      () => { clearTimeout(timer); resolve('settled') },
    )
  })
}

/**
 * How long a finished turn may wait for its own write before the app reports
 * it finished anyway.
 *
 * Same shape of reasoning as the update path's deadline, different number: an
 * update is a one-off the user has already agreed to and can afford ten
 * seconds, whereas this runs at the end of EVERY turn and the thing waiting on
 * it is the Stop button turning back into Send. Two seconds is far beyond a
 * healthy multi-megabyte write (the worst measured under a 20x CPU throttle
 * was 545 ms) and short enough that a wedged IndexedDB cannot pin the composer.
 */
export const TURN_FLUSH_TIMEOUT_MS = 2_000

/** A coalesced store's `flush()`, bound to its store. */
export type TurnFlush = () => Promise<void>

/**
 * End a turn: put what the turn produced on disk, THEN tell the app the turn
 * is over.
 *
 * `publishDone` is the announcement and nothing else — the `isGenerating` /
 * `isRunning` / thread-status writes that flip the composer back and stop the
 * typing dots. Everything the turn still has to WRITE (the assistant message,
 * the hidden tool history, attached artifacts, a plan awaiting approval) must
 * already be in the store before this is called, or it will not be in the
 * flush it is supposed to be in.
 *
 * `publishDone` runs exactly once, on every path, including a flush that
 * rejects and a flush that never settles. A store that cannot write is a
 * reason to log and carry on, never a reason to leave the user with a Stop
 * button that does nothing.
 *
 * Returns which of the two happened, so a caller can say so; the three hooks
 * currently ignore it and let the log carry it.
 */
export async function endTurnDurably(
  publishDone: () => void,
  flushes: readonly TurnFlush[] = [flushChatPersist],
  timeoutMs: number = TURN_FLUSH_TIMEOUT_MS,
): Promise<'flushed' | 'timeout'> {
  let verdict: 'flushed' | 'timeout' = 'flushed'
  try {
    // allSettled, not all: one store failing to write must not stop the app
    // from waiting for the others, and none of them may reject out of here.
    const outcome = await settledOrTimedOut(
      Promise.allSettled(flushes.map((flush) => flush())),
      timeoutMs,
    )
    if (outcome === 'timeout') {
      verdict = 'timeout'
      log.warn('[turn] the finished turn did not reach the store before the deadline — reporting it finished anyway', {
        timeoutMs,
      })
    }
  } catch (err) {
    // A flush that throws SYNCHRONOUSLY never became a promise, so allSettled
    // never saw it. Same answer: say so, then let the turn end.
    verdict = 'timeout'
    log.warn('[turn] a store flush threw on the way out of a finished turn', { err: String(err) })
  } finally {
    publishDone()
  }
  return verdict
}
