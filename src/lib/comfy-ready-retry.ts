/**
 * The second pass the inventory always assumed it would get.
 *
 * Meldung 2 of the R5 re-measure on the 2.6.7 Windows build (2026-08-30). On a
 * cold start, with the Model Manager opened while ComfyUI was still coming up,
 * the counter ended on `Installed 0` and stayed there. Two independent
 * reproductions, and minutes later, with port 8188 long open, it still read 0
 * while the cards beside it carried green Installed ticks. Only a click on
 * Refresh repaired it.
 *
 * inventory-counter.ts already says "a second pass is what brings the ComfyUI
 * lanes in: the engine is often not up yet on the first one". There was no
 * second pass. The first pass asked an engine that could not answer, wrote its
 * empty answer down as the count, and the count settled.
 *
 * So the app asks again, once, when the engine is there. Not a standing poll:
 * this is armed only after a pass whose ComfyUI lanes could not answer, it
 * runs at most one at a time, it hangs on the readiness signal ComfyUI already
 * has in this app (`comfyui_status`, which reports `running` and `starting`
 * separately for exactly this reason), and it stops the moment the engine is
 * up, the engine is no longer starting, or the budget runs out. It is the same
 * shape and the same budget useCreate's startAndAwait uses to wait out a
 * ComfyUI boot, because it is the same wait.
 */

/** The fields of `comfyui_status` this wait cares about. */
export interface ComfyReadyStatus {
  /** The port answers. */
  running?: boolean
  /** The process is alive but has not bound the port yet. */
  starting?: boolean
}

/** How the wait ended. Every one of them is a settled answer for the counter. */
export type ReadyRetryOutcome =
  /** The engine came up and the refetch ran. */
  | 'refetched'
  /** The engine is not coming: nothing is starting, so the count of 0 is true. */
  | 'not-starting'
  /** The engine was still starting when the budget ran out. */
  | 'timeout'

/** Same 60 rounds of 2 seconds useCreate spends waiting out a ComfyUI boot. */
export const READY_ROUNDS = 60
export const READY_DELAY_MS = 2000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Does the pass that just ran owe a second one.
 *
 * `answered` is the honest question: did the ComfyUI lanes produce an answer,
 * not whether that answer had anything in it. An engine that is up and holds
 * no models is a counted zero and owes nothing. An engine that could not be
 * reached, or whose lanes all threw, has counted nothing at all.
 */
export function inventoryOwesRetry(answered: boolean): boolean {
  return !answered
}

/**
 * Ask again once the engine is there.
 *
 * `status` returning null (the command is unavailable, the web build, a
 * backend that does not know it) ends the wait rather than spinning on an
 * unanswerable question.
 */
export async function refetchWhenComfyReady(deps: {
  status: () => Promise<ComfyReadyStatus | null>
  refetch: () => Promise<void>
  wait?: (ms: number) => Promise<void>
  rounds?: number
  delayMs?: number
}): Promise<ReadyRetryOutcome> {
  const { status, refetch } = deps
  const wait = deps.wait ?? sleep
  const rounds = deps.rounds ?? READY_ROUNDS
  const delayMs = deps.delayMs ?? READY_DELAY_MS

  for (let i = 0; i < rounds; i++) {
    const s = await status().catch(() => null)
    if (s?.running) {
      await refetch()
      return 'refetched'
    }
    // Not up and not on its way. The zero the counter is holding is the truth,
    // and the Installed tab's own "Start ComfyUI" state says the rest.
    if (!s || s.starting !== true) return 'not-starting'
    await wait(delayMs)
  }
  return 'timeout'
}
