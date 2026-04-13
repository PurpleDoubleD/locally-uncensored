import { describe, it, expect, beforeEach } from 'vitest'
import { useCompareStore } from '../compareStore'
import type { Message } from '../../types/chat'

// ── Helpers ─────────────────────────────────────────────────────

function makeUserMessage(content: string): Message {
  return {
    id: `user-${Date.now()}-${Math.random()}`,
    role: 'user',
    content,
    timestamp: Date.now(),
  }
}

const STATS_A = { tokens: 100, timeMs: 2000, tokensPerSec: 50 }
const STATS_B = { tokens: 120, timeMs: 2500, tokensPerSec: 48 }

// ═══════════════════════════════════════════════════════════════
//  compareStore
// ═══════════════════════════════════════════════════════════════

describe('compareStore', () => {
  beforeEach(() => {
    useCompareStore.setState({
      isComparing: false,
      modelA: '',
      modelB: '',
      messagesA: [],
      messagesB: [],
      statsA: null,
      statsB: null,
      isStreamingA: false,
      isStreamingB: false,
    })
  })

  // ── Initial state ──────────────────────────────────────────

  describe('initial state', () => {
    it('has correct defaults', () => {
      const state = useCompareStore.getState()
      expect(state.isComparing).toBe(false)
      expect(state.modelA).toBe('')
      expect(state.modelB).toBe('')
      expect(state.messagesA).toEqual([])
      expect(state.messagesB).toEqual([])
      expect(state.statsA).toBeNull()
      expect(state.statsB).toBeNull()
      expect(state.isStreamingA).toBe(false)
      expect(state.isStreamingB).toBe(false)
    })
  })

  // ── setComparing / setModelA / setModelB ───────────────────

  describe('basic setters', () => {
    it('setComparing toggles comparison mode', () => {
      useCompareStore.getState().setComparing(true)
      expect(useCompareStore.getState().isComparing).toBe(true)
      useCompareStore.getState().setComparing(false)
      expect(useCompareStore.getState().isComparing).toBe(false)
    })

    it('setModelA sets model name', () => {
      useCompareStore.getState().setModelA('llama3')
      expect(useCompareStore.getState().modelA).toBe('llama3')
    })

    it('setModelB sets model name', () => {
      useCompareStore.getState().setModelB('mistral')
      expect(useCompareStore.getState().modelB).toBe('mistral')
    })
  })

  // ── startRound ─────────────────────────────────────────────

  describe('startRound', () => {
    it('adds user message and empty assistant message to both sides', () => {
      const msg = makeUserMessage('Hello')
      useCompareStore.getState().startRound(msg)
      const state = useCompareStore.getState()
      expect(state.messagesA).toHaveLength(2)
      expect(state.messagesB).toHaveLength(2)
      expect(state.messagesA[0].role).toBe('user')
      expect(state.messagesA[0].content).toBe('Hello')
      expect(state.messagesA[1].role).toBe('assistant')
      expect(state.messagesA[1].content).toBe('')
      expect(state.messagesB[0].role).toBe('user')
      expect(state.messagesB[1].role).toBe('assistant')
    })

    it('sets both sides to streaming', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      expect(useCompareStore.getState().isStreamingA).toBe(true)
      expect(useCompareStore.getState().isStreamingB).toBe(true)
    })

    it('resets stats to null', () => {
      useCompareStore.setState({ statsA: STATS_A, statsB: STATS_B })
      useCompareStore.getState().startRound(makeUserMessage('New round'))
      expect(useCompareStore.getState().statsA).toBeNull()
      expect(useCompareStore.getState().statsB).toBeNull()
    })

    it('appends to existing messages across multiple rounds', () => {
      useCompareStore.getState().startRound(makeUserMessage('Round 1'))
      useCompareStore.getState().startRound(makeUserMessage('Round 2'))
      expect(useCompareStore.getState().messagesA).toHaveLength(4) // 2 per round
      expect(useCompareStore.getState().messagesB).toHaveLength(4)
    })

    it('creates assistant messages with unique ids', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      const idA = useCompareStore.getState().messagesA[1].id
      const idB = useCompareStore.getState().messagesB[1].id
      expect(idA).toContain('a-')
      expect(idB).toContain('b-')
      expect(idA).not.toBe(idB)
    })
  })

  // ── addContentA / addContentB ──────────────────────────────

  describe('addContentA', () => {
    it('appends content to the last assistant message', () => {
      useCompareStore.getState().startRound(makeUserMessage('Hi'))
      useCompareStore.getState().addContentA('Hello')
      useCompareStore.getState().addContentA(' world')
      const lastA = useCompareStore.getState().messagesA[1]
      expect(lastA.content).toBe('Hello world')
    })

    it('does nothing when there are no messages', () => {
      useCompareStore.getState().addContentA('orphaned chunk')
      expect(useCompareStore.getState().messagesA).toEqual([])
    })

    it('does nothing when last message is not assistant', () => {
      useCompareStore.setState({
        messagesA: [makeUserMessage('only user')],
      })
      useCompareStore.getState().addContentA('chunk')
      // last message is still user, content not appended to it
      const last = useCompareStore.getState().messagesA[0]
      expect(last.content).toBe('only user')
    })
  })

  describe('addContentB', () => {
    it('appends content to the last assistant message', () => {
      useCompareStore.getState().startRound(makeUserMessage('Hi'))
      useCompareStore.getState().addContentB('Response')
      useCompareStore.getState().addContentB(' part 2')
      const lastB = useCompareStore.getState().messagesB[1]
      expect(lastB.content).toBe('Response part 2')
    })

    it('does nothing when there are no messages', () => {
      useCompareStore.getState().addContentB('orphaned')
      expect(useCompareStore.getState().messagesB).toEqual([])
    })
  })

  // ── Multiple streaming chunks concatenate ──────────────────

  describe('streaming chunks', () => {
    it('concatenates multiple chunks into a single response', () => {
      useCompareStore.getState().startRound(makeUserMessage('Prompt'))
      useCompareStore.getState().addContentA('The ')
      useCompareStore.getState().addContentA('quick ')
      useCompareStore.getState().addContentA('brown ')
      useCompareStore.getState().addContentA('fox')
      expect(useCompareStore.getState().messagesA[1].content).toBe('The quick brown fox')
    })

    it('A and B stream independently', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().addContentA('A-response')
      useCompareStore.getState().addContentB('B-response')
      expect(useCompareStore.getState().messagesA[1].content).toBe('A-response')
      expect(useCompareStore.getState().messagesB[1].content).toBe('B-response')
    })
  })

  // ── finishA / finishB ──────────────────────────────────────

  describe('finishA', () => {
    it('sets final content and stats, stops streaming', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().addContentA('partial')
      useCompareStore.getState().finishA('Complete response A', STATS_A)
      const state = useCompareStore.getState()
      expect(state.messagesA[1].content).toBe('Complete response A')
      expect(state.statsA).toEqual(STATS_A)
      expect(state.isStreamingA).toBe(false)
    })

    it('does not affect side B', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().finishA('Done A', STATS_A)
      expect(useCompareStore.getState().isStreamingB).toBe(true)
      expect(useCompareStore.getState().statsB).toBeNull()
    })
  })

  describe('finishB', () => {
    it('sets final content and stats, stops streaming', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().addContentB('partial')
      useCompareStore.getState().finishB('Complete response B', STATS_B)
      const state = useCompareStore.getState()
      expect(state.messagesB[1].content).toBe('Complete response B')
      expect(state.statsB).toEqual(STATS_B)
      expect(state.isStreamingB).toBe(false)
    })

    it('does not affect side A', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().finishB('Done B', STATS_B)
      expect(useCompareStore.getState().isStreamingA).toBe(true)
      expect(useCompareStore.getState().statsA).toBeNull()
    })
  })

  // ── setStreamingA / setStreamingB ──────────────────────────

  describe('streaming flags', () => {
    it('setStreamingA controls streaming state', () => {
      useCompareStore.getState().setStreamingA(true)
      expect(useCompareStore.getState().isStreamingA).toBe(true)
      useCompareStore.getState().setStreamingA(false)
      expect(useCompareStore.getState().isStreamingA).toBe(false)
    })

    it('setStreamingB controls streaming state', () => {
      useCompareStore.getState().setStreamingB(true)
      expect(useCompareStore.getState().isStreamingB).toBe(true)
      useCompareStore.getState().setStreamingB(false)
      expect(useCompareStore.getState().isStreamingB).toBe(false)
    })
  })

  // ── reset ──────────────────────────────────────────────────

  describe('reset', () => {
    it('clears messages, stats, and streaming state', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().addContentA('A')
      useCompareStore.getState().addContentB('B')
      useCompareStore.getState().finishA('A done', STATS_A)
      useCompareStore.getState().finishB('B done', STATS_B)
      useCompareStore.getState().reset()

      const state = useCompareStore.getState()
      expect(state.messagesA).toEqual([])
      expect(state.messagesB).toEqual([])
      expect(state.statsA).toBeNull()
      expect(state.statsB).toBeNull()
      expect(state.isStreamingA).toBe(false)
      expect(state.isStreamingB).toBe(false)
    })

    it('does not reset model names or isComparing', () => {
      useCompareStore.setState({ modelA: 'llama3', modelB: 'mistral', isComparing: true })
      useCompareStore.getState().reset()
      expect(useCompareStore.getState().modelA).toBe('llama3')
      expect(useCompareStore.getState().modelB).toBe('mistral')
      expect(useCompareStore.getState().isComparing).toBe(true)
    })

    it('is idempotent on clean state', () => {
      useCompareStore.getState().reset()
      const state = useCompareStore.getState()
      expect(state.messagesA).toEqual([])
      expect(state.messagesB).toEqual([])
    })
  })

  // ── Graceful handling edge cases ───────────────────────────

  describe('edge cases', () => {
    it('finishA with no messages does not crash', () => {
      // No startRound — messagesA is empty
      expect(() => {
        useCompareStore.getState().finishA('content', STATS_A)
      }).not.toThrow()
    })

    it('finishB with no messages does not crash', () => {
      expect(() => {
        useCompareStore.getState().finishB('content', STATS_B)
      }).not.toThrow()
    })

    it('addContentA with empty string is a no-op on content', () => {
      useCompareStore.getState().startRound(makeUserMessage('Test'))
      useCompareStore.getState().addContentA('')
      expect(useCompareStore.getState().messagesA[1].content).toBe('')
    })
  })
})
