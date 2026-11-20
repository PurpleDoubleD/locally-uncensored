// One source of truth for what the UI says when an assistant turn did NOT end
// on the model's own terms. Both the single-model path and the group path go
// through here so the wording never drifts (2026-08-08: a length-cut in a
// group turn used to show a generic "didn't return a visible answer", with no
// hint that the token budget ran out; and a cut answer carried no marker at all,
// while the benchmark screen has always flagged cut-offs).

import { isMobile } from './device-kind'
import { MODEL_SWITCH_FINISH } from './model-switch-stop'
import { AGENT_LOOP_STOP_SENTENCE, AGENT_RUN_LIMIT_SENTENCE, CLOUD_AGENT_LOOP, CLOUD_AGENT_RUN_LIMIT } from './agent-core/cloud-agent-stop'

/** Short badge label for a turn the model did not finish on its own terms.
 *  null for a clean stop, so the caller renders nothing. */
/** Written into an answer that ended on a broken stream before any text. The phone replaces it for a model on the device, where no network is involved. */
export const DISCONNECT_WITHOUT_ANSWER = 'The connection dropped before the model finished its answer. Check your network and try again.'

export function truncationNotice(finishReason?: string): string | null {
  if (finishReason === 'length') return 'Cut off at the length limit'
  if (finishReason === 'disconnect') return 'Connection dropped before the end'
  if (finishReason === MODEL_SWITCH_FINISH) return 'Stopped because you switched to another model'
  // LU Cloud ended the agent run (agent-core/cloud-agent-stop.ts).
  if (finishReason === CLOUD_AGENT_LOOP) return 'Agent stopped because it kept repeating the same steps'
  if (finishReason === CLOUD_AGENT_RUN_LIMIT) return 'Agent stopped at the step limit of one run'
  return null
}

/** Explanation to place in an assistant bubble that produced no visible answer.
 *  `captured` = some reasoning was kept; `keepThinking` = Thinking is on. */
// The phone names the setting as its own screens do: "Max length", in the options of the chat
// (acceptance on the small iPhone, N16: the hint named a setting the app does not have).
export function emptyAnswerExplanation(opts: {
  finishReason?: string
  captured: boolean
  keepThinking: boolean
}): string {
  const { finishReason, captured, keepThinking } = opts
  if (finishReason === 'length') {
    return captured
      ? 'The model spent its entire token budget thinking and never wrote the answer. Try again, reasoning is not deterministic, or turn Thinking off for this question.'
      : `The model hit its token limit before writing an answer. Try again, or ${isMobile() ? 'raise Max length in the options of this chat' : 'raise Max Tokens in Settings'}.`
  }
  if (finishReason === MODEL_SWITCH_FINISH) {
    return 'Stopped because you switched to another model before this answer was written. Send the message again to get it from the model that is picked now.'
  }
  if (finishReason === CLOUD_AGENT_LOOP) return AGENT_LOOP_STOP_SENTENCE
  if (finishReason === CLOUD_AGENT_RUN_LIMIT) return AGENT_RUN_LIMIT_SENTENCE
  if (finishReason === 'disconnect') {
    return DISCONNECT_WITHOUT_ANSWER
  }
  return captured && keepThinking
    ? 'The model finished thinking but never wrote an answer. Try again, or turn Thinking off for this question.'
    : "I didn't return a visible answer that time, please try again."
}
