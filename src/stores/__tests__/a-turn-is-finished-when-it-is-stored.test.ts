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

const HOOKS = ['useChat', 'useCodex', 'useAgentChat'] as const
type Hook = (typeof HOOKS)[number]

/**
 * A hook's source with comments removed. Load-bearing, and it cost a red run
 * to learn: the comments at these very call sites QUOTE the shape that is
 * forbidden ("the statement the old `void flushChatPersist()` occupied"), so a
 * check that reads the whole file finds the explanation instead of the code.
 * The same trap is documented in components/__tests__/fokusring-und-press.test.ts,
 * which strips comments for the same reason.
 */
function hookCode(hook: Hook): string {
  const raw = readFileSync(new URL(`../../hooks/${hook}.ts`, import.meta.url), 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

interface TurnEndBlock {
  /** "useChat/sendMessage" — the hook and the useCallback it lives in. */
  name: string
  /** The `finally { … }` body, comments already gone. */
  block: string
  /** Offset of `endTurnDurably(` inside `block`. */
  flushAt: number
}

/**
 * Every `finally` block that ends a turn, found by walking out from the
 * `endTurnDurably(` call to the enclosing `finally {` and matching its braces.
 * Brace counting is honest here because the blocks contain no string literal
 * with an unbalanced brace — the template literals in the loop drivers all
 * close their own `${…}`. If that ever stops being true this throws rather
 * than quietly measuring the wrong region, which is the failure mode a guard
 * is allowed to have.
 */
function turnEndBlocks(hook: Hook): TurnEndBlock[] {
  const code = hookCode(hook)
  const out: TurnEndBlock[] = []
  for (const call of code.matchAll(/endTurnDurably\(/g)) {
    const finallyAt = code.lastIndexOf('finally', call.index)
    if (finallyAt < 0) throw new Error(`${hook}: endTurnDurably outside any finally block`)
    const open = code.indexOf('{', finallyAt)
    let depth = 0
    let close = -1
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}' && --depth === 0) { close = i; break }
    }
    if (close < 0) throw new Error(`${hook}: unbalanced finally block`)
    let owner: string = hook
    for (const cb of code.slice(0, finallyAt).matchAll(/const\s+(\w+)\s*=\s*useCallback/g)) {
      owner = `${hook}/${cb[1]}`
    }
    out.push({ name: owner, block: code.slice(open, close + 1), flushAt: call.index - open })
  }
  return out
}

const TURN_ENDS = HOOKS.flatMap(turnEndBlocks)

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

  for (const hook of hooks) {
    const code = hookCode(hook)

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

/**
 * WHERE the call sits, not only THAT it is awaited.
 *
 * The awaited version of this contract has one silent way to lose: move
 * `endTurnDurably` further down its block. It still awaits, every existing
 * test still passes, and the write simply starts later. That is not a
 * hypothetical — it is the regress this fix already made once and measured:
 * with the call below the TTS and memory blocks the write began about 5 ms
 * after the paint and e2e/chat-streaming-persist.spec.ts went from never
 * losing a turn to three runs in ten. `flushes.map(f => f())` runs
 * SYNCHRONOUSLY, and that is where serialise-and-put happens, so every
 * statement above the call is time the write is not yet running.
 *
 * Two rules, because there are two ways to be late:
 *
 *   1. The write must start before the block starts anything ELSE. Enforced
 *      against a named list of jobs, not against "any call" — the cheap state
 *      resets a turn end does (clearing an aborter, nulling a ref, dropping a
 *      loading flag) may sit above the call in any order, and reordering them
 *      must stay green. Only work that TAKES time or SETS SOMETHING GOING
 *      counts.
 *   2. Nothing may be awaited before it. An `await` above the call hands the
 *      event loop the turn while the answer is still only in memory, which is
 *      strictly worse than any of the jobs in rule 1. This one needs no list.
 *
 * Rule 1 has an honest limit, stated here rather than discovered later: it
 * catches the call moving DOWN past work that already exists, not a NEW kind
 * of slow call being inserted above it. The list below is what makes it
 * concrete, so a third test keeps the list from rotting into a no-op.
 *
 * Known and deliberate: the /loop drivers in useCodex and useAgentChat call
 * `addMessage` AFTER the flush, so a loop-halt line rides the next coalescing
 * window instead of this turn's write. That predates this contract and is not
 * what these rules are about; it would need a second flush per turn, only in
 * the loop case.
 */
describe('the turn end starts the write before it starts anything else', () => {
  /**
   * Jobs a turn end sets going once the turn is over. Each one either takes
   * real time or hands control to something that does — none of them may be
   * the reason the write has not started yet.
   */
  const STARTS_WORK: ReadonlyArray<{ call: string; why: string }> = [
    { call: 'autoSpeak(', why: 'speaks the finished answer — synthesis, and it is allowed to be slow' },
    { call: 'extractAndSave(', why: 'runs the memory extractor, which is a model call' },
    { call: 'extractMemoriesFromPair(', why: 'runs the same memory extractor on the agent surfaces' },
    { call: 'drainApprovals(', why: 'resolves pending approval promises, which resumes whatever was awaiting them' },
    { call: 'bumpFileTreeVersion(', why: 'makes the Explorer re-read the working tree' },
    { call: 'setTimeout(', why: 'is the /loop driver arming the next pass' },
    { call: 'useAgentLoopStore.getState().start(', why: 'registers the next loop pass in the UI' },
  ]

  // `endAgentRun` is deliberately NOT on the list: it assigns two fields and
  // returns (api/agent-context.ts). useCodex closes the run before the flush
  // and useAgentChat after it, and neither costs the write anything — pinning
  // that difference would be pinning noise.

  it('all four turn ends were found and parsed', () => {
    // `useCodex/runInstruction` und nicht mehr `sendInstruction`: 2.6.8 hat den
    // grossen useCallback in `runInstruction` umbenannt und `sendInstruction`
    // zur duennen Huelle mit beginSend/endSend gemacht. Das Rundenende sitzt
    // seither in `runInstruction`. Die Liste steht hier woertlich, damit ein
    // solcher Umbau auffaellt, statt den Vertrag still auf drei Bloecke zu
    // verkuerzen.
    expect(TURN_ENDS.map((b) => b.name)).toEqual([
      'useChat/runGroupRound',
      'useChat/sendMessage',
      'useCodex/runInstruction',
      'useAgentChat/sendAgentMessage',
    ])
  })

  for (const { name, block, flushAt } of TURN_ENDS) {
    it(`${name}: the write starts before every job this block sets going`, () => {
      for (const { call, why } of STARTS_WORK) {
        for (const found of block.matchAll(new RegExp(call.replace(/[.()[\]$^*+?\\|{}]/g, '\\$&'), 'g'))) {
          expect(
            found.index,
            `${name}: \`${call}\` runs BEFORE endTurnDurably. It ${why}, so the ` +
            'turn would be waiting on it before its own write even starts. Move ' +
            'the endTurnDurably call back above it — see stores/durability.ts.',
          ).toBeGreaterThan(flushAt)
        }
      }
    })

    it(`${name}: nothing is awaited before the write`, () => {
      const firstAwait = block.search(/\bawait\s/)
      expect(firstAwait, `${name}: the finally block awaits nothing at all`).toBeGreaterThan(-1)
      expect(
        firstAwait,
        `${name}: something is awaited before endTurnDurably. Every await above ` +
        'it is the event loop getting the turn while the answer is still only in ' +
        'memory. The write goes first.',
      ).toBe(flushAt - 'await '.length)
    })
  }

  it('the list of jobs that must wait still describes this codebase', () => {
    // A list entry naming something that no longer exists guards nothing, and
    // it would rot in silence. If a job below really is gone, delete its line.
    const all = HOOKS.map(hookCode).join('\n')
    for (const { call } of STARTS_WORK) {
      expect(
        all.includes(call),
        `\`${call}\` is on the must-wait list but appears in none of the three ` +
        'hooks any more. Drop the entry, or the list is protecting nothing.',
      ).toBe(true)
    }
  })
})
