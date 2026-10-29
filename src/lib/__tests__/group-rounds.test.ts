/**
 * 3.0.9, GH #199, #200: the shape of a group round, as pure functions.
 * Run: npx vitest run src/lib/__tests__/group-rounds.test.ts
 */
import { describe, it, expect } from 'vitest'
import { copiesForNewVersion, hasLaterRounds, isSpeakerTurn, laterAnswersInRound, moveMember, nextRoundSpeakers, regenerateSpeakers } from '../group-rounds'
import type { Message } from '../../types/chat'

const m = (id: string, role: Message['role'], modelId?: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, content: id, timestamp: 0, ...(modelId ? { modelId } : {}), ...extra })

const thread: Message[] = [
  m('u1', 'user'),
  m('a1', 'assistant', 'A'),
  m('n1', 'system', undefined, { notice: 'info' }),
  m('b1', 'assistant', 'B'),
  m('h1', 'user', undefined, { hidden: true }),
  m('c1', 'assistant', 'C'),
  m('u2', 'user'),
  m('a2', 'assistant', 'A'),
]

describe('a round', () => {
  it('runs to the next visible user line; notices and hidden lines are not speakers', () => {
    expect(laterAnswersInRound(thread, 'a1').map((x) => x.id)).toEqual(['b1', 'c1'])
    expect(laterAnswersInRound(thread, 'c1')).toEqual([])
    expect(laterAnswersInRound(thread, 'missing')).toEqual([])
  })

  it('knows when later rounds follow', () => {
    expect(hasLaterRounds(thread, 'b1')).toBe(true)
    expect(hasLaterRounds(thread, 'a2')).toBe(false)
  })

  it('a speaker turn is an answer with its model after a user line', () => {
    expect(isSpeakerTurn(thread, 'b1')).toBe(true)
    expect(isSpeakerTurn(thread, 'u1')).toBe(false)
    expect(isSpeakerTurn([m('g', 'assistant', 'A')], 'g')).toBe(false)
  })
})

describe('GH #199: who answers again', () => {
  it("'only' is that speaker, 'from-here' it and the later ones in their order", () => {
    expect(regenerateSpeakers(thread, 'a1', 'only', ['A', 'B', 'C'])).toEqual(['A'])
    expect(regenerateSpeakers(thread, 'a1', 'from-here', ['A', 'B', 'C'])).toEqual(['A', 'B', 'C'])
  })

  it('a member no longer at the table sits it out', () => {
    expect(regenerateSpeakers(thread, 'a1', 'from-here', ['A', 'C'])).toEqual(['A', 'C'])
    expect(regenerateSpeakers(thread, 'b1', 'only', ['A', 'C'])).toEqual([])
  })

  it('kept answers come back as copies with ids of their own', () => {
    let n = 0
    const copies = copiesForNewVersion([m('b1', 'assistant', 'B', { historyTrim: { dropped: 3, window: 8192 } })], () => `new${++n}`)
    expect(copies).toEqual([{ id: 'new1', role: 'assistant', content: 'b1', timestamp: 0, modelId: 'B' }])
  })
})

describe('GH #200: order and who answers', () => {
  it('moves a member', () => {
    expect(moveMember(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B'])
    expect(moveMember(['A', 'B', 'C'], 0, 1)).toEqual(['B', 'A', 'C'])
    expect(moveMember(['A', 'B'], 0, 5)).toEqual(['A', 'B'])
  })

  it('the next round is the order less who sits out, never nobody', () => {
    expect(nextRoundSpeakers(['A', 'B', 'C'], undefined)).toEqual(['A', 'B', 'C'])
    expect(nextRoundSpeakers(['A', 'B', 'C'], ['B'])).toEqual(['A', 'C'])
    expect(nextRoundSpeakers(['A', 'B'], ['A', 'B'])).toEqual(['A', 'B'])
  })
})
