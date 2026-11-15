/**
 * What an agent run does when it ends for a reason a next pass would hit again.
 *
 * LU Cloud ends a step in which the model repeats itself (server A41: SSE error
 * code `stalled_loop`, logged as chat.loop_stopped). It bills the input of
 * that step and the output before the repetition, and sends no usage, so the
 * cost brake never saw that step. One more attempt can heal a one-off; a model
 * that loops twice in one task is stuck on this context.
 *
 * Case 15.11.2026 (LU-Admin Wecker, metadata only): a desktop agent ran 70
 * minutes on direct/deepseek-v4.1-flash, 535 requests, 524 of them tool
 * calls, 8 finished answers, ~125k input per request, ~729k credits. The
 * server cut two steps for repeating, and the work went on after both.
 */

export const SERVER_LOOP_CODE = 'stalled_loop'

/** A step LU Cloud cut because the model repeated itself. */
export function isServerLoopCut(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === SERVER_LOOP_CODE
}

/** Attempts a run may make after such a cut, over the whole run. */
export const SERVER_LOOP_RETRIES = 1

export const SERVER_LOOP_MESSAGE =
  'Stopped: the model got stuck repeating itself and LU Cloud cut it off. Send a message to go on, or try another model.'

/**
 * `/loop` reasons, read as "The loop stopped because the run was …". A pass
 * that ended on one of these would start the next pass with a fresh brake and
 * hit the same wall again, on the user's credits.
 */
export const LOOP_HALT_COST = 'paused to protect your credits'
export const LOOP_HALT_GUARD = 'stuck repeating the same steps'
export const LOOP_HALT_SERVER_LOOP = 'cut off by LU Cloud because the model kept repeating itself'
