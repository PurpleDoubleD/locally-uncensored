/**
 * CA U4: "Rewind to here" puts files back the way they were before a message.
 * A fake disk stands in for fs_read / fs_write / fs_delete.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async (cmd: string, a: { path: string; content?: string }) => {
    const abs = a.path.startsWith('/') ? a.path : `/ws/${a.path}`
    if (cmd === 'fs_read') {
      if (!disk.has(abs)) throw new Error(`File not found: ${abs}`)
      return { content: disk.get(abs), encoding: 'utf8' }
    }
    if (cmd === 'fs_write') { disk.set(abs, a.content ?? ''); return { status: 'saved', path: abs } }
    if (cmd === 'fs_delete') { if (!disk.delete(abs)) throw new Error('File not found'); return { deleted: true } }
    throw new Error(cmd)
  }),
}))

import { backendCall } from '../../../api/backend'
import { useChatStore } from '../../../stores/chatStore'
import {
  MAX_FILE_CHARS, planSize, readBefore, recordWrite, rewindFiles, rewindPlan, rewindSummary, textBefore, useCheckpointStore,
} from '../checkpoints'

const CONV = 'c1'
let clock = 1000

function userSays(id: string) {
  clock += 10
  const conv = useChatStore.getState().conversations.find((c) => c.id === CONV)!
  conv.messages.push({ id, role: 'user', content: id, timestamp: clock } as never)
  vi.setSystemTime(clock + 1)
  return clock
}

/** What file_write does: read before, write, record. */
async function agentWrites(path: string, content: string) {
  const target = { path, chatId: CONV }
  const before = await readBefore(target)
  const w = await backendCall<{ status: string; path: string }>('fs_write', { ...target, content })
  recordWrite(CONV, target, before, w.path)
}

beforeEach(() => {
  vi.useFakeTimers()
  disk.clear()
  useCheckpointStore.setState({ byConv: {}, trimmedBefore: {} })
  useChatStore.setState({ conversations: [{ id: CONV, title: 't', messages: [] } as never] } as never)
})

describe('rewinding files', () => {
  it('puts an edited file back and removes a new one', async () => {
    disk.set('/ws/a.ts', 'old a')
    const t1 = userSays('m1')
    await agentWrites('a.ts', 'new a')
    await agentWrites('a.ts', 'newer a') // second write in the same turn: the first "before" counts
    await agentWrites('b.ts', 'made up')
    expect(planSize(rewindPlan(CONV, t1))).toBe(2)
    const r = await rewindFiles(CONV, t1)
    expect(disk.get('/ws/a.ts')).toBe('old a')
    expect(disk.has('/ws/b.ts')).toBe(false)
    expect(r).toEqual({ restored: 1, removed: 1, failed: [] })
    expect(rewindSummary(r)).toBe('1 file put back, 1 new file removed.')
    expect(planSize(rewindPlan(CONV, t1))).toBe(0)
  })

  it('rewinding to an earlier message undoes every later turn', async () => {
    disk.set('/ws/a.ts', 'v0')
    const t1 = userSays('m1')
    await agentWrites('a.ts', 'v1')
    const t2 = userSays('m2')
    await agentWrites('a.ts', 'v2')
    await agentWrites('c.ts', 'new in turn 2')
    expect(planSize(rewindPlan(CONV, t2))).toBe(2)
    await rewindFiles(CONV, t1)
    expect(disk.get('/ws/a.ts')).toBe('v0')
    expect(disk.has('/ws/c.ts')).toBe(false)
  })

  it('rewinding to a later message keeps the earlier turn', async () => {
    disk.set('/ws/a.ts', 'v0')
    userSays('m1')
    await agentWrites('a.ts', 'v1')
    const t2 = userSays('m2')
    await agentWrites('a.ts', 'v2')
    await rewindFiles(CONV, t2)
    expect(disk.get('/ws/a.ts')).toBe('v1')
  })

  it('a message with no writes from it on offers nothing', async () => {
    userSays('m1')
    await agentWrites('a.ts', 'x')
    const t2 = userSays('m2')
    expect(planSize(rewindPlan(CONV, t2))).toBe(0)
  })

  it('names a file it could not keep instead of pretending', async () => {
    const t1 = userSays('m1')
    recordWrite(CONV, { path: '/ws/big.txt', chatId: CONV }, textBefore('x'.repeat(MAX_FILE_CHARS + 1)), '/ws/big.txt')
    const plan = rewindPlan(CONV, t1)
    expect(plan.unkept).toEqual([{ path: '/ws/big.txt', why: 'too-big' }])
    expect(plan.restore).toHaveLength(0)
  })

  it('keeps nothing for a chat it does not know', async () => {
    recordWrite('nope', { path: 'a' }, { kind: 'missing' })
    recordWrite(null, { path: 'a' }, { kind: 'missing' })
    expect(useCheckpointStore.getState().byConv).toEqual({})
  })
})

describe('every write path records', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')
  it('file_write, file_edit and an applied Ask-mode change', () => {
    const tools = src('api/mcp/builtin-tools.ts')
    expect(tools.match(/recordWrite\(/g)?.length).toBe(2)
    expect(src('lib/staged-apply.ts')).toContain('recordWrite(chatId, target, before, res.path)')
  })
})
