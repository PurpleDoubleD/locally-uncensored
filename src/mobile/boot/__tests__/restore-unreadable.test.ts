// @vitest-environment jsdom
/**
 * A store that cannot be read at the start is not an empty store: the backup
 * is never "restored" over it.
 *
 * Finding F11 of check 4 on Android. With a full phone IndexedDB could not be
 * opened, every store looked empty to the quiet repair, and it wrote the
 * backup back and reloaded. The write was refused further down
 * (lib/idbStorage.ts), so nothing was lost, but the app treated chats that
 * were all there as gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const idb = vi.hoisted(() => ({
  unreadable: true,
  writes: [] as string[],
}))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd === 'restore_stores') {
      const chats = JSON.stringify({ state: { conversations: [{ id: 'from-backup', messages: [] }] } })
      return JSON.stringify({ 'chat-conversations': chats, 'locally-uncensored-memory': JSON.stringify({ state: { memories: [] } }) })
    }
    return null
  },
}))
vi.mock('../../../lib/idbStorage', () => ({
  // null: IndexedDB could not be asked.
  hasStoredItem: async () => (idb.unreadable ? null : false),
  hasReadableItem: async () => (idb.unreadable ? null : false),
  hasFailedRead: () => idb.unreadable,
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
  // The settings are there, so this is the quiet repair and not the first start after a lost storage.
  localStorage.setItem('chat-settings', '{"state":{}}')
})

describe('the quiet repair at the start', () => {
  it('leaves every store alone that could not be read', async () => {
    idb.unreadable = true
    const { runStoreRestore, restoreDecided } = await import('../restore')
    expect((await runStoreRestore()).kind).toBe('ready')
    await restoreDecided
    expect(idb.writes).toEqual([])
  })

  it('still brings back a store that is really empty', async () => {
    idb.unreadable = false
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true })
    const { runStoreRestore, restoreDecided } = await import('../restore')
    await runStoreRestore()
    await restoreDecided
    expect(idb.writes).toContain('chat-conversations')
  })
})
