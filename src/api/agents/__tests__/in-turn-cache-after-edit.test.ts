/**
 * A1 ZUSATZTEST: after the decay caps a result, the way back to the full
 * bytes is a fresh read. That way back only works if the in-turn cache
 * does NOT answer it from the copy it made before the edit.
 *
 * The existing suite covers file_write and shell_execute. file_edit is the one
 * the coding loop actually uses (the prompt tells the model to prefer it over
 * file_write), so it gets its own witness: an edit followed by a re-read has to
 * miss the cache, or the model reads back the version it just replaced and then
 * edits against content that no longer exists on disk.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { makeInTurnCacheLookup } from '../in-turn-cache'
import { useToolAuditStore } from '../../../stores/toolAuditStore'
import { stableArgsHash } from '../block-helpers'
import type { ExecutionRequest } from '../tool-executor'
import type { ToolArgs } from '../../mcp/types'

const req = (id: string, toolName: string, args: ToolArgs): ExecutionRequest => ({
  id, toolName, args,
})

describe('A1: a re-read after file_edit never comes from the cache', () => {
  beforeEach(() => useToolAuditStore.getState().clearAll())

  it('misses the cache for the file that was edited', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/a.ts' }
    const rid = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(rid, { status: 'completed', completedAt: 1050, resultPreview: 'const a = 1' })

    const eid = s.record({
      convId: 'c1',
      toolCallId: 'e1',
      toolName: 'file_edit',
      args: { path: '/proj/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
      startedAt: 1100,
    })
    s.complete(eid, { status: 'completed', completedAt: 1150, resultPreview: 'edited' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('r2', 'file_read', args), stableArgsHash(args))).toBeUndefined()
  })

  it('misses for OTHER files too, because an edit can move more than one', () => {
    // Conservative on purpose: re-reading is cheap and always correct, while a
    // stale hit is silent and wrong.
    const s = useToolAuditStore.getState()
    const other = { path: '/proj/b.ts' }
    const rid = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args: other, startedAt: 1000 })
    s.complete(rid, { status: 'completed', completedAt: 1050, resultPreview: 'import a' })
    const eid = s.record({
      convId: 'c1',
      toolCallId: 'e1',
      toolName: 'file_edit',
      args: { path: '/proj/a.ts', old_string: 'x', new_string: 'y' },
      startedAt: 1100,
    })
    s.complete(eid, { status: 'completed', completedAt: 1150, resultPreview: 'edited' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('r2', 'file_read', other), stableArgsHash(other))).toBeUndefined()
  })

  it('a file_list of the edited folder is invalidated as well', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj' }
    const lid = s.record({ convId: 'c1', toolCallId: 'l1', toolName: 'file_list', args, startedAt: 1000 })
    s.complete(lid, { status: 'completed', completedAt: 1050, resultPreview: 'a.ts' })
    const eid = s.record({
      convId: 'c1',
      toolCallId: 'e1',
      toolName: 'file_edit',
      args: { path: '/proj/a.ts', old_string: 'x', new_string: 'y' },
      startedAt: 1100,
    })
    s.complete(eid, { status: 'completed', completedAt: 1150, resultPreview: 'edited' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('l2', 'file_list', args), stableArgsHash(args))).toBeUndefined()
  })

  it('control: with no edit in between the same read is still served', () => {
    const s = useToolAuditStore.getState()
    const args = { path: '/proj/a.ts' }
    const rid = s.record({ convId: 'c1', toolCallId: 'r1', toolName: 'file_read', args, startedAt: 1000 })
    s.complete(rid, { status: 'completed', completedAt: 1050, resultPreview: 'const a = 1' })
    // A plan update touches no file and must not throw the cache away.
    const tid = s.record({ convId: 'c1', toolCallId: 't1', toolName: 'todo_write', args: { todos: [] }, startedAt: 1100 })
    s.complete(tid, { status: 'completed', completedAt: 1110, resultPreview: 'ok' })

    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup(req('r2', 'file_read', args), stableArgsHash(args))).toBe('const a = 1')
  })
})
