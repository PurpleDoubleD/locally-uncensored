/**
 * Counter-check round 2, side finding 1 (installed Windows build, 2026-08-29).
 *
 * Round one of an agent run wrote `agent-workspace\new-chat-5e61db\r2a.txt`.
 * The app then auto-renamed the chat after the first user message, and round
 * two of the SAME run looked for its file in
 * `agent-workspace\create-a-file-called-r2a-txt-containing-5e61db\` and got
 * "File not found". The folder name has to hang on the conversation id, and folders
 * that older chats already own have to stay reachable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({ backendCall: (...a: unknown[]) => backendCall(...a) }))

import {
  pickLegacyWorkspaceSlug,
  resolveChatWorkspaceSlug,
  __resetWorkspaceDirCacheForTests,
} from '../workspace-slug'
import { chatWorkspaceSlug } from '../agent-context'
import { useAgentModeStore } from '../../stores/agentModeStore'

// The conversation from the counter-check: id part 5e61db, title "New chat"
// at the time of round one, renamed by the app before round two.
const CONV = '5e61db1b-4c2a-4d5e-8f90-112233445566'
const TITLE_BEFORE = 'New chat'
const TITLE_AFTER = 'Create a file called r2a.txt containing HELLO'

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockResolvedValue([])
  __resetWorkspaceDirCacheForTests()
  useAgentModeStore.setState({ workspaceSlugs: {} })
})

describe('pickLegacyWorkspaceSlug', () => {
  it('adopts the folder carrying this conversation id suffix', () => {
    const dirs = ['default', 'some-other-chat-aabbcc', 'new-chat-5e61db']
    expect(pickLegacyWorkspaceSlug(dirs, CONV)).toBe('new-chat-5e61db')
  })

  it('adopts a bare id folder (a chat that never had a title)', () => {
    expect(pickLegacyWorkspaceSlug(['5e61db', 'other-aabbcc'], CONV)).toBe('5e61db')
  })

  it('picks deterministically when two folders share the suffix', () => {
    const dirs = ['zeta-5e61db', 'alpha-5e61db']
    expect(pickLegacyWorkspaceSlug(dirs, CONV)).toBe('alpha-5e61db')
    expect(pickLegacyWorkspaceSlug([...dirs].reverse(), CONV)).toBe('alpha-5e61db')
  })

  // NEGATIVE CONTROL: another chat's folder must never be adopted, and an
  // empty id (whose id part is the shared `noid` bucket) must not match at all
  // because that would hand one chat somebody else's files.
  it('never adopts a foreign folder or matches on an empty id', () => {
    expect(pickLegacyWorkspaceSlug(['new-chat-aabbcc', 'default'], CONV)).toBeNull()
    expect(pickLegacyWorkspaceSlug(['noid', 'x-noid'], '')).toBeNull()
    expect(pickLegacyWorkspaceSlug([], CONV)).toBeNull()
  })

  it('does not match a folder that merely contains the id part', () => {
    expect(pickLegacyWorkspaceSlug(['5e61db-leftovers', 'talk5e61db'], CONV)).toBeNull()
  })
})

describe('resolveChatWorkspaceSlug › the rename must not move the folder', () => {
  it('keeps the round-one folder after the auto-rename', async () => {
    const first = await resolveChatWorkspaceSlug(CONV, TITLE_BEFORE)
    expect(first).toBe('new-chat-5e61db')

    // Round two, same run, new title.
    const second = await resolveChatWorkspaceSlug(CONV, TITLE_AFTER)
    expect(second).toBe(first)
  })

  // NEGATIVE CONTROL: the raw title-derived slug, what the app used before
  // this fix, really does move. Without this the test above could pass on a
  // slug function that ignores the title for unrelated reasons.
  it('the raw title slug DOES drift, which is the bug being fixed', () => {
    expect(chatWorkspaceSlug(CONV, TITLE_BEFORE)).toBe('new-chat-5e61db')
    expect(chatWorkspaceSlug(CONV, TITLE_AFTER)).not.toBe('new-chat-5e61db')
  })

  it('pins per conversation, so two chats never share a folder', async () => {
    const a = await resolveChatWorkspaceSlug(CONV, 'Same title')
    const b = await resolveChatWorkspaceSlug('aabbcc11-0000-0000-0000-000000000000', 'Same title')
    expect(a).not.toBe(b)
    expect(useAgentModeStore.getState().workspaceSlugs[CONV]).toBe(a)
  })

  it('a pin already on disk from an earlier session wins over the title', async () => {
    useAgentModeStore.setState({ workspaceSlugs: { [CONV]: 'pinned-earlier-5e61db' } })
    expect(await resolveChatWorkspaceSlug(CONV, TITLE_AFTER)).toBe('pinned-earlier-5e61db')
    expect(backendCall).not.toHaveBeenCalled()
  })
})

describe('resolveChatWorkspaceSlug › existing folders stay reachable', () => {
  it('adopts an old chat folder instead of inventing a new name', async () => {
    backendCall.mockResolvedValue(['default', 'new-chat-5e61db'])
    const slug = await resolveChatWorkspaceSlug(CONV, TITLE_AFTER)
    expect(slug).toBe('new-chat-5e61db')
    expect(backendCall).toHaveBeenCalledWith('list_agent_workspaces')
  })

  it('reads the directory listing once per session, not once per turn', async () => {
    backendCall.mockResolvedValue(['zzz-aabbcc'])
    await resolveChatWorkspaceSlug(CONV, TITLE_BEFORE)
    await resolveChatWorkspaceSlug('bbccdd11-0000-0000-0000-000000000000', 'Other')
    expect(backendCall.mock.calls.filter((c) => c[0] === 'list_agent_workspaces')).toHaveLength(1)
  })

  // NEGATIVE CONTROL: no backend (browser dev, command missing) must not
  // throw and must not block the run, it just means nothing is adopted.
  it('a failing listing falls back to the computed name', async () => {
    backendCall.mockRejectedValue(new Error('Unknown backend command: list_agent_workspaces'))
    expect(await resolveChatWorkspaceSlug(CONV, TITLE_BEFORE)).toBe('new-chat-5e61db')
  })

  it('a non-array answer is treated as an empty listing', async () => {
    backendCall.mockResolvedValue(null)
    expect(await resolveChatWorkspaceSlug(CONV, TITLE_BEFORE)).toBe('new-chat-5e61db')
  })
})

describe('agentModeStore › pinWorkspaceSlug is write-once', () => {
  it('ignores a second pin for the same conversation', () => {
    useAgentModeStore.getState().pinWorkspaceSlug(CONV, 'first-5e61db')
    useAgentModeStore.getState().pinWorkspaceSlug(CONV, 'second-5e61db')
    expect(useAgentModeStore.getState().workspaceSlugs[CONV]).toBe('first-5e61db')
  })

  // NEGATIVE CONTROL: empty inputs write nothing at all.
  it('refuses an empty id or an empty slug', () => {
    useAgentModeStore.getState().pinWorkspaceSlug('', 'x')
    useAgentModeStore.getState().pinWorkspaceSlug(CONV, '')
    expect(useAgentModeStore.getState().workspaceSlugs).toEqual({})
  })
})
