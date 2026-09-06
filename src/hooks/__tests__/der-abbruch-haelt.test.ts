/**
 * Stop during a character training has to stick.
 *
 * Measured on the Windows box on 06.09.2026 (t9): a Cancel 0.6 s or 14 s
 * after Create, while the card was still being freed or the environment
 * probed, reset the UI to idle and brought the chat model back, while the
 * trainer went on to step 27 of 400 beside it. The Rust start resets the
 * cancel flag, so a cancel that arrives before the start is lost, and one
 * that lands in the probe has no child to kill.
 *
 * Now the run remembers the request: a cancel before the start skips the
 * start, and after the start the poll loop re-sends the cancel until the
 * backend reports the run gone, and only then gives the card back.
 *
 * Run: npx vitest run src/hooks/__tests__/der-abbruch-haelt.test.ts
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(__dirname, '..', 'useCreate.ts'), 'utf8')
const training = src.slice(src.indexOf('const runCharacterTraining = useCallback('), src.indexOf('const generateInner = useCallback('))
const cancel = src.slice(src.indexOf('const cancel = useCallback('), src.indexOf('return {', src.indexOf('const cancel = useCallback(')))

describe('a Stop during the training holds', () => {
  it('a cancel that came during the hand-off skips the start', () => {
    const evict = training.indexOf('await evictChatBackendsForRender()')
    const check = training.indexOf('if (trainingCancelRequested.current) return')
    const begin = training.indexOf('await startCharacterTraining(')
    expect(evict).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(evict)
    expect(begin).toBeGreaterThan(check)
  })

  it('after the start, a run the backend still reports gets the cancel again', () => {
    const loop = training.slice(training.indexOf('for (;;) {'))
    const running = loop.indexOf("if (s.status === 'running') {")
    const resend = loop.indexOf('await cancelCharacterTraining()')
    expect(running).toBeGreaterThan(0)
    expect(resend).toBeGreaterThan(running)
    // bounded: it does not wait on a backend that never answers
    expect(loop).toContain('if (++cancelRounds >= 20) return')
  })

  it('the loop keeps polling after Stop reset the UI, until the backend confirms', () => {
    const loop = training.slice(training.indexOf('for (;;) {'))
    expect(loop).toContain('if (!useCreateStore.getState().isGenerating && !trainingCancelRequested.current) return')
    expect(loop).not.toContain('if (!useCreateStore.getState().isGenerating) return')
  })

  it('Stop marks the request before it asks the backend', () => {
    const mark = cancel.indexOf('trainingCancelRequested.current = true')
    const ask = cancel.indexOf('await cancelCharacterTraining()')
    expect(mark).toBeGreaterThan(0)
    expect(ask).toBeGreaterThan(mark)
  })

  it('the card comes back in the finally, after the loop, never inside Stop', () => {
    expect(training.indexOf('void restoreChatBackendsAfterRender(trainingEviction)')).toBeGreaterThan(training.indexOf('} finally {'))
    expect(cancel).not.toContain('restoreChatBackendsAfterRender')
  })
})
