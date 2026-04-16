import { describe, it, expect, beforeEach } from 'vitest'
import { makeInTurnCacheLookup } from '../in-turn-cache'
import { useToolAuditStore } from '../../../stores/toolAuditStore'
import { stableArgsHash } from '../block-helpers'
import type { ExecutionRequest } from '../tool-executor'

const req = (id: string, toolName: string, args: Record<string, any>): ExecutionRequest => ({
  id, toolName, args,
})

describe('in-turn-cache — makeInTurnCacheLookup', () => {
  beforeEach(() => {
    useToolAuditStore.getState().clearAll()
  })

  it('returns undefined when no prior call exists', () => {
    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: Date.now() - 1000 })
    const args = { query: 'test' }
    const hit = lookup(req('1', 'web_search', args), stableArgsHash(args))
    expect(hit).toBeUndefined()
  })

  it('returns cached result for matching (tool, args) within turn window', () => {
    const s = useToolAuditStore.getState()
    const args = { query: 'hello' }
    const id = s.record({
      convId: 'c1',
      toolCallId: 'prior',
      toolName: 'web_search',
      args,
      startedAt: 1000,
    })
    s.complete(id, { status: 'completed', completedAt: 1100, resultPreview: 'cached-value' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    const hit = lookup(req('new', 'web_search', args), stableArgsHash(args))
    expect(hit).toBe('cached-value')
  })

  it('returns undefined when prior call predates turn start (previous turn)', () => {
    const s = useToolAuditStore.getState()
    const args = { query: 'hello' }
    const id = s.record({
      convId: 'c1',
      toolCallId: 'prior',
      toolName: 'web_search',
      args,
      startedAt: 100, // long before turnStartMs
    })
    s.complete(id, { status: 'completed', completedAt: 200, resultPreview: 'stale' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 10_000 })
    const hit = lookup(req('new', 'web_search', args), stableArgsHash(args))
    expect(hit).toBeUndefined()
  })

  it('does not cross conversations', () => {
    const s = useToolAuditStore.getState()
    const args = { query: 'hello' }
    const id = s.record({ convId: 'c1', toolCallId: 'x', toolName: 'web_search', args })
    s.complete(id, { status: 'completed', resultPreview: 'from-c1' })

    const lookup = makeInTurnCacheLookup({ convId: 'c2', turnStartMs: 0 })
    const hit = lookup(req('new', 'web_search', args), stableArgsHash(args))
    expect(hit).toBeUndefined()
  })

  it('distinguishes args by canonical hash (key order independent)', () => {
    const s = useToolAuditStore.getState()
    const id = s.record({
      convId: 'c1',
      toolCallId: 'x',
      toolName: 'web_search',
      args: { a: 1, b: 2 },
      startedAt: 1000,
    })
    s.complete(id, { status: 'completed', completedAt: 1100, resultPreview: 'same' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    const reorderedArgs = { b: 2, a: 1 }
    const hit = lookup(req('new', 'web_search', reorderedArgs), stableArgsHash(reorderedArgs))
    expect(hit).toBe('same')
  })

  it('ignores failed prior calls even within turn window', () => {
    const s = useToolAuditStore.getState()
    const args = { query: 'hello' }
    const id = s.record({ convId: 'c1', toolCallId: 'x', toolName: 'web_search', args })
    s.complete(id, { status: 'failed', error: 'boom' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 0 })
    const hit = lookup(req('new', 'web_search', args), stableArgsHash(args))
    expect(hit).toBeUndefined()
  })

  it('returns undefined when the cached entry has no resultPreview', () => {
    const s = useToolAuditStore.getState()
    const args = { query: 'x' }
    const id = s.record({ convId: 'c1', toolCallId: 'x', toolName: 'web_search', args })
    // Mark completed but without a resultPreview — should not be cached.
    s.complete(id, { status: 'completed' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 0 })
    expect(lookup(req('new', 'web_search', args), stableArgsHash(args))).toBeUndefined()
  })

  it('cached entry with empty string preview IS returned (empty is valid)', () => {
    const s = useToolAuditStore.getState()
    const args = { q: 'x' }
    const id = s.record({ convId: 'c1', toolCallId: 'x', toolName: 'web_search', args })
    s.complete(id, { status: 'completed', resultPreview: '' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 0 })
    expect(lookup(req('new', 'web_search', args), stableArgsHash(args))).toBe('')
  })

  it('does not match different tool with same args', () => {
    const s = useToolAuditStore.getState()
    const args = { url: 'https://x' }
    const id = s.record({ convId: 'c1', toolCallId: 'x', toolName: 'web_fetch', args })
    s.complete(id, { status: 'completed', resultPreview: 'fetched' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 0 })
    expect(lookup(req('new', 'web_search', args), stableArgsHash(args))).toBeUndefined()
  })
})
