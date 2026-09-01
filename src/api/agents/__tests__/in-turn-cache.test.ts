import { describe, it, expect, beforeEach } from 'vitest'
import { makeInTurnCacheLookup } from '../in-turn-cache'
import { useToolAuditStore, AUDIT_FULL_RESULT_MAX_CHARS } from '../../../stores/toolAuditStore'
import { stableArgsHash } from '../block-helpers'
import type { ExecutionRequest } from '../tool-executor'
import type { ToolArgs } from '../../mcp/types'

const req = (id: string, toolName: string, args: ToolArgs): ExecutionRequest => ({
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

describe('in-turn-cache — non-idempotent tools are never served (#1)', () => {
  beforeEach(() => useToolAuditStore.getState().clearAll())

  for (const tool of ['shell_execute', 'code_execute', 'run_tests', 'file_write', 'file_edit', 'git_status', 'git_commit']) {
    it(`never serves a cached ${tool}`, () => {
      const s = useToolAuditStore.getState()
      const args = { command: 'npm test' }
      const id = s.record({ convId: 'c1', toolCallId: 'p', toolName: tool, args, startedAt: 1000 })
      s.complete(id, { status: 'completed', completedAt: 1100, resultPreview: 'FAIL: 1 failing' })

      const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
      // Even an identical prior call must re-run, never replay a stale result.
      expect(lookup(req('new', tool, args), stableArgsHash(args))).toBeUndefined()
    })
  }
})

describe('in-turn-cache — read invalidation after mutation (#1)', () => {
  beforeEach(() => useToolAuditStore.getState().clearAll())

  it('serves a cached file_read when nothing mutated after it', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/a.ts' }
    const id = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(id, { status: 'completed', completedAt: 1050, resultPreview: 'const a = 1' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('r2', 'file_read', args), stableArgsHash(args))).toBe('const a = 1')
  })

  it('invalidates a cached file_read once a file_write ran after it', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/a.ts' }
    const rid = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(rid, { status: 'completed', completedAt: 1050, resultPreview: 'const a = 1' })
    // A write lands after the read — the read is now stale.
    const wid = s.record({ convId: 'c1', toolCallId: 'w1', toolName: 'file_write', args: { path: '/proj/a.ts', content: 'const a = 2' }, startedAt: 1100 })
    s.complete(wid, { status: 'completed', completedAt: 1150, resultPreview: 'saved' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('r2', 'file_read', args), stableArgsHash(args))).toBeUndefined()
  })

  it('invalidates a cached file_read after an opaque shell_execute (may touch any path)', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/a.ts' }
    const rid = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(rid, { status: 'completed', completedAt: 1050, resultPreview: 'old' })
    const sid = s.record({ convId: 'c1', toolCallId: 's1', toolName: 'shell_execute', args: { command: 'npm run codegen' }, startedAt: 1100 })
    s.complete(sid, { status: 'completed', completedAt: 1200, resultPreview: 'done' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('r2', 'file_read', args), stableArgsHash(args))).toBeUndefined()
  })
})

describe('in-turn-cache — serves the FULL result, not the panel preview (#9)', () => {
  beforeEach(() => useToolAuditStore.getState().clearAll())

  it('returns the whole file, not the 500-char clipped preview', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/big.ts' }
    const big = 'X'.repeat(600) // longer than AUDIT_RESULT_PREVIEW_CHARS (500)
    const id = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(id, { status: 'completed', completedAt: 1050, resultPreview: big })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    const hit = lookup(req('r2', 'file_read', args), stableArgsHash(args))
    expect(hit).toBe(big)
    expect(hit).toHaveLength(600)
  })

  it('misses (re-reads) when the result exceeds the retained full-result cap', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/huge.log' }
    const huge = 'Y'.repeat(AUDIT_FULL_RESULT_MAX_CHARS + 1)
    const id = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(id, { status: 'completed', completedAt: 1050, resultPreview: huge })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    // Not served as a truncated slice — a miss so the executor re-reads.
    expect(lookup(req('r2', 'file_read', args), stableArgsHash(args))).toBeUndefined()
  })
})

// ── A write is never served from cache, but only disk writes go stale ──
//
// The two ideas used to be one set, which held while every non-cacheable tool
// also touched disk. todo_write broke that: it must always really run (it
// writes the plan the user is watching) while changing no file at all.

describe('in-turn-cache — todo_write', () => {
  beforeEach(() => {
    useToolAuditStore.getState().clearAll()
  })

  const recordDone = (toolName: string, args: ToolArgs, at: number, result: string) => {
    const s = useToolAuditStore.getState()
    const id = s.record({ convId: 'c1', toolCallId: `prior-${toolName}-${at}`, toolName, args, startedAt: at })
    s.complete(id, { status: 'completed', completedAt: at + 10, resultPreview: result })
  }

  it('is never served from cache, even on an identical repeat', () => {
    const args = { todos: [{ content: 'step', status: 'pending' }] }
    recordDone('todo_write', args, 1000, 'stale summary')

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('new', 'todo_write', args), stableArgsHash(args))).toBeUndefined()
  })

  it('does not invalidate a cached file_read the way a real write does', () => {
    // The plan updates after every step. If it counted as a workspace mutation
    // it would throw away every cached read on each update, which is the
    // opposite of what this cache is for.
    const readArgs = { path: 'src/app.ts' }
    recordDone('file_read', readArgs, 1000, 'file contents')
    recordDone('todo_write', { todos: [] }, 2000, 'Plan cleared.')

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('new', 'file_read', readArgs), stableArgsHash(readArgs))).toBe('file contents')
  })

  it('a real write still invalidates that same cached read', () => {
    const readArgs = { path: 'src/app.ts' }
    recordDone('file_read', readArgs, 1000, 'file contents')
    recordDone('file_write', { path: 'src/app.ts', content: 'x' }, 2000, 'written')

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('new', 'file_read', readArgs), stableArgsHash(readArgs))).toBeUndefined()
  })
})
