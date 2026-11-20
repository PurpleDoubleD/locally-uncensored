/**
 * LU Cloud ends an agent run itself (3.1.3, server A49): HTTP 409 with
 *
 *  - `agent_loop_detected`: the run repeated the same steps several times
 *    ("agent stopped: it repeated the same steps 3 times ...").
 *  - `agent_run_limit`: the run reached the most steps one run may take.
 *
 * Neither is a failure of the app or the model. The run ends calmly: what was
 * written stays, a quiet line under it says why it stopped (the answer's
 * `finishReason`, lib/answer-notes), and nothing is sent again. A retry would
 * meet the same stop, and a `/loop` pass after it as well, so the loop ends.
 */

export const CLOUD_AGENT_LOOP = 'agent_loop_detected'
export const CLOUD_AGENT_RUN_LIMIT = 'agent_run_limit'

export type CloudAgentStop = typeof CLOUD_AGENT_LOOP | typeof CLOUD_AGENT_RUN_LIMIT

export function isCloudAgentStopCode(code: unknown): code is CloudAgentStop {
  return code === CLOUD_AGENT_LOOP || code === CLOUD_AGENT_RUN_LIMIT
}

/** The stop code of what a send threw, or null. */
export function cloudAgentStopOf(err: unknown): CloudAgentStop | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return isCloudAgentStopCode(code) ? code : null
}

/** Written into an answer the stop ended before any text (lib/answer-notes). */
export const AGENT_LOOP_STOP_SENTENCE =
  'The agent stopped because it kept repeating the same steps. Send a message to go on, or describe the task another way.'
export const AGENT_RUN_LIMIT_SENTENCE =
  'The agent stopped at the step limit of one run. Send a message naming what is still left to go on.'

/** `/loop` reason, read as "The loop stopped because the run was …". */
export const LOOP_HALT_CLOUD_AGENT_STOP = 'ended by LU Cloud'
