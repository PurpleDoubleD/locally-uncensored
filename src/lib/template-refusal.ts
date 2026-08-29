/**
 * When the model's own chat template refuses the conversation (bug B3, 2.6.7).
 *
 * llama.cpp, the bundled engine, LM Studio and Ollama all render the GGUF's
 * Jinja chat template before the model sees anything. A strict template calls
 * raise_exception when the message sequence breaks its rules, the engine turns
 * that into HTTP 400, and the turn dies without a single token. The text that
 * comes back is written by the template author, not by us:
 *
 *   "System message must be at the beginning"                  (Mistral style)
 *   "Conversation roles must alternate user/assistant/..."      (Gemma 3)
 *   "Unable to generate parser for this template ... Jinja Exception: ..."
 *
 * Two things were wrong with how that reached the user. It was pasted in raw,
 * a Jinja stack trace with a line and column number into a chat bubble. And in
 * plain chat it arrived under the heading "Agent error", because the chat
 * tools route their turn through the agent executor, so a user who had never
 * touched Agent mode was told the agent had failed.
 *
 * The sequence itself is fixed in api/providers/normalize-system.ts. This is
 * what the user reads when a template refuses anyway.
 */

import { detailOf, withDetail } from './error-text'
import { httpStatusOf } from './http-status'

/**
 * Wordings from the templates themselves plus the wrappers the engines put
 * around them. Deliberately narrow: a plain "invalid request" must not be
 * explained as a template problem.
 */
const TEMPLATE_MARKERS =
  /jinja|raise_exception|chat[ _]template|template error|generate parser for this template|system message must be at the beginning|roles must alternate|conversation roles|last message must be/i

/** Did the model's chat template refuse to render this conversation? */
export function isTemplateRefusal(err: unknown): boolean {
  return TEMPLATE_MARKERS.test(detailOf(err))
}

export const TEMPLATE_REFUSAL_SENTENCE =
  "This model's chat template refused the conversation, so the request never reached the model. " +
  'Templates like this one accept only a strict order of turns. LU reshapes the history for them, ' +
  'and this one still did not fit. Send the message again, start a new chat, or pick a model whose ' +
  'template is more forgiving.'

export const BAD_REQUEST_SENTENCE =
  'The model backend refused the request before generating anything (HTTP 400). ' +
  'Nothing was sent to the model, so nothing was charged. Send the message again, and if it keeps ' +
  'happening, start a new chat or pick another model.'

/**
 * The English sentence for a refusal that produced no output at all, or null
 * when this error is not one of those. Callers put it in place of the raw
 * message; the raw text is kept underneath it, because support reads it.
 */
export function explainSendRefusal(err: unknown): string | null {
  if (isTemplateRefusal(err)) return withDetail(TEMPLATE_REFUSAL_SENTENCE, err)
  if (httpStatusOf(err) === 400) return withDetail(BAD_REQUEST_SENTENCE, err)
  return null
}
