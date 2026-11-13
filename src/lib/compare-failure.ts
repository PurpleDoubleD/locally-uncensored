/**
 * The sentence a Compare column shows when its model did not answer (C5).
 *
 * The chat says a failure in a short sentence of ours with the raw reason
 * kept underneath (lib/error-text.ts withDetail). A Compare side that failed
 * used to show nothing at all, an empty answer under "0.0 t/s", which read as
 * "the model had nothing to say" and skewed the comparison.
 */
import type { MessageError } from '../types/chat'
import { withDetail } from './error-text'

const SENTENCE: Record<MessageError['kind'], string> = {
  engine: 'The engine could not run this model, so it did not answer.',
  network: 'This model could not be reached, so it did not answer.',
  credits: "You're out of credits, so this model did not answer.",
  session: 'Sign in to LU Cloud again, then send the comparison once more.',
  limit: 'This model hit a request limit and did not answer.',
  interrupted: 'This answer was interrupted.',
  generic: 'This model did not answer.',
}

export function compareFailureText(error: MessageError): string {
  // A request limit's reason is already the full sentence (lib/request-limit.ts).
  if (error.kind === 'limit' && error.detail) return error.detail
  return withDetail(SENTENCE[error.kind] ?? SENTENCE.generic, error.detail)
}
