// @vitest-environment jsdom
/**
 * C46 (3.1.0): restore chats from the automatic backup on the phone, and the
 * hint in the chat list. The backup files are what `chat_backup_conversations`
 * hands back: every chat of the live backup, the ring, prev.json and the chat
 * archives, one entry per id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../../types/chat'

const world = vi.hoisted(() => ({
  backup: [] as unknown[],
  readFails: false,
  written: true,
  hydrated: true,
  onHydrated: [] as (() => void)[],
}))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd !== 'chat_backup_conversations') return null
    if (world.readFails) throw new Error('backup unreadable')
    return JSON.stringify(world.backup)
  },
}))
vi.mock('../../boot/restore', () => ({ restoreDecided: Promise.resolve() }))
vi.mock('../../screens/settings/parts/durable', () => ({ chatsAreWritten: async () => world.written }))
vi.mock('../../../stores/chatStore', async () => {
  const { create } = await import('zustand')
  const store = create<{ conversations: Conversation[]; importConversations: (chats: Conversation[], mode: 'merge') => { added: number; skipped: number } }>((set, get) => ({
    conversations: [],
    importConversations: (chats) => {
      const have = new Set(get().conversations.map((c) => c.id))
      const fresh = chats.filter((c) => !have.has(c.id))
      set({ conversations: [...fresh, ...get().conversations] })
      return { added: fresh.length, skipped: chats.length - fresh.length }
    },
  }))
  Object.assign(store, {
    persist: {
      hasHydrated: () => world.hydrated,
      onFinishHydration: (fn: () => void) => void world.onHydrated.push(fn),
    },
  })
  return { useChatStore: store }
})

const chat = (id: string, updatedAt = 1): Conversation =>
  ({ id, title: id, messages: [{ id: `${id}-m`, role: 'user', content: 'hi', timestamp: updatedAt }], createdAt: updatedAt, updatedAt }) as unknown as Conversation

async function load() {
  const rescue = await import('../chat-rescue')
  const hint = await import('../../screens/chat/parts/adapters/chat-rescue-hint')
  const { useChatStore } = await import('../../../stores/chatStore')
  useChatStore.setState({ conversations: [] })
  return { rescue, hint, useChatStore }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  world.backup = []
  world.readFails = false
  world.written = true
  world.hydrated = true
  world.onHydrated = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the note of chats deleted on this phone', () => {
  it('sees which ids left and which came back, and nothing while an answer streams', async () => {
    const { rescue } = await load()
    const a = chat('a'), b = chat('b'), c = chat('c')
    expect(rescue.chatIdsChanged([a, b], [{ ...a }, { ...b }])).toEqual({ gone: [], back: [] })
    expect(rescue.chatIdsChanged([a, b, c], [a, c])).toEqual({ gone: ['b'], back: [] })
    expect(rescue.chatIdsChanged([a], [b, a])).toEqual({ gone: [], back: ['b'] })
  })

  it('keeps the newest ids and forgets a chat that came back', async () => {
    const { rescue } = await load()
    rescue.noteChatsLeft(['a', 'b'], [])
    rescue.noteChatsLeft([], ['a'])
    expect([...rescue.readDeletedChats()]).toEqual(['b'])
    rescue.noteChatsLeft(Array.from({ length: rescue.DELETED_CHATS_MAX + 10 }, (_, i) => `x${i}`), [])
    const kept = [...rescue.readDeletedChats()]
    expect(kept).toHaveLength(rescue.DELETED_CHATS_MAX)
    expect(kept.at(-1)).toBe(`x${rescue.DELETED_CHATS_MAX + 9}`)
    expect(kept).not.toContain('b')
  })

  it('starts after hydration: what hydration did not bring is the loss, not a deletion', async () => {
    world.hydrated = false
    const { rescue, useChatStore } = await load()
    rescue.installDeletionNote()
    // The store is still the empty start value; hydration brings one chat. Nothing is noted for that.
    useChatStore.setState({ conversations: [chat('kept')] })
    world.onHydrated.forEach((fn) => fn())
    expect([...rescue.readDeletedChats()]).toEqual([])
    // From here on a chat that leaves the list was deleted.
    useChatStore.setState({ conversations: [] })
    expect([...rescue.readDeletedChats()]).toEqual(['kept'])
    rescue.__resetDeletionNoteForTests()
  })
})

describe('restore from the automatic backup', () => {
  it('offers the chats the list lost, not the ones deleted here, and adds each once', async () => {
    const { rescue, useChatStore } = await load()
    useChatStore.setState({ conversations: [chat('new-after-loss', 9)] })
    world.backup = [chat('lost-1'), chat('lost-2'), chat('deleted'), chat('new-after-loss', 9)]
    rescue.noteChatsLeft(['deleted'], [])
    expect((await rescue.restorableChats()).map((c) => c.id)).toEqual(['lost-1', 'lost-2'])
    expect(await rescue.restoreChatsFromPhoneBackup()).toEqual(['lost-1', 'lost-2'])
    expect(useChatStore.getState().conversations.map((c) => c.id).sort()).toEqual(['lost-1', 'lost-2', 'new-after-loss'])
    // A second run adds nothing.
    expect(await rescue.restoreChatsFromPhoneBackup()).toEqual([])
  })
})

describe('the hint in the chat list', () => {
  it('shows when the backup holds more chats than the list, once per start', async () => {
    const { hint, useChatStore } = await load()
    useChatStore.setState({ conversations: [chat('one-new')] })
    world.backup = [chat('l1'), chat('l2'), chat('l3')]
    await hint.lookForRescue(async () => {})
    expect(hint.useRescueHint.getState().count).toBe(3)
    // A second look in the same start reads nothing again.
    world.backup = []
    await hint.lookForRescue(async () => {})
    expect(hint.useRescueHint.getState().count).toBe(3)
  })

  it('stays away for chats deleted on this phone ("Delete all chats" is not offered back)', async () => {
    const { rescue, hint } = await load()
    world.backup = [chat('a'), chat('b')]
    rescue.noteChatsLeft(['a', 'b'], [])
    await hint.lookForRescue(async () => {})
    expect(hint.useRescueHint.getState().count).toBe(0)
  })

  it('Restore brings them back and says so only once they are written', async () => {
    const { hint, useChatStore } = await load()
    world.backup = [chat('l1'), chat('l2')]
    await hint.lookForRescue(async () => {})
    expect(await hint.restoreFromHint()).toEqual({ outcome: 'restored', added: 2 })
    expect(useChatStore.getState().conversations).toHaveLength(2)
    expect(hint.useRescueHint.getState()).toMatchObject({ count: 0, busy: false })
  })

  it('a write the phone refused is not "restored"', async () => {
    const { hint } = await load()
    world.backup = [chat('l1')]
    world.written = false
    await hint.lookForRescue(async () => {})
    expect(await hint.restoreFromHint()).toEqual({ outcome: 'not-saved', added: 1 })
  })

  it('Not now keeps it away until the backup holds more', async () => {
    const { hint } = await load()
    world.backup = [chat('l1'), chat('l2')]
    await hint.lookForRescue(async () => {})
    hint.dismissRescueHint()
    expect(hint.useRescueHint.getState().count).toBe(0)
    // The next start, same backup: no hint.
    vi.resetModules()
    const again = (await load()).hint
    await again.lookForRescue(async () => {})
    expect(again.useRescueHint.getState().count).toBe(0)
    // One more chat in the backup: it comes back.
    vi.resetModules()
    world.backup = [chat('l1'), chat('l2'), chat('l3')]
    const more = (await load()).hint
    await more.lookForRescue(async () => {})
    expect(more.useRescueHint.getState().count).toBe(3)
  })

  it('a backup that cannot be read shows no hint and breaks nothing', async () => {
    const { hint } = await load()
    world.readFails = true
    await hint.lookForRescue(async () => {})
    expect(hint.useRescueHint.getState().count).toBe(0)
  })
})
