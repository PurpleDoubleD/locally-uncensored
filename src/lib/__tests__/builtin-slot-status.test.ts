/**
 * GH #118 leftover, from the counter-check on the real 2.6.7 Windows build
 * (2026-08-29): Settings, AI Backends showed the Built-in Engine as "Failed"
 * straight after app start with no chat model loaded. The Test click then put
 * `GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED` in the
 * console and flipped the very same row to "Connected". The engine was fine.
 *
 * These pin the rule the row follows now: a verdict of failure only ever comes
 * from a probe that actually ran, and an engine the app has not started yet is
 * reported as not running.
 *
 * Run: npx vitest run src/lib/__tests__/builtin-slot-status.test.ts
 */
import { describe, it, expect } from 'vitest'
import { builtinSlotStatus } from '../builtin-slot-status'

describe('builtinSlotStatus: what the row may claim without a socket', () => {
  it('THE FIX: an engine that was never started reads "not running", not "failed"', () => {
    expect(builtinSlotStatus({ running: false, healthy: false })).toBe('stopped')
  })

  it('a healthy engine is connected, with no request to a port at all', () => {
    expect(builtinSlotStatus({ running: true, healthy: true })).toBe('connected')
  })

  it('up but not answering yet is the one case worth a real probe', () => {
    // The child is alive and the port may still be binding. Guessing either
    // way here is how the wrong verdict got made in the first place.
    expect(builtinSlotStatus({ running: true, healthy: false })).toBeNull()
  })

  it('no answer from the backend decides nothing', () => {
    expect(builtinSlotStatus(null)).toBeNull()
    expect(builtinSlotStatus(undefined)).toBeNull()
  })

  it('never returns "failed" on its own, whatever it is handed', () => {
    const cases = [
      { running: false, healthy: false },
      { running: true, healthy: false },
      { running: true, healthy: true },
      { running: false, healthy: true },
      {},
      null,
      undefined,
    ]
    for (const c of cases) expect(builtinSlotStatus(c)).not.toBe('failed')
  })

  it('an empty answer is treated as not running, not as broken', () => {
    expect(builtinSlotStatus({})).toBe('stopped')
  })
})
