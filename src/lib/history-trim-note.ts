// The line the chat shows next to an answer whose request left older turns
// out (GH #201). Before 3.0.9 a trim was said only to the model, in an
// agent's words, and the person found out from a token counter.
import { formatContextWindow } from './formatters'

/**
 * "12 earlier messages were not sent to Baron: they no longer fit its 256K context."
 * A long turn that went out shortened (head and tail) is said as well.
 */
export function historyTrimNote(trim: { dropped: number; window: number; shortened?: number }, speaker?: string): string {
  const who = speaker ? ` to ${speaker}` : ''
  const fit = trim.window > 0 ? `its ${formatContextWindow(trim.window)} context` : 'its context'
  const shortened = trim.shortened ?? 0
  const long = shortened === 1 ? '1 long message was' : `${shortened} long messages were`
  if (!trim.dropped) {
    return `${long} sent shortened${who} to fit ${fit}. The chat itself keeps ${shortened === 1 ? 'it' : 'them'} whole.`
  }
  const what = trim.dropped === 1 ? '1 earlier message was' : `${trim.dropped} earlier messages were`
  const rest = trim.dropped === 1 ? `it no longer fits ${fit}. The chat itself keeps it.` : `they no longer fit ${fit}. The chat itself keeps them.`
  const also = shortened ? ` ${long} sent shortened.` : ''
  return `${what} not sent${who}: ${rest}${also}`
}
