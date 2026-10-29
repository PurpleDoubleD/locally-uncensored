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
  it('never an agent word', () => {
    expect(historyTrimNote({ dropped: 3, window: 0 })).not.toMatch(/task|file|re-read/)
  })
})
