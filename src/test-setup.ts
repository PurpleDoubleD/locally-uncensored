// Runs before every test file (vitest.config.ts, setupFiles).
//
// The composer lays its drafts down in a module-level shelf when it unmounts
// (lib/chat-drafts.ts). Testing Library unmounts after every test, so without
// this the next test would open with the text of the last one.
//
// The page memory (stores/pageMemoryStore.ts, C22) is the same kind of
// shelf for Models and Settings: it outlives an unmount on purpose, so every
// test starts with the state of a fresh session.
import { beforeEach } from 'vitest'
import { clearChatDrafts } from './lib/chat-drafts'
import { resetPageMemory } from './stores/pageMemoryStore'

beforeEach(() => {
  clearChatDrafts()
  resetPageMemory()
})
