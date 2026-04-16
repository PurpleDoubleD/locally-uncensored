import { describe, it, expect, beforeEach } from 'vitest'
import {
  useToolAuditStore,
  AUDIT_MAX_PER_CONV,
  AUDIT_RESULT_PREVIEW_CHARS,
} from '../toolAuditStore'

describe('toolAuditStore', () => {
  beforeEach(() => {
    useToolAuditStore.getState().clearAll()
  })

  describe('record', () => {
    it('appends a running entry with derived argsHash and default startedAt', () => {
      const id = useToolAuditStore.getState().record({
        convId: 'c1',
        toolCallId: 'tc1',
        toolName: 'web_search',
        args: { q: 'x' },
      })
      const list = useToolAuditStore.getState().forConversation('c1')
      expect(list).toHaveLength(1)
      const e = list[0]
      expect(e.id).toBe(id)
      expect(e.status).toBe('running')
      expect(e.argsHash).toBeTypeOf('string')
      expect(e.startedAt).toBeGreaterThan(0)
    })

    it('isolates entries per conversation', () => {
      const s = useToolAuditStore.getState()
      s.record({ convId: 'a', toolCallId: 'tc', toolName: 't', args: {} })
      s.record({ convId: 'b', toolCallId: 'tc', toolName: 't', args: {} })
      expect(s.forConversation('a')).toHaveLength(1)
      expect(s.forConversation('b')).toHaveLength(1)
    })

    it('honours explicit startedAt', () => {
      useToolAuditStore.getState().record({
        convId: 'c1',
        toolCallId: 'tc',
        toolName: 't',
        args: {},
        startedAt: 1000,
      })
      expect(useToolAuditStore.getState().forConversation('c1')[0].startedAt).toBe(1000)
    })

    it('stores parentToolCallId for sub-agent lineage', () => {
      useToolAuditStore.getState().record({
        convId: 'c1',
        toolCallId: 'child',
        toolName: 't',
        args: {},
        parentToolCallId: 'parent',
      })
      expect(useToolAuditStore.getState().forConversation('c1')[0].parentToolCallId).toBe(
        'parent'
      )
    })
  })

  describe('ring-buffer eviction', () => {
    it(`evicts oldest once ${AUDIT_MAX_PER_CONV} is exceeded`, () => {
      const s = useToolAuditStore.getState()
      for (let i = 0; i < AUDIT_MAX_PER_CONV + 20; i++) {
        s.record({
          convId: 'c1',
          toolCallId: `tc${i}`,
          toolName: 't',
          args: { i },
        })
      }
      const list = s.forConversation('c1')
      expect(list).toHaveLength(AUDIT_MAX_PER_CONV)
      // Newest first — last inserted toolCallId is at the top.
      expect(list[0].toolCallId).toBe(`tc${AUDIT_MAX_PER_CONV + 19}`)
      // Oldest 20 are gone.
      expect(list.some((e) => e.toolCallId === 'tc0')).toBe(false)
      expect(list.some((e) => e.toolCallId === 'tc19')).toBe(false)
      expect(list.some((e) => e.toolCallId === 'tc20')).toBe(true)
    })
  })

  describe('complete', () => {
    it('patches status/durationMs/resultPreview and clips long previews', () => {
      const s = useToolAuditStore.getState()
      const id = s.record({
        convId: 'c1',
        toolCallId: 'tc1',
        toolName: 't',
        args: {},
        startedAt: 1000,
      })
      const big = 'x'.repeat(AUDIT_RESULT_PREVIEW_CHARS + 200)
      s.complete(id, {
        status: 'completed',
        completedAt: 1500,
        resultPreview: big,
      })
      const e = s.forConversation('c1')[0]
      expect(e.status).toBe('completed')
      expect(e.completedAt).toBe(1500)
      expect(e.durationMs).toBe(500)
      expect(e.resultPreview?.length).toBe(AUDIT_RESULT_PREVIEW_CHARS)
    })

    it('completing unknown id is a no-op (no throw)', () => {
      expect(() =>
        useToolAuditStore.getState().complete('nope', { status: 'failed' })
      ).not.toThrow()
    })

    it('derives durationMs using Date.now() when completedAt omitted', () => {
      const s = useToolAuditStore.getState()
      const id = s.record({
        convId: 'c1',
        toolCallId: 'tc',
        toolName: 't',
        args: {},
        startedAt: Date.now() - 100,
      })
      s.complete(id, { status: 'completed' })
      const e = s.forConversation('c1')[0]
      expect(e.durationMs).toBeGreaterThanOrEqual(100)
    })
  })

  describe('findByToolCallId', () => {
    it('finds within a specific conversation', () => {
      const s = useToolAuditStore.getState()
      s.record({ convId: 'a', toolCallId: 'x', toolName: 't', args: {} })
      s.record({ convId: 'b', toolCallId: 'x', toolName: 't', args: {} })
      expect(s.findByToolCallId('x', 'a')?.convId).toBe('a')
      expect(s.findByToolCallId('x', 'b')?.convId).toBe('b')
    })
    it('searches across all conversations when convId omitted', () => {
      const s = useToolAuditStore.getState()
      s.record({ convId: 'a', toolCallId: 'only-in-a', toolName: 't', args: {} })
      expect(s.findByToolCallId('only-in-a')).toBeDefined()
    })
    it('returns undefined when missing', () => {
      expect(useToolAuditStore.getState().findByToolCallId('missing')).toBeUndefined()
    })
  })

  describe('findCacheCandidate', () => {
    it('returns matching completed entry with same (tool, argsHash) after sinceMs', () => {
      const s = useToolAuditStore.getState()
      const id = s.record({
        convId: 'c1',
        toolCallId: 'tc1',
        toolName: 'web_search',
        args: { q: 'abc' },
        startedAt: 1000,
      })
      s.complete(id, { status: 'completed', completedAt: 1100, resultPreview: 'r' })
      const list = s.forConversation('c1')
      const hash = list[0].argsHash
      expect(s.findCacheCandidate('c1', 'web_search', hash, 500)).toBeDefined()
    })

    it('ignores entries older than sinceMs', () => {
      const s = useToolAuditStore.getState()
      const id = s.record({
        convId: 'c1',
        toolCallId: 'tc',
        toolName: 'web_search',
        args: { q: 'x' },
        startedAt: 100,
      })
      s.complete(id, { status: 'completed' })
      const hash = s.forConversation('c1')[0].argsHash
      expect(s.findCacheCandidate('c1', 'web_search', hash, 10_000)).toBeUndefined()
    })

    it('ignores failed entries', () => {
      const s = useToolAuditStore.getState()
      const id = s.record({
        convId: 'c1',
        toolCallId: 'tc',
        toolName: 'web_search',
        args: { q: 'x' },
      })
      s.complete(id, { status: 'failed' })
      const hash = s.forConversation('c1')[0].argsHash
      expect(s.findCacheCandidate('c1', 'web_search', hash, 0)).toBeUndefined()
    })

    it('does not match different toolName or different args', () => {
      const s = useToolAuditStore.getState()
      const id = s.record({ convId: 'c1', toolCallId: 'tc', toolName: 'web_search', args: { q: 'a' } })
      s.complete(id, { status: 'completed' })
      const hash = s.forConversation('c1')[0].argsHash
      expect(s.findCacheCandidate('c1', 'web_fetch', hash, 0)).toBeUndefined()
      expect(s.findCacheCandidate('c1', 'web_search', 'different-hash', 0)).toBeUndefined()
    })
  })

  describe('countsByStatus', () => {
    it('counts entries by status', () => {
      const s = useToolAuditStore.getState()
      const a = s.record({ convId: 'c1', toolCallId: 'a', toolName: 't', args: {} })
      const b = s.record({ convId: 'c1', toolCallId: 'b', toolName: 't', args: {} })
      s.record({ convId: 'c1', toolCallId: 'c', toolName: 't', args: {} })
      s.complete(a, { status: 'completed' })
      s.complete(b, { status: 'failed' })
      const counts = s.countsByStatus('c1')
      expect(counts.completed).toBe(1)
      expect(counts.failed).toBe(1)
      expect(counts.running).toBe(1)
    })
    it('all zeros for unknown conv', () => {
      const c = useToolAuditStore.getState().countsByStatus('nope')
      expect(Object.values(c).every((n) => n === 0)).toBe(true)
    })
  })

  describe('clearConversation / clearAll', () => {
    it('removes only the specified conversation', () => {
      const s = useToolAuditStore.getState()
      s.record({ convId: 'a', toolCallId: 'x', toolName: 't', args: {} })
      s.record({ convId: 'b', toolCallId: 'y', toolName: 't', args: {} })
      s.clearConversation('a')
      expect(s.forConversation('a')).toEqual([])
      expect(s.forConversation('b')).toHaveLength(1)
    })
    it('clearAll drops everything', () => {
      const s = useToolAuditStore.getState()
      s.record({ convId: 'a', toolCallId: 'x', toolName: 't', args: {} })
      s.clearAll()
      expect(s.forConversation('a')).toEqual([])
    })
  })
})
