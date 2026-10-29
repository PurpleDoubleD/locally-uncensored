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
import { isContextOverflow } from './context-overflow'

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

/** A request longer than the window of the model. Sending it again cannot
 *  help, and a local model charges nothing: the general 400 sentence said
 *  both (T1 Nacht-Durchtest 3.0.9, 204K characters into a 16K window). */
export const CONTEXT_OVERFLOW_REFUSAL_SENTENCE =
  'This message is longer than the model can read at once, so nothing was generated. Shorten it, ' +
  'attach long text with Docs instead of pasting it, or raise the Context window above the message box ' +
  'if this model offers one.'

/** A backend that names the temperature in its refusal (A33): one LU Cloud
 *  model takes 0 to 1 and answered 1.9 with a bare 400. */
const TEMPERATURE_MARKERS = /\btemperature\b/i

export const TEMPERATURE_REFUSAL_SENTENCE =
  'This model does not accept the temperature this chat uses, so nothing was generated and nothing ' +
  'was charged. Open Sampling next to the model picker and press Reset to default, or set Temperature ' +
  'to 1.0 or lower.'

/**
 * The English sentence for a refusal that produced no output at all, or null
 * when this error is not one of those. Callers put it in place of the raw
 * message; the raw text is kept underneath it, because support reads it.
 */
export function explainSendRefusal(err: unknown): string | null {
  if (isTemplateRefusal(err)) return withDetail(TEMPLATE_REFUSAL_SENTENCE, err)
  if (httpStatusOf(err) === 400 && TEMPERATURE_MARKERS.test(detailOf(err))) return withDetail(TEMPERATURE_REFUSAL_SENTENCE, err)
  if (httpStatusOf(err) === 400 && isContextOverflow(detailOf(err))) return withDetail(CONTEXT_OVERFLOW_REFUSAL_SENTENCE, err)
  if (httpStatusOf(err) === 400) return withDetail(BAD_REQUEST_SENTENCE, err)
  return null
}
