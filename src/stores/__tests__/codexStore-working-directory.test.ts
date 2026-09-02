/**
 * A8 (2.6.8): giving the working directory back.
 *
 * Two users on Windows 11 in Cloud mode reported the same thing within a day of
 * each other: a folder opened by mistake could not be closed again. One of them
 * had attached the agent to a huge tree and was ready to reinstall the app over
 * it, the other sat in front of "I'm sorry, but I'm unable to proceed without a
 * working directory". A moderator confirmed the state of things with three
 * words: "There isn't one."
 *
 * There were two halves to it, and this file pins both:
 *
 *   1. the store had no way to clear `workingDirectory`, and the value is
 *      persisted, so a restart brought the folder straight back,
 *   2. `initThread` copies the folder into the thread ONCE and the run resolver
 *      prefers the thread over the store, so even a cleared store left the
 *      running conversation attached to the old tree. The same drift made a
 *      mis-click permanent: picking a second folder did not move the agent.
 *
 * The first cut fixed the second half by rewriting EVERY thread on every set,
 * which quietly overwrote a deliberate per-chat workspace in another chat
 * (review S5). The store is the single truth now, and a conversation's thread
 * is pulled onto it one at a time, at that conversation's next send.
 *
 * Windows paths are checked verbatim on purpose. Both reporters are on Windows,
 * and this store must never touch a backslash or a drive letter.
 *
 * Run: npx vitest run src/stores/__tests__/codexStore-working-directory.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'

// zustand/persist reads window.localStorage; the vitest env is 'node'. Assigned
// before the store import below, which is why that import is not hoisted.
const backing = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = globalThis
globalThis.localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() { return backing.size },
} as Storage

const { useCodexStore } = await import('../codexStore')

const KEY = 'locally-uncensored-codex'
const persisted = () => JSON.parse(localStorage.getItem(KEY) ?? '{}')

/** What the reporters actually typed at: a drive letter, backslashes, a space. */
const WINDOWS_PATH = 'C:\\Users\\helpslowlydying\\Documents\\My Projects'

beforeEach(() => {
  localStorage.clear()
  useCodexStore.setState({ workingDirectory: '', threads: {}, sendsInFlight: 0 })
})

describe('the folder can be given back', () => {
  it('clears the store', () => {
    useCodexStore.getState().setWorkingDirectory('/home/dave/repo')
    // Negative control: without this the next assertion passes on a store that
    // never held a folder in the first place.
    expect(useCodexStore.getState().workingDirectory).toBe('/home/dave/repo')

    useCodexStore.getState().clearWorkingDirectory()
    expect(useCodexStore.getState().workingDirectory).toBe('')
  })

  it('writes the empty string to disk, so a restart does not resurrect the folder', () => {
    useCodexStore.getState().setWorkingDirectory('/home/dave/repo')
    expect(persisted().state.workingDirectory).toBe('/home/dave/repo')

    useCodexStore.getState().clearWorkingDirectory()
    expect(persisted().state.workingDirectory).toBe('')
    // The key must still BE there. Deleting it would let an older persisted
    // value win on the next rehydrate, which is the bug all over again.
    expect(Object.keys(persisted().state)).toContain('workingDirectory')
  })

  it('unpins the open thread at its next send, which is where the folder reaches the run', () => {
    useCodexStore.getState().setWorkingDirectory('/home/dave/repo')
    useCodexStore.getState().initThread('conv-1', '/home/dave/repo')
    // Negative control: the thread really did carry the folder before.
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('/home/dave/repo')

    useCodexStore.getState().clearWorkingDirectory()
    useCodexStore.getState().syncThreadWorkingDirectory('conv-1')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
  })

  it('touches ONLY the conversation being sent, a per-chat workspace elsewhere survives', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    useCodexStore.getState().initThread('conv-1', '/repo')
    // conv-2 sits on a folder of its own, the way a per-chat agent workspace
    // reaches the thread. The first cut of this fix wiped it (review S5).
    useCodexStore.getState().initThread('conv-2', '/other/deliberate/workspace')

    useCodexStore.getState().clearWorkingDirectory()
    useCodexStore.getState().syncThreadWorkingDirectory('conv-1')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
    expect(useCodexStore.getState().getThread('conv-2')!.workingDirectory).toBe('/other/deliberate/workspace')
  })

  it('a clear on its own moves no thread at all, the send is what pulls them', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    useCodexStore.getState().initThread('conv-1', '/repo')
    useCodexStore.getState().clearWorkingDirectory()
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('/repo')
  })

  it('leaves the rest of the thread alone: events, status and id survive', () => {
    const id = useCodexStore.getState().initThread('conv-1', '/repo')
    useCodexStore.getState().addEvent('conv-1', {
      id: 'e1', type: 'instruction', content: 'do the thing', timestamp: 1,
    })
    useCodexStore.getState().setThreadStatus('conv-1', 'error')

    useCodexStore.getState().clearWorkingDirectory()
    useCodexStore.getState().syncThreadWorkingDirectory('conv-1')
    const thread = useCodexStore.getState().getThread('conv-1')!
    expect(thread.id).toBe(id)
    expect(thread.events).toHaveLength(1)
    expect(thread.status).toBe('error')
  })
})

describe('a mis-click is not permanent either', () => {
  it('picking a second folder moves the open thread at the next send', () => {
    useCodexStore.getState().setWorkingDirectory('/wrong/huge/tree')
    useCodexStore.getState().initThread('conv-1', '/wrong/huge/tree')

    useCodexStore.getState().setWorkingDirectory('/right/repo')
    expect(useCodexStore.getState().syncThreadWorkingDirectory('conv-1')).toBe('/right/repo')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('/right/repo')
  })

  it('the sync reads the store LIVE, so a Remove during the send still wins', () => {
    // B1: the send takes its store snapshot, then awaits the workspace slug
    // over IPC. A Remove pressed in that gap used to be undone by the stale
    // snapshot. This action has no snapshot to go stale.
    useCodexStore.getState().setWorkingDirectory('/wrong/huge/tree')
    useCodexStore.getState().initThread('conv-1', '/wrong/huge/tree')
    const staleSnapshot = useCodexStore.getState()

    useCodexStore.getState().clearWorkingDirectory()
    expect(staleSnapshot.workingDirectory).toBe('/wrong/huge/tree')
    expect(staleSnapshot.syncThreadWorkingDirectory('conv-1')).toBe('')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
  })

  it('a sync that changes nothing keeps the same threads object, so nobody re-renders', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    useCodexStore.getState().initThread('conv-1', '/repo')
    const before = useCodexStore.getState().threads

    useCodexStore.getState().syncThreadWorkingDirectory('conv-1')
    expect(useCodexStore.getState().threads).toBe(before)
  })

  it('a sync for a conversation with no thread yet is a no-op, not a crash', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    expect(useCodexStore.getState().syncThreadWorkingDirectory('never-sent')).toBe('/repo')
    expect(useCodexStore.getState().getThread('never-sent')).toBeUndefined()
  })
})

describe('the send counter that holds the folder from the first synchronous moment', () => {
  it('counts up and back down', () => {
    useCodexStore.getState().beginSend()
    expect(useCodexStore.getState().sendsInFlight).toBe(1)
    useCodexStore.getState().endSend()
    expect(useCodexStore.getState().sendsInFlight).toBe(0)
  })

  it('carries two overlapping sends without losing one', () => {
    useCodexStore.getState().beginSend()
    useCodexStore.getState().beginSend()
    useCodexStore.getState().endSend()
    // Negative control: one release must not free a send that is still going.
    expect(useCodexStore.getState().sendsInFlight).toBe(1)
    useCodexStore.getState().endSend()
    expect(useCodexStore.getState().sendsInFlight).toBe(0)
  })

  it('never goes negative, a stray release cannot unlock a running send', () => {
    useCodexStore.getState().endSend()
    expect(useCodexStore.getState().sendsInFlight).toBe(0)
  })

  it('stays off the disk, a crash must not leave a ghost send holding the folder', () => {
    useCodexStore.getState().beginSend()
    expect(persisted().state?.sendsInFlight).toBeUndefined()
  })
})

describe('Windows paths are carried through byte for byte', () => {
  it('stores the drive letter and the backslashes unchanged', () => {
    useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
    const stored = useCodexStore.getState().workingDirectory
    expect(stored).toBe(WINDOWS_PATH)
    // Negative control against a well-meaning normalizer: no forward slashes,
    // no trailing-separator trim, no lowercasing of the drive letter.
    expect(stored).not.toContain('/')
    expect(stored.startsWith('C:\\')).toBe(true)
  })

  it('survives the round trip through localStorage unchanged', () => {
    useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
    expect(persisted().state.workingDirectory).toBe(WINDOWS_PATH)
  })

  it('pins and unpins a Windows path on the thread', () => {
    useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
    useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe(WINDOWS_PATH)

    useCodexStore.getState().clearWorkingDirectory()
    useCodexStore.getState().syncThreadWorkingDirectory('conv-1')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
  })

  it('setThreadWorkingDirectory keeps the backslashes on the thread too', () => {
    useCodexStore.getState().initThread('conv-1', '')
    useCodexStore.getState().setThreadWorkingDirectory('conv-1', WINDOWS_PATH)
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe(WINDOWS_PATH)
  })
})

describe('R1 DOWNGRADE-KONTRAKT still holds', () => {
  it('removing the folder adds no new persisted key and no version bump', () => {
    useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
    useCodexStore.getState().clearWorkingDirectory()
    useCodexStore.getState().beginSend()

    const raw = persisted()
    expect(Object.keys(raw.state).sort()).toEqual(['modeByConversation', 'workingDirectory'])
    expect(raw.version ?? 0).toBe(0)
    // Negative control: the threads that were just unpinned stay off the disk.
    expect(raw.state.threads).toBeUndefined()
  })
})
