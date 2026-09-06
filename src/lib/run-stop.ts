/**
 * "The user pressed Stop" — as state that outlives the hook instance which
 * started the run.
 *
 * The Code view and the chat view unmount on every tab switch, and the /loop
 * driver's `finally` runs inside the closure of the hook instance that STARTED
 * the pass. A stop pressed by the REMOUNTED instance only ever set that
 * instance's own `useRef`, which the old closure cannot read — so the finally
 * saw "not stopped", scheduled the next pass, and the loop the user had just
 * killed came back by itself. The loop is uncapped on purpose ("there is NO
 * built-in ceiling … the stop button is the brake"), so that made an
 * unattended agent with full shell and write access unstoppable from the only
 * control the product offers.
 *
 * Scope is the module, keyed by conversation id: that is the run identity the
 * Stop button can actually name (it aborts by conversation through
 * generationStore), and one conversation runs at most one agent pass at a
 * time. Whichever instance is alive can therefore stop a run any other
 * instance started.
 *
 * The flag is deliberately STICKY until the next non-loop instruction on that
 * conversation: a stopped run's tail work (the loop driver, an auto-apply of
 * staged changes, a plan approval card) must all see the stop, and those run
 * after the abort has already propagated.
 */

const stopped = new Set<string>()

/**
 * A fresh, user-initiated run on this conversation. Clears a previous stop —
 * a /loop pass must NOT call this, it inherits the stop of the run it
 * continues (that is what makes Stop end the loop rather than one pass).
 */
export function beginRun(conversationId: string | null | undefined): void {
  if (!conversationId) return
  stopped.delete(conversationId)
}

/** The user pressed Stop for this conversation. */
export function stopRun(conversationId: string | null | undefined): void {
  if (!conversationId) return
  stopped.add(conversationId)
}

/** Has the user stopped the run on this conversation? */
export function isRunStopped(conversationId: string | null | undefined): boolean {
  if (!conversationId) return false
  return stopped.has(conversationId)
}

/** Test-only: module state persists for a whole session by design. */
export function __resetRunStopsForTests(): void {
  stopped.clear()
}
