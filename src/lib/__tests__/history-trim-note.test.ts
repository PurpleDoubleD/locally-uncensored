/** GH #201: the line next to an answer whose request left older turns out. */
import { describe, it, expect } from 'vitest'
import { historyTrimNote } from '../history-trim-note'

describe('historyTrimNote', () => {
  it('names the count, the speaker and the window, in chat words', () => {
    expect(historyTrimNote({ dropped: 12, window: 262144 }, 'Baron'))
      .toBe('12 earlier messages were not sent to Baron: they no longer fit its 256K context. The chat itself keeps them.')
    expect(historyTrimNote({ dropped: 1, window: 8192 }))
      .toBe('1 earlier message was not sent: it no longer fits its 8K context. The chat itself keeps it.')
  })
  it('says a long message went out shortened (T1 2026-10-29)', () => {
    expect(historyTrimNote({ dropped: 0, window: 16384, shortened: 1 }, 'coder15'))
      .toBe('1 long message was sent shortened to coder15 to fit its 16K context. The chat itself keeps it whole.')
    expect(historyTrimNote({ dropped: 2, window: 16384, shortened: 2 }))
      .toBe('2 earlier messages were not sent: they no longer fit its 16K context. The chat itself keeps them. 2 long messages were sent shortened.')
  })
  it('never an agent word', () => {
    expect(historyTrimNote({ dropped: 3, window: 0 })).not.toMatch(/task|file|re-read/)
  })
})
