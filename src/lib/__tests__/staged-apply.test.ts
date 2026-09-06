/**
 * staged-apply — the one trusted write path shared by the Pending panel's
 * Apply buttons and Codex auto-apply (codexAutoApply).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({
  backendCall: vi.fn(),
}))
const { addMessage } = vi.hoisted(() => ({ addMessage: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ addMessage }) },
}))

import { backendCall } from '../../api/backend'
import { applyStagedChange, applyAllStagedChanges } from '../staged-apply'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { useAgentModeStore } from '../../stores/agentModeStore'

const fsWrite = backendCall as unknown as ReturnType<typeof vi.fn>
const CHAT = 'chat-1'
// The run pins the chat's workspace slug on first use and passes it as the
// bridge's `chatId` on every tool call; apply has to write through the same
// name, never the raw conversation id.
const SLUG = 'coding-agent-chat-1'

const stage = (path: string, over: Record<string, unknown> = {}) =>
  useStagedChangesStore.getState().stage(CHAT, {
    path,
    oldContent: '',
    newContent: `content of ${path}`,
    diff: '',
    ...over,
  })

describe('applyStagedChange', () => {
  beforeEach(() => {
    fsWrite.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
    useAgentModeStore.setState({ workspaceSlugs: { [CHAT]: SLUG } })
  })

  // t10 on the box (2026-09-06): with no folder picked, "Apply all" wrote into
  // agent-workspace/<conversation id> while the run had worked in
  // agent-workspace/<slug>, so the model found nothing where it had put it
  // and wrote the files a second time by shell.
  it('writes into the sandbox the run used (the workspace slug), not the raw conversation id', async () => {
    fsWrite.mockResolvedValue({ status: 'saved', path: 'NOTES.md' })
    stage('NOTES.md')
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])

    expect(fsWrite).toHaveBeenCalledWith('fs_write', {
      path: 'NOTES.md',
      content: 'content of NOTES.md',
      chatId: SLUG,
      workingDirectory: undefined,
    })
    const calls = fsWrite.mock.calls.filter(([cmd]) => cmd === 'fs_read' || cmd === 'fs_write')
    expect(calls.every(([, args]) => (args as { chatId: string }).chatId === SLUG)).toBe(true)
    expect(calls.some(([, args]) => (args as { chatId: string }).chatId === CHAT)).toBe(false)
  })

  it('writes via fs_write with the stage-time jail root and dequeues the entry', async () => {
    fsWrite.mockResolvedValue({ status: 'saved', path: '/proj/gui.py' })
    stage('gui.py', { resolvedPath: '/proj/gui.py', workingDirectory: '/proj' })
    const change = useStagedChangesStore.getState().list(CHAT)[0]

    await applyStagedChange(CHAT, change)

    expect(fsWrite).toHaveBeenCalledWith('fs_write', {
      path: '/proj/gui.py',
      content: 'content of gui.py',
      chatId: SLUG,
      workingDirectory: '/proj',
    })
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(addMessage).toHaveBeenCalledOnce()
  })

  it('treats "unchanged" as success but throws on any other status, keeping the entry', async () => {
    fsWrite.mockResolvedValue({ status: 'unchanged', path: '/p/a.py' })
    stage('a.py')
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)

    fsWrite.mockResolvedValue({ status: 'denied' })
    stage('b.py')
    const bad = useStagedChangesStore.getState().list(CHAT)[0]
    await expect(applyStagedChange(CHAT, bad)).rejects.toThrow(/denied/)
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(1)
  })
})

describe('applyAllStagedChanges', () => {
  beforeEach(() => {
    fsWrite.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
  })

  it('applies everything and reports the paths', async () => {
    fsWrite.mockResolvedValue({ status: 'saved' })
    stage('one.py')
    stage('two.py')
    const res = await applyAllStagedChanges(CHAT)
    expect(res.applied.sort()).toEqual(['one.py', 'two.py'])
    expect(res.failed).toEqual([])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  it('one failing write never blocks the rest — it stays queued and is reported', async () => {
    stage('good.py')
    stage('bad.py')
    fsWrite.mockImplementation((_cmd: string, args: { path: string }) =>
      args.path.includes('bad')
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve({ status: 'saved' }),
    )
    const res = await applyAllStagedChanges(CHAT)
    expect(res.applied).toEqual(['good.py'])
    expect(res.failed).toEqual(['bad.py'])
    const left = useStagedChangesStore.getState().list(CHAT)
    expect(left).toHaveLength(1)
    expect(left[0].path).toBe('bad.py')
  })
})

// A staged change carries the file as it looked at stage time. The user reviews
// the diff, edits the file themselves in the meantime, then clicks Apply — the
// write used to silently revert their edit, with no undo.
describe('applyStagedChange refuses to overwrite a file that moved on', () => {
  beforeEach(() => {
    fsWrite.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
  })

  const route = (disk: string | Error) =>
    fsWrite.mockImplementation((cmd: string) => {
      if (cmd === 'fs_read') {
        return disk instanceof Error ? Promise.reject(disk) : Promise.resolve({ content: disk })
      }
      return Promise.resolve({ status: 'saved' })
    })

  it('throws and keeps the entry when the file changed since staging', async () => {
    route('the user edited this')
    stage('a.py', { resolvedPath: '/proj/a.py', workingDirectory: '/proj', oldContent: 'as staged' })
    const change = useStagedChangesStore.getState().list(CHAT)[0]

    await expect(applyStagedChange(CHAT, change)).rejects.toThrow(/changed on disk/)
    expect(fsWrite).not.toHaveBeenCalledWith('fs_write', expect.anything())
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(1)
  })

  it('writes when the file still matches the stage-time content', async () => {
    route('as staged')
    stage('a.py', { resolvedPath: '/proj/a.py', workingDirectory: '/proj', oldContent: 'as staged' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  // An empty baseline is not a licence to overwrite. useCodex also writes an
  // empty oldContent when the stage-time read merely FAILED, so "new file" and
  // "could not look" are the same value here (review 2026-08-14).
  it('a new file that really is not there is created without ceremony', async () => {
    route(new Error('no such file'))
    stage('new.py', { oldContent: '' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(fsWrite).toHaveBeenCalledWith('fs_write', expect.anything())
  })

  it('a new file whose path is occupied refuses instead of overwriting', async () => {
    route('somebody else already wrote this')
    stage('new.py', { resolvedPath: '/proj/new.py', workingDirectory: '/proj', oldContent: '' })
    const change = useStagedChangesStore.getState().list(CHAT)[0]

    await expect(applyStagedChange(CHAT, change)).rejects.toThrow(/changed on disk/)
    expect(fsWrite).not.toHaveBeenCalledWith('fs_write', expect.anything())
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(1)
  })

  it('an empty file at that path is not a collision, the write just fills it', async () => {
    route('')
    stage('new.py', { resolvedPath: '/proj/new.py', workingDirectory: '/proj', oldContent: '' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  it('still writes when the file is gone — the write recreates it', async () => {
    route(new Error('no such file'))
    stage('a.py', { oldContent: 'as staged' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  // Refusing was too blunt: in Morgan's run (2026-08-11) every file had moved
  // on, so a finished plan wrote nothing at all. A foreign edit somewhere else
  // in the file is not a reason to drop work the user approved.
  it('merges a foreign edit elsewhere in the file and says so', async () => {
    route('a\nb\nc\nadded by another tool')
    stage('a.py', {
      resolvedPath: '/proj/a.py',
      workingDirectory: '/proj',
      oldContent: 'a\nb\nc',
      newContent: 'a\nCHANGED\nc',
    })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])

    expect(fsWrite).toHaveBeenCalledWith('fs_write', {
      path: '/proj/a.py',
      content: 'a\nCHANGED\nc\nadded by another tool',
      chatId: SLUG,
      workingDirectory: '/proj',
    })
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(addMessage.mock.calls[0][1].content).toMatch(/merged with 1 change made on disk/)
  })

  // The merge notice was written with `hidden: true`, and both renderers drop
  // hidden messages (MessageList drops every system role on top of that), so
  // the only line that ever said "the bytes on disk are not the diff you
  // approved" reached nobody. On a write with no undo that is the one thing
  // the user must not miss.
  it('the merge notice is visible and marked as something to act on', async () => {
    route('a\nb\nc\nadded by another tool')
    stage('a.py', { oldContent: 'a\nb\nc', newContent: 'a\nCHANGED\nc' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])

    const msg = addMessage.mock.calls[0][1]
    expect(msg.hidden).toBeUndefined()
    expect(msg.notice).toBe('warn')
    expect(msg.content).toMatch(/not byte for byte the diff you approved/)
    // Still a system message: that is what keeps it out of the model payload.
    expect(msg.role).toBe('system')
  })

  it('a clean apply is a quiet confirmation, not a warning', async () => {
    route('a\nb\nc')
    stage('a.py', { oldContent: 'a\nb\nc', newContent: 'a\nCHANGED\nc' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])

    const msg = addMessage.mock.calls[0][1]
    expect(msg.hidden).toBeUndefined()
    expect(msg.notice).toBe('info')
    expect(msg.content).not.toMatch(/merged/)
  })

  it('counts an already-applied file as done instead of failing it', async () => {
    route('a\nCHANGED\nc')
    stage('a.py', { oldContent: 'a\nb\nc', newContent: 'a\nCHANGED\nc' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(addMessage.mock.calls[0][1].content).not.toMatch(/merged/)
  })

  it('names the collision when the same lines moved on both sides', async () => {
    route('a\nTHEIRS\nc')
    stage('a.py', { oldContent: 'a\nb\nc', newContent: 'a\nOURS\nc' })
    await expect(
      applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0]),
    ).rejects.toThrow(/same place this edit touches/)
    expect(fsWrite).not.toHaveBeenCalledWith('fs_write', expect.anything())
  })

  it('one drifted file never blocks the rest of an apply-all', async () => {
    stage('good.py', { oldContent: 'base' })
    stage('drifted.py', { oldContent: 'base' })
    fsWrite.mockImplementation((cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read') {
        return Promise.resolve({ content: args.path.includes('drifted') ? 'moved on' : 'base' })
      }
      return Promise.resolve({ status: 'saved' })
    })
    const res = await applyAllStagedChanges(CHAT)
    expect(res.applied).toEqual(['good.py'])
    expect(res.failed).toEqual(['drifted.py'])
  })
})
