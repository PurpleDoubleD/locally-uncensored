/**
 * A loop must not outlive a refusal that no retry can fix.
 *
 * Found reviewing the A3 and A4 fixes (2026-08-14). Those two made an empty
 * wallet terminal: the catch writes CREDITS_EXHAUSTED_MESSAGE and returns. But
 * `return` does not skip `finally`, and the /loop driver lives in the finally.
 * It gates on three things, none of them the wallet, so with the default
 * interval of 5 s the next pass fires, the proxy refuses it again, and
 * CreditsExhaustedModal reopens on every pass. The user dismisses a dialog that
 * comes straight back, forever, until they find Stop. Both surfaces carry the
 * same driver and both had the same gap.
 *
 * Source-level, like the other driver tests: the pass is scheduled deep inside
 * a hook that needs the whole app around it, and what has to hold is a property
 * of the control flow, not of a rendered component.
 *
 * Run: npx vitest run src/hooks/__tests__/loop-stops-on-terminal.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const codex = readFileSync(resolve(here, '../useCodex.ts'), 'utf8')
const agent = readFileSync(resolve(here, '../useAgentChat.ts'), 'utf8')

describe.each([
  ['the coding surface', codex, 'loopState && convId && loopHalt', 'codexLoopTimer = setTimeout('],
  ['the agent surface', agent, 'opts?.loop && convId && loopHalt', 'agentLoopTimer = setTimeout('],
])('%s', (_name, src, guard, scheduler) => {
  it('declares the halt per run, so one refusal cannot poison the next loop', () => {
    expect(src).toContain('let loopHalt: string | null = null')
  })

  it('sets it where the wallet is refused', () => {
    const at = src.indexOf("loopHalt = 'out of credits'")
    expect(at).toBeGreaterThan(-1)
    const credits = src.indexOf("code === 'credits_exhausted'")
    expect(credits).toBeGreaterThan(-1)
    // Set inside the credits branch, not somewhere that happens to run anyway.
    expect(at - credits).toBeGreaterThan(0)
    expect(at - credits).toBeLessThan(400)
  })

  it('the driver checks it BEFORE the branch that schedules the next pass', () => {
    const halt = src.indexOf(guard)
    const schedule = src.indexOf(scheduler)
    expect(halt).toBeGreaterThan(-1)
    expect(schedule).toBeGreaterThan(-1)
    expect(halt).toBeLessThan(schedule)
  })

  it('it clears the loop store, or the bar keeps promising a pass nobody runs', () => {
    const block = src.slice(src.indexOf(guard), src.indexOf(guard) + 700)
    expect(block).toContain('useAgentLoopStore.getState().clear()')
  })

  it('and says once why it stopped', () => {
    expect(src).toContain('The loop stopped because the run was ${loopHalt}')
  })
})

describe('the ordinary loop is untouched', () => {
  it('a normal pass still reaches the scheduler through the else branch', () => {
    // Guarded by the module-scoped, per-conversation stop (audit M1) rather
    // than by a ref of whichever hook instance happens to be mounted.
    expect(codex).toContain('} else if (loopState && convId && !isRunStopped(convId)) {')
    expect(agent).toContain('} else if (opts?.loop && convId && !isRunStopped(convId)) {')
  })

  it('LOOP_DONE and the pass cap are still the other two ways out', () => {
    expect(codex).toContain('loopPassSaysDone(fullContent.trim())')
    expect(codex).toContain('cap > 0 && nextPass > cap')
  })
})
