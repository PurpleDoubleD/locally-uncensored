/**
 * Audit M1 — Stop must end a /loop that a DIFFERENT hook instance started.
 *
 * The bug, exactly: the Code view and the chat view unmount on a tab switch. The
 * /loop driver lives in the `finally` of the pass, inside the closure of the
 * instance that started it. Stop set `userStoppedRef.current = true` on the
 * REMOUNTED instance — a different ref object — so the old closure read `false`,
 * scheduled the next pass, and the loop came back. The loop has no pass ceiling
 * by design ("there is NO built-in ceiling … the stop button is the brake"), so
 * that left an unattended agent with full shell and write access running with no
 * way for the user to turn it off.
 *
 * The Agent surface had the mirror-image bug: stopAgent set the flag and NOTHING
 * ever cleared it, so after one Stop anywhere in the session every later /loop
 * ran a single pass and quit, silently.
 *
 * Run: npx vitest run src/lib/__tests__/run-stop.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beginRun, stopRun, isRunStopped, __resetRunStopsForTests } from '../run-stop'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

/**
 * One hook instance, reduced to the two things that matter: it captures the
 * stop-reader at creation time (a closure, like the real `finally` does) and
 * offers the Stop button the mounted view offers.
 */
function mountHook(conversationId: string) {
  return {
    /** What the /loop driver in THIS instance's finally would decide. */
    wouldScheduleNextPass: () => !isRunStopped(conversationId),
    pressStop: () => stopRun(conversationId),
    startFreshInstruction: () => beginRun(conversationId),
  }
}

describe('run-stop — the stop outlives the hook instance', () => {
  beforeEach(() => { __resetRunStopsForTests() })

  it('a Stop pressed by a REMOUNTED instance ends the loop the old one is driving', () => {
    const conv = 'conv-a'
    const first = mountHook(conv)          // started the /loop, then the tab switched
    first.startFreshInstruction()
    expect(first.wouldScheduleNextPass()).toBe(true)

    const remounted = mountHook(conv)      // the view came back as a new instance
    remounted.pressStop()

    // The decision that used to go wrong: the OLD closure's finally.
    expect(first.wouldScheduleNextPass()).toBe(false)
  })

  it('the next real instruction clears it, so a later /loop is not stuck at one pass', () => {
    const conv = 'conv-b'
    const hook = mountHook(conv)
    hook.pressStop()
    expect(hook.wouldScheduleNextPass()).toBe(false)

    hook.startFreshInstruction()           // the user types something new
    expect(hook.wouldScheduleNextPass()).toBe(true)
  })

  it('a /loop PASS does not clear it — Stop ends the loop, not just the pass', () => {
    const conv = 'conv-c'
    beginRun(conv)
    stopRun(conv)
    // A pass calls beginRun only when `!opts?.loop`; a pass therefore calls
    // nothing here and inherits the stop.
    expect(isRunStopped(conv)).toBe(true)
  })

  it('is per conversation: stopping one chat does not stop another', () => {
    beginRun('left')
    beginRun('right')
    stopRun('left')
    expect(isRunStopped('left')).toBe(true)
    expect(isRunStopped('right')).toBe(false)
  })

  it('a missing conversation id is never "stopped" and never throws', () => {
    expect(isRunStopped(null)).toBe(false)
    expect(isRunStopped(undefined)).toBe(false)
    expect(() => stopRun(null)).not.toThrow()
    expect(() => beginRun(undefined)).not.toThrow()
  })
})

describe('run-stop — both loop surfaces are wired to it', () => {
  const codex = read('../../hooks/useCodex.ts')
  const agent = read('../../hooks/useAgentChat.ts')

  it('neither hook keeps a per-instance stop ref any more', () => {
    expect(codex).not.toContain('userStoppedRef')
    expect(agent).not.toContain('userStoppedRef')
  })

  it('both stop buttons record the stop against the conversation', () => {
    for (const src of [codex, agent]) {
      expect(src).toContain('stopRun(stoppedConvId)')
    }
  })

  it('both clear it on a fresh instruction but not on a /loop pass', () => {
    for (const src of [codex, agent]) {
      expect(src).toContain('if (!opts?.loop) beginRun(convId)')
    }
  })

  it('Codex also refuses to auto-apply staged changes after a Stop', () => {
    // The auto-apply sits on the loop's NORMAL exit path (the for-loop condition
    // includes !abort.signal.aborted, so a Stop leaves through it), which meant a
    // run the user aborted mid-edit still wrote its half-finished changes to disk.
    expect(codex).toContain(
      "settings.codexStageMode && settings.codexAutoApply && convId && !isRunStopped(convId)",
    )
  })
})
