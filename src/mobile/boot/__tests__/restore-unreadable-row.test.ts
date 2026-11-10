// @vitest-environment jsdom
/**
 * C46 (3.1.0): the gap of the desktop before 3.0.10, on the phone.
 *
 * perrt, 05.11.2026: the chat row in IndexedDB came back as something
 * hydration cannot read (no string, or a leftover "[object Object]" in
 * localStorage). `hasStoredItem` counts such a row as there, so the quiet
 * repair at the start believed the chats were present and put nothing back,
 * while the chat store hydrated empty. The next backup then wrote the empty
 * list over the only good copy.
 *
 * The quiet repair asks `hasReadableItem` now: present means a value
 * hydration can read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const idb = vi.hoisted(() => ({ writes: [] as string[] }))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd === 'restore_stores') {
      const chats = JSON.stringify({ state: { conversations: [{ id: 'from-backup', messages: [] }] } })
      return JSON.stringify({ 'chat-conversations': chats })
    }
    return null
  },
}))
vi.mock('../../../lib/idbStorage', () => ({
  // The row of the chat store is there for count(), but it is no string: getItem hands hydration null.
  hasStoredItem: async (key: string) => key === 'chat-conversations',
  hasReadableItem: async () => false,
  hasFailedRead: () => false,
  onIdbWrite: () => () => {},
  idbStorage: {
    getItem: async () => null,
    setItem: async (key: string) => {
      idb.writes.push(key)
    },
    removeItem: async () => {},
  },
}))
vi.mock('../../../lib/chat-backup-recovery', () => ({ recoverChatsFromBackup: async () => {} }))
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: { persist: { hasHydrated: () => true, onFinishHydration: () => {} }, getState: () => ({ conversations: [], importConversations: () => {} }) },
}))
vi.mock('../../../lib/ragDB', () => ({ exportAllChunks: async () => ({}), importAllChunks: async () => {} }))

beforeEach(() => {
  vi.resetModules()
  idb.writes = []
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('chat-settings', '{"state":{}}')
  Object.defineProperty(window, 'location', { value: { ...window.location, reload: vi.fn() }, configurable: true })
})

describe('the quiet repair at the start, with a chat row hydration cannot read', () => {
  it('puts the chats of the backup back instead of taking the row for chats', async () => {
    const { runStoreRestore, restoreDecided } = await import('../restore')
    await runStoreRestore()
    await restoreDecided
    expect(idb.writes).toContain('chat-conversations')
  })
})
