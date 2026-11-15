/**
 * A26 (3.1.0): the restore hint at every start.
 *
 * LU-Admin, on 3.0.10: "Your backup holds N chats that are not in your chat
 * list. Restore them?" came back at every start. The backup keeps every chat
 * that leaves the list (that is how perrt's chats were saved), a deleted chat
 * counted as missing, and Dismiss kept only the count: the next deleted chat
 * made the count larger and the hint was back.
 *
 * Since C46 a chat deleted while LU runs is noted and not offered. What A26
 * adds: the dismissal holds the ids (it lasts until a chat goes missing that
 * was not offered then), a 3.0.10 dismissal is carried over once, and the
 * backup can be cleared and opened from Settings.
 *
 * Run: npx vitest run src/lib/__tests__/chat-rescue-a26.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backend = vi.hoisted(() => vi.fn())
vi.mock('../../api/backend', () => ({ isTauri: () => true, backendCall: backend }))

import { useChatStore } from '../../stores/chatStore'
import type { Conversation } from '../../types/chat'
import {
  RESCUE_HINT_DISMISSED_KEY, RESCUE_HINT_DISMISSED_MAX, clearChatBackup, decideRescueHint, readDismissal,
  rememberDismissed, restorableChatIds, revealChatBackup, shouldShowRescueHint,
} from '../chat-rescue'
import { __resetDeletionNoteForTests, installDeletionNote } from '../chat-deletion-note'
import { STORE_KEYS } from '../store-backup'

function chat(id: string, updatedAt = 1): Conversation {
  return {
    id, title: id, model: 'm', systemPrompt: '', createdAt: 1, updatedAt,
    messages: [{ id: `${id}-u`, role: 'user', content: 'hi', timestamp: 1 }],
  } as unknown as Conversation
}

function memory(init: Record<string, string> = {}) {
  const mem = new Map(Object.entries(init))
  return {
    mem,
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
}

/** The backup files, as `chat_backup_conversations` hands them back. */
let backup: Conversation[] = []
const savedLs = Reflect.get(globalThis, 'localStorage')
let ls = memory()

beforeEach(() => {
  backup = []
  backend.mockReset()
  backend.mockImplementation(async (cmd: string, args?: { keep?: string[] }) => {
    if (cmd === 'chat_backup_conversations') return JSON.stringify(backup)
    if (cmd === 'chat_backup_clear') {
      const keep = new Set(args?.keep ?? [])
      const before = backup.length
      backup = backup.filter((c) => keep.has(c.id))
      return before - backup.length
    }
    if (cmd === 'chat_backup_reveal') return '/data/stores'
    throw new Error(`unexpected ${cmd}`)
  })
  ls = memory()
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  __resetDeletionNoteForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

afterEach(() => {
  __resetDeletionNoteForTests()
  Object.defineProperty(globalThis, 'localStorage', { value: savedLs, configurable: true, writable: true })
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

const live = () => useChatStore.getState().conversations

/** One start of the app: what the hint decides. */
async function start(): Promise<string[] | null> {
  const ids = await restorableChatIds(live)
  return decideRescueHint(live().length, ids, ls) ? ids : null
}

describe('the 3.0.10 nag, reproduced', () => {
  it('a count dismissal comes back with every chat deleted under 3.0.10 (the report)', () => {
    // Under 3.0.10 nothing noted a deletion. The user had 2 chats and 5 in
    // the backup, dismissed the hint at 3 offered, then deleted 2 more.
    const at3010 = { ids: new Set<string>(), legacyCount: 3 }
    expect(shouldShowRescueHint(2, ['d1', 'd2', 'd3'], at3010)).toBe(false)
    // The old rule, kept for a 3.0.10 value: 5 > 3, the hint is back.
    expect(shouldShowRescueHint(2, ['d1', 'd2', 'd3', 'd4', 'd5'], at3010)).toBe(true)
  })

  it('the first start of 3.1.0 carries that dismissal over, and it holds', async () => {
    useChatStore.setState({ conversations: [chat('a'), chat('b')] })
    backup = [chat('a'), chat('b'), ...['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => chat(id))]
    ls.setItem(RESCUE_HINT_DISMISSED_KEY, '3')
    expect(await start()).toBeNull()
    expect([...readDismissal(ls).ids].sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(readDismissal(ls).legacyCount).toBeNull()
    expect(await start()).toBeNull()
    expect(await start()).toBeNull()
  })

  it('NEGATIVE CONTROL: a chat lost after that still brings the hint', async () => {
    useChatStore.setState({ conversations: [chat('a')] })
    backup = [chat('a'), chat('d1'), chat('d2')]
    ls.setItem(RESCUE_HINT_DISMISSED_KEY, '2')
    expect(await start()).toBeNull()
    backup.push(chat('lost1'), chat('lost2'))
    expect(await start()).toEqual(expect.arrayContaining(['lost1', 'lost2']))
  })

  it('NEGATIVE CONTROL: an empty chat list at the first 3.1.0 start shows, whatever was dismissed (perrt)', async () => {
    backup = [chat('x'), chat('y')]
    ls.setItem(RESCUE_HINT_DISMISSED_KEY, '5')
    expect(await start()).toEqual(['x', 'y'])
  })
})

describe('a dismissal lasts', () => {
  it('deleting chats one by one after Dismiss never brings the hint back', async () => {
    // perrt's case first: a list that came up with one new chat, three lost.
    useChatStore.setState({ conversations: [chat('new')] })
    backup = [chat('l1'), chat('l2'), chat('l3')]
    installDeletionNote()
    const offered = await start()
    expect(offered).toEqual(['l1', 'l2', 'l3'])
    rememberDismissed(ls, offered!)
    // The user keeps chatting and deleting; the backup keeps every one.
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      useChatStore.setState({ conversations: [chat(id), ...live()] })
      backup.push(chat(id))
      useChatStore.getState().deleteConversation(id)
      expect(await start()).toBeNull()
    }
  })

  it('the backup offering fewer chats (archives rotated out) and then one of the old ones again stays quiet', async () => {
    useChatStore.setState({ conversations: [] })
    backup = [chat('l1'), chat('l2'), chat('l3')]
    rememberDismissed(ls, ['l1', 'l2', 'l3'])
    backup = [chat('l1')]
    expect(await start()).toBeNull()
    backup = [chat('l1'), chat('l2')]
    expect(await start()).toBeNull()
  })

  it('the stored list is capped and keeps the newest', () => {
    const many = Array.from({ length: RESCUE_HINT_DISMISSED_MAX + 20 }, (_, i) => `id${i}`)
    rememberDismissed(ls, many)
    const kept = [...readDismissal(ls).ids]
    expect(kept).toHaveLength(RESCUE_HINT_DISMISSED_MAX)
    expect(kept.at(-1)).toBe(`id${RESCUE_HINT_DISMISSED_MAX + 19}`)
  })

  it('an unreadable value counts as never dismissed', () => {
    ls.setItem(RESCUE_HINT_DISMISSED_KEY, '{garbled')
    expect(readDismissal(ls)).toEqual({ ids: new Set(), legacyCount: null })
  })

  it('is in the native backup, so a lost storage does not bring it back', () => {
    expect(STORE_KEYS).toContain(RESCUE_HINT_DISMISSED_KEY)
  })
})

describe('Settings: clear the backup, open its folder', () => {
  it('clear hands over the chat list as it is now and the hint has nothing left to offer', async () => {
    useChatStore.setState({ conversations: [chat('a'), chat('b')] })
    backup = [chat('a'), chat('b'), chat('old1'), chat('old2'), chat('old3')]
    expect(await restorableChatIds(live)).toEqual(['old1', 'old2', 'old3'])
    expect(await clearChatBackup(live)).toBe(3)
    expect(backend).toHaveBeenCalledWith('chat_backup_clear', { keep: ['a', 'b'] })
    expect(await restorableChatIds(live)).toEqual([])
    expect(live().map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('open folder asks the app to show it', async () => {
    await revealChatBackup()
    expect(backend).toHaveBeenCalledWith('chat_backup_reveal')
  })
})
