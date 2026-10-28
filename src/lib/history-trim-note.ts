// The line the chat shows next to an answer whose request left older turns
// out (GH #201). Before 3.0.9 a trim was said only to the model, in an
// agent's words, and the person found out from a token counter.
import { formatContextWindow } from './formatters'

/** "12 earlier messages were not sent to Baron: they no longer fit its 256K context." */
export function historyTrimNote(trim: { dropped: number; window: number }, speaker?: string): string {
  const what = trim.dropped === 1 ? '1 earlier message was' : `${trim.dropped} earlier messages were`
  const who = speaker ? ` to ${speaker}` : ''
  const fit = trim.window > 0 ? `its ${formatContextWindow(trim.window)} context` : 'its context'
  const rest = trim.dropped === 1 ? `it no longer fits ${fit}. The chat itself keeps it.` : `they no longer fit ${fit}. The chat itself keeps them.`
  return `${what} not sent${who}: ${rest}`
}
