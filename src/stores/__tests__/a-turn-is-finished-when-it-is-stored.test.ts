import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * A finished turn is readable out of the store by the time the app says the
 * turn is finished.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * Three hooks ended a turn by announcing it and THEN starting the write:
 *
 *     setIsGenerating(false)      // Stop turns back into Send
 *     …
 *     void flushChatPersist()     // the write starts here
 *
 * Measured in a real Chromium against real IndexedDB (30 chats + 3 screenshots
 * = 6.48 MB persisted, CPU throttled 20x to stand in for a loaded machine), the
 * app reported the turn finished 323 ms, 327 ms and 522 ms before the turn
 * reached the store. A reload in that window came back without the answer in
 * six of six runs. Unthrottled on this Mac the same gap is 0.6-2 ms, which is
 * why it hid for so long.
 *
 * ── What this test pins ────────────────────────────────────────────────────
 * The CONSEQUENCE, not the shape: at the instant the completion signal is
 * published, the persisted blob already contains the finished turn. Written
 * that way on purpose — `await` on line N is a detail, "the record exists when
 * the app claims it exists" is the promise.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 * Real: the actual `useChatStore`, the actual `coalescedJSONStorage` window,
 * the actual `flushChatPersist`, the actual `endTurnDurably`. Nothing about the
 * path under test is stubbed.
 *
 * Not real: IndexedDB itself. The vitest environment is `node`, which has no
 * `indexedDB` and no jsdom, and the repo carries no fake — so the backend below
 * stands in for it as an ASYNCHRONOUS key/value store with a settable write
 * delay, which is the property the bug depends on. The engine-level behaviour
 * of IndexedDB (transaction commit, durability across a reload) is verified in
 * a real browser instead; e2e/chat-streaming-persist.spec.ts is that test.
 */

const disk = new Map<string, string>()
let writeDelayMs = 0
let writeCalls = 0
/** Set to make the next writes hang forever — a database Chromium has given
 *  up on, which is the case the deadline exists for. */
let wedged = false

vi.mock('../../lib/idbStorage', () => ({
  idbStorage: {
    getItem: () => null,
    setItem: async (k: string, v: string) => {
      writeCalls++
      if (wedged) return new Promise<void>(() => {})
      if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs))
      disk.set(k, v)
    },
    removeItem: async (k: string) => { disk.delete(k) },
  },
}))

const KEY = 'chat-conversations'
const ANSWER = 'THE-FINISHED-ANSWER-THAT-MUST-SURVIVE'

function storedContains(needle: string): boolean {
  const raw = disk.get(KEY)
  return typeof raw === 'string' && raw.includes(needle)
}

describe('a turn is finished when it is stored', () => {
  beforeEach(() => {
    disk.clear()
    writeCalls = 0
    writeDelayMs = 0
    wedged = false
  })
  afterEach(() => { vi.useRealTimers() })

  it('the persisted record carries the answer at the moment the app reports the turn finished', async () => {
    // A write that takes real time, like an IndexedDB put of a real history.
    writeDelayMs = 40

    const { useChatStore } = await import('../chatStore')
    const { endTurnDurably } = await import('../durability')

    const convId = useChatStore.getState().createConversation('m', '')
    // Let the store settle so the assertion below is about THIS turn.
    await new Promise((r) => setTimeout(r, 400))
    disk.delete(KEY)

    useChatStore.getState().addMessage(convId, {
      id: 'a1', role: 'assistant', content: ANSWER, timestamp: 1,
    })
    // The coalescing window has not elapsed: nothing is on disk yet, which is
    // the whole reason the end of a turn has to do something about it.
    expect(storedContains(ANSWER)).toBe(false)

    let storedWhenAnnounced: boolean | null = null
    await endTurnDurably(() => {
      storedWhenAnnounced = storedContains(ANSWER)
    })

    expect(storedWhenAnnounced).toBe(true)
  })

  it('a turn that changes nothing still announces itself, and costs no extra write', async () => {
    const { useChatStore } = await import('../chatStore')
    const { endTurnDurably } = await import('../durability')

    useChatStore.getState().createConversation('m', '')
    await new Promise((r) => setTimeout(r, 400))
    const before = writeCalls

    let announced = false
    await endTurnDurably(() => { announced = true })

    expect(announced).toBe(true)
    expect(writeCalls).toBe(before)
  })

  it('a store that will never write does not pin the composer: the turn ends on the deadline', async () => {
    const { useChatStore } = await import('../chatStore')
    const { endTurnDurably, TURN_FLUSH_TIMEOUT_MS } = await import('../durability')

    const convId = useChatStore.getState().createConversation('m', '')
    await new Promise((r) => setTimeout(r, 400))

    wedged = true
    useChatStore.getState().addMessage(convId, {
      id: 'a2', role: 'assistant', content: 'never lands', timestamp: 2,
    })

    vi.useFakeTimers()
    let announced = false
    const done = endTurnDurably(() => { announced = true })
    await vi.advanceTimersByTimeAsync(TURN_FLUSH_TIMEOUT_MS - 1)
    expect(announced).toBe(false) // it really does wait for the write
    await vi.advanceTimersByTimeAsync(2)
    await expect(done).resolves.toBe('timeout')
    expect(announced).toBe(true)
  })

  it('a flush that rejects still ends the turn', async () => {
    const { endTurnDurably } = await import('../durability')
    let announced = false
    const verdict = await endTurnDurably(
      () => { announced = true },
      [() => Promise.reject(new Error('idb gone'))],
    )
    expect(announced).toBe(true)
    expect(verdict).toBe('flushed') // it settled — badly, but it settled
  })

  it('a flush that throws synchronously still ends the turn', async () => {
    const { endTurnDurably } = await import('../durability')
    let announced = false
    const verdict = await endTurnDurably(
      () => { announced = true },
      [() => { throw new Error('storage went away') }],
    )
    expect(announced).toBe(true)
    expect(verdict).toBe('timeout')
  })

  it('every flush in the list is awaited, not just the first', async () => {
    const { endTurnDurably } = await import('../durability')
    const landed: string[] = []
    const slow = (name: string, ms: number) => () =>
      new Promise<void>((r) => setTimeout(() => { landed.push(name); r() }, ms))

    let atAnnounce: string[] = []
    await endTurnDurably(
      () => { atAnnounce = [...landed] },
      [slow('chat', 10), slow('staged', 30)],
    )
    expect(atAnnounce.sort()).toEqual(['chat', 'staged'])
  })
})

/**
 * The pattern guard, and the reason it is here at all.
 *
 * The four `void flushChatPersist()` call sites were not one slip repeated: the
 * three hooks each grew their own copy of the same closing block, and they had
 * already drifted — useAgentChat attached the run's artifacts to the message
 * AFTER announcing the run finished, and useCodex flushed a second store the
 * other two do not have. Two paths that are supposed to do the same thing and
 * only one gets maintained is this project's recurring shape, so the guard is
 * against the divergence coming back, not against a particular line of code.
 *
 * This one IS a source-text check. There is no render harness in this repo
 * (vitest runs in `node`, there is no @testing-library), so a hook's finally
 * block cannot be executed from a test at all; the behaviour it enforces is
 * covered above on `endTurnDurably` itself and in the browser by
 * e2e/chat-streaming-persist.spec.ts.
 */
describe('all three chat hooks end a turn the same way', () => {
  const hooks = ['useChat', 'useCodex', 'useAgentChat'] as const

  /**
   * Source with comments removed. Load-bearing, and it cost a red run to
   * learn: the comments at these very call sites QUOTE the shape that is
   * forbidden ("the statement the old `void flushChatPersist()` occupied"),
   * so a check that reads the whole file finds the explanation instead of the
   * code. The same trap is documented in components/__tests__/
   * fokusring-und-press.test.ts, which strips comments for the same reason.
   */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  for (const hook of hooks) {
    const code = strip(readFileSync(new URL(`../../hooks/${hook}.ts`, import.meta.url), 'utf8'))

    it(`${hook} routes its turn end through the shared contract`, () => {
      expect(code).toContain('endTurnDurably(')
    })

    it(`${hook} never fires the persist flush and walks away`, () => {
      expect(code).not.toMatch(/void\s+flushChatPersist\s*\(/)
      expect(code).not.toMatch(/void\s+flushStagedPersist\s*\(/)
    })

    it(`${hook} publishes "not generating any more" only from inside that contract`, () => {
      // Every `setGenerating(<something>, false)` in the hook has to sit in the
      // callback endTurnDurably runs after the write, never loose in a finally.
      const announcements = [...code.matchAll(/setGenerating\([^)]*,\s*false\s*\)/g)]
      expect(announcements.length).toBeGreaterThan(0)
      for (const m of announcements) {
        const before = code.slice(0, m.index)
        const lastContract = before.lastIndexOf('endTurnDurably(')
        expect(lastContract).toBeGreaterThan(-1)
        // …and nothing closed that callback in between.
        expect(before.slice(lastContract)).not.toContain('\n    }\n')
      }
    })
  }
})
