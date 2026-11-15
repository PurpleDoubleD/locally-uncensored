/**
 * Partial apply: a staged file with some hunks rejected writes the original
 * with only the accepted hunks in, and the model hears what was left out at
 * its next tool result.
 *
 * Run: npx vitest run src/lib/__tests__/staged-apply-partial.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({ backendCall: vi.fn() }))
const { addMessage } = vi.hoisted(() => ({ addMessage: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ addMessage }) },
}))

import { backendCall } from '../../api/backend'
import { applyStagedChange, rejectStagedChange, rejectAllStagedChanges, waitForStagedReview } from '../staged-apply'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { createStagedWriter } from '../../hooks/codex/staged-writes'

const backend = backendCall as unknown as ReturnType<typeof vi.fn>
const CHAT = 'chat-partial'

const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
const OLD = base.join('\n') + '\n'
const edited = [...base]
edited[1] = 'TOP EDIT'
edited[25] = 'BOTTOM EDIT'
const NEW = edited.join('\n') + '\n'

let disk: string
function wireBackend() {
  backend.mockReset()
  backend.mockImplementation(async (cmd: string, args: { content?: string }) => {
    if (cmd === 'fs_read') return { content: disk }
    if (cmd === 'fs_write') {
      disk = args.content ?? ''
      return { status: 'saved' }
    }
    return {}
  })
}

const stage = () =>
  useStagedChangesStore.getState().stage(CHAT, { path: 'src/a.ts', oldContent: OLD, newContent: NEW, diff: '' })

beforeEach(() => {
  disk = OLD
  wireBackend()
  addMessage.mockClear()
  useStagedChangesStore.setState({ byChat: {}, notes: {} })
  useAgentModeStore.setState({ workspaceSlugs: { [CHAT]: 'slug' } })
})

describe('partial apply', () => {
  it('writes the original with only the accepted hunk, and leaves a note', async () => {
    const id = stage()
    useStagedChangesStore.getState().decideHunk(CHAT, id, 1, 'rejected')
    await applyStagedChange(CHAT, useStagedChangesStore.getState().get(CHAT, id)!)

    const want = [...base]
    want[1] = 'TOP EDIT'
    expect(disk).toBe(want.join('\n') + '\n')
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)

    const notes = useStagedChangesStore.getState().notes[CHAT]
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toBe(
      'The user applied your change to src/a.ts but rejected 1 of 2 parts (original line 26). Those parts keep the original text. Read the file before you edit it again.',
    )
    expect(addMessage.mock.calls[0][1].content).toBe('Applied staged change: src/a.ts (1 of 2 parts, 1 rejected)')
  })

  it('uses the latest decisions even when the caller holds an older snapshot', async () => {
    const id = stage()
    const snapshot = useStagedChangesStore.getState().get(CHAT, id)!
    useStagedChangesStore.getState().decideHunk(CHAT, id, 0, 'rejected')
    await applyStagedChange(CHAT, snapshot)
    const want = [...base]
    want[25] = 'BOTTOM EDIT'
    expect(disk).toBe(want.join('\n') + '\n')
  })

  it('an Undo opens the hunk again and the full change lands', async () => {
    const id = stage()
    useStagedChangesStore.getState().decideHunk(CHAT, id, 1, 'rejected')
    useStagedChangesStore.getState().decideHunk(CHAT, id, 1, null)
    await applyStagedChange(CHAT, useStagedChangesStore.getState().get(CHAT, id)!)
    expect(disk).toBe(NEW)
    expect(useStagedChangesStore.getState().notes[CHAT]).toBeUndefined()
  })

  it('a partial apply still merges with an edit made on disk meanwhile', async () => {
    const id = stage()
    useStagedChangesStore.getState().decideHunk(CHAT, id, 1, 'rejected')
    const foreign = [...base]
    foreign[14] = 'USER EDIT'
    disk = foreign.join('\n') + '\n'
    await applyStagedChange(CHAT, useStagedChangesStore.getState().get(CHAT, id)!)
    const want = [...foreign]
    want[1] = 'TOP EDIT'
    expect(disk).toBe(want.join('\n') + '\n')
  })
})

describe('rejecting', () => {
  it('a rejected file leaves a note and writes nothing', () => {
    const id = stage()
    rejectStagedChange(CHAT, { id, path: 'src/a.ts' })
    expect(backend).not.toHaveBeenCalled()
    expect(useStagedChangesStore.getState().notes[CHAT][0].text).toBe('The user rejected your change to src/a.ts. Nothing was written to it.')
  })

  it('Reject all leaves one note per file', () => {
    stage()
    useStagedChangesStore.getState().stage(CHAT, { path: 'b.ts', oldContent: '', newContent: 'x\n', diff: '' })
    rejectAllStagedChanges(CHAT)
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(useStagedChangesStore.getState().notes[CHAT].map((n) => n.path)).toEqual(['src/a.ts', 'b.ts'])
  })
})

describe('what the model hears', () => {
  const writer = (waitForReview?: Parameters<typeof createStagedWriter>[0]['waitForReview']) =>
    createStagedWriter({
      convId: CHAT,
      workDir: '.',
      workspaceSlug: 'slug',
      readFile: async () => ({ content: OLD }) as never,
      waitForReview,
    })

  it('the next tool result carries the notes once', async () => {
    const id = stage()
    rejectStagedChange(CHAT, { id, path: 'src/a.ts' })
    const w = writer()
    const first = await w.dispatch('shell_execute', {}, async () => 'ok')
    expect(first).toBe('ok\n\n[User review: The user rejected your change to src/a.ts. Nothing was written to it.]')
    const second = await w.dispatch('shell_execute', {}, async () => 'ok')
    expect(second).toBe('ok')
  })

  it('a blocking review (phone turn) answers with the partial note in the write result, not again later', async () => {
    const w = writer((changeId, path) => {
      // The user rejects the second hunk and applies the rest.
      queueMicrotask(async () => {
        useStagedChangesStore.getState().decideHunk(CHAT, changeId, 1, 'rejected')
        await applyStagedChange(CHAT, useStagedChangesStore.getState().get(CHAT, changeId)!)
      })
      return waitForStagedReview(CHAT, changeId, path)
    })
    const result = await w.dispatch('file_write', { path: 'src/a.ts', content: NEW }, async () => 'unused')
    expect(result).toMatch(/^The user applied your change to src\/a\.ts but rejected 1 of 2 parts/)
    expect(result).not.toContain('[User review:')
    expect(useStagedChangesStore.getState().notes[CHAT]).toBeUndefined()
  })
})
