// The shape of one group round, and the choices a person makes about it
// (3.0.9, GH #199 and GH #200).
//
// A round is the user's line and the answers after it, up to the next user
// line. The speakers of a round are those answers' models, in the order they
// spoke. Pure functions only: the hook runs the turns, the store keeps the
// versions, the menu draws the order.
import type { Message } from '../types/chat'

const isAnswer = (m: Message): boolean => m.role === 'assistant' && !m.hidden

/**
 * The answers of the same round that come AFTER `messageId`, in order.
 * Empty when it was the last speaker, when the next user line follows it,
 * or when the message is not in the thread.
 */
export function laterAnswersInRound(messages: readonly Message[], messageId: string): Message[] {
  const at = messages.findIndex((m) => m.id === messageId)
  if (at < 0) return []
  const out: Message[] = []
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && !m.hidden) break
    if (isAnswer(m)) out.push(m)
  }
  return out
}

/** Whether a user line comes anywhere after `messageId`: a regenerate there
 *  takes the later rounds into the old version along with it. */
export function hasLaterRounds(messages: readonly Message[], messageId: string): boolean {
  const at = messages.findIndex((m) => m.id === messageId)
  return at >= 0 && messages.slice(at + 1).some((m) => m.role === 'user' && !m.hidden)
}

/** Whether this answer is a group speaker's turn that can be regenerated on
 *  its own: an assistant answer with the model that wrote it, after a user
 *  line. */
export function isSpeakerTurn(messages: readonly Message[], messageId: string): boolean {
  const at = messages.findIndex((m) => m.id === messageId)
  if (at < 0) return false
  const m = messages[at]
  if (!isAnswer(m) || !m.modelId) return false
  return messages.slice(0, at).some((x) => x.role === 'user')
}

/**
 * Who speaks when one answer is regenerated (GH #199).
 *
 *  - 'only': that speaker alone; the later answers of the round are kept.
 *  - 'from-here': that speaker and every later one of the round, in the
 *    order they spoke, each answering again on what is said before it.
 *
 * Only speakers whose model is still at the table (`available`) are asked;
 * one that left the list sits it out, as in a new round (GH #165).
 */
export function regenerateSpeakers(
  messages: readonly Message[],
  messageId: string,
  mode: 'only' | 'from-here',
  available: readonly string[],
): string[] {
  const target = messages.find((m) => m.id === messageId)
  if (!target?.modelId) return []
  const order = mode === 'only'
    ? [target.modelId]
    : [target.modelId, ...laterAnswersInRound(messages, messageId).map((m) => m.modelId).filter((x): x is string => !!x)]
  return order.filter((m) => available.includes(m))
}

/**
 * The members that answer the next round (GH #200): the group's order, less
 * whoever the person set to sit this one out. A pick that would leave nobody
 * is not a pick: everyone answers, as before.
 */
export function nextRoundSpeakers(members: readonly string[], sitOut: readonly string[] | undefined): string[] {
  if (!sitOut?.length) return [...members]
  const left = members.filter((m) => !sitOut.includes(m))
  return left.length ? left : [...members]
}

/** The order after moving the member at `from` to `to` (drag and drop, or
 *  one step with the arrows). Out of range leaves the order as it was. */
export function moveMember(members: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= members.length || to < 0 || to >= members.length || from === to) return [...members]
  const next = [...members]
  const [m] = next.splice(from, 1)
  next.splice(to, 0, m)
  return next
}

/**
 * The later answers of a kept round, as copies for the new version (GH #199,
 * "keep the later answers"). They stand in two versions then, the old one
 * and the new one, and every message has to live in exactly one place
 * (lib/chat-forks.ts), so the copies get ids of their own.
 */
export function copiesForNewVersion(answers: readonly Message[], newId: () => string): Message[] {
  return answers.map((m) => {
    const copy: Message = { ...m, id: newId() }
    delete copy.historyTrim
    return copy
  })
}
