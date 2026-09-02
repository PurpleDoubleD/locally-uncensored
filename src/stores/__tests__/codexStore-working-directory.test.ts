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
  useCodexStore.setState({ workingDirectory: '', threads: {} })
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

  it('unpins the open thread, which is where the folder actually reaches the run', () => {
    useCodexStore.getState().setWorkingDirectory('/home/dave/repo')
    useCodexStore.getState().initThread('conv-1', '/home/dave/repo')
    // Negative control: the thread really did carry the folder before.
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('/home/dave/repo')

    useCodexStore.getState().clearWorkingDirectory()
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
  })

  it('unpins every open thread, not just the one in front', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    useCodexStore.getState().initThread('conv-1', '/repo')
    useCodexStore.getState().initThread('conv-2', '/repo')

    useCodexStore.getState().clearWorkingDirectory()
    const threads = useCodexStore.getState().threads
    expect(Object.values(threads).map((t) => t.workingDirectory)).toEqual(['', ''])
  })

  it('leaves the rest of the thread alone: events, status and id survive', () => {
    const id = useCodexStore.getState().initThread('conv-1', '/repo')
    useCodexStore.getState().addEvent('conv-1', {
      id: 'e1', type: 'instruction', content: 'do the thing', timestamp: 1,
    })
    useCodexStore.getState().setThreadStatus('conv-1', 'error')

    useCodexStore.getState().clearWorkingDirectory()
    const thread = useCodexStore.getState().getThread('conv-1')!
    expect(thread.id).toBe(id)
    expect(thread.events).toHaveLength(1)
    expect(thread.status).toBe('error')
  })
})

describe('a mis-click is not permanent either', () => {
  it('picking a second folder moves the open thread with it', () => {
    useCodexStore.getState().setWorkingDirectory('/wrong/huge/tree')
    useCodexStore.getState().initThread('conv-1', '/wrong/huge/tree')

    useCodexStore.getState().setWorkingDirectory('/right/repo')
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('/right/repo')
  })

  it('a set that changes nothing keeps the same threads object, so nobody re-renders', () => {
    useCodexStore.getState().setWorkingDirectory('/repo')
    useCodexStore.getState().initThread('conv-1', '/repo')
    const before = useCodexStore.getState().threads

    useCodexStore.getState().setWorkingDirectory('/repo')
    expect(useCodexStore.getState().threads).toBe(before)
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
    expect(useCodexStore.getState().getThread('conv-1')!.workingDirectory).toBe('')
  })
})

describe('R1 DOWNGRADE-KONTRAKT still holds', () => {
  it('removing the folder adds no new persisted key and no version bump', () => {
    useCodexStore.getState().setWorkingDirectory(WINDOWS_PATH)
    useCodexStore.getState().chooseCodexMode('x', 'plan', false)
    useCodexStore.getState().initThread('conv-1', WINDOWS_PATH)
    useCodexStore.getState().clearWorkingDirectory()

    const raw = persisted()
    expect(Object.keys(raw.state).sort()).toEqual(['modeByConversation', 'workingDirectory'])
    expect(raw.version ?? 0).toBe(0)
    // Negative control: the threads that were just unpinned stay off the disk.
    expect(raw.state.threads).toBeUndefined()
  })
})
