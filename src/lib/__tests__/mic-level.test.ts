import { describe, expect, it } from 'vitest'
import {
  BAR_FLOOR, HEARD_LEVEL, LEVEL_HISTORY, QUIET_AFTER_MS,
  barHeight, emptyHistory, formatClock, isQuiet, pushLevel,
} from '../mic-level'

/** The live trace of the microphone (David, 14.11.2026): the pure numbers. */
describe('mic level trace', () => {
  it('starts flat and moves one reading to the left per tick', () => {
    const start = emptyHistory()
    expect(start).toHaveLength(LEVEL_HISTORY)
    expect(start.every((v) => v === 0)).toBe(true)
    const next = pushLevel(start, 0.5)
    expect(next).toHaveLength(LEVEL_HISTORY)
    expect(next[LEVEL_HISTORY - 1]).toBe(0.5)
    expect(pushLevel(next, 0.2).slice(-2)).toEqual([0.5, 0.2])
  })

  it('keeps readings between 0 and 1, also for garbage', () => {
    expect(pushLevel([0, 0], 4)).toEqual([0, 1])
    expect(pushLevel([0, 0], -1)).toEqual([0, 0])
    expect(pushLevel([0, 0], Number.NaN)).toEqual([0, 0])
  })

  it('is flat in silence and clearly up when someone speaks', () => {
    expect(barHeight(0)).toBe(BAR_FLOOR)
    expect(barHeight(HEARD_LEVEL / 2)).toBe(BAR_FLOOR)
    // quiet speech already stands at more than a third of the height
    expect(barHeight(0.1)).toBeGreaterThan(0.35)
    expect(barHeight(0.5)).toBeGreaterThan(0.8)
    expect(barHeight(1)).toBe(1)
  })

  it('says quiet only after a few seconds without sound', () => {
    expect(isQuiet(1000, 1000 + QUIET_AFTER_MS - 1)).toBe(false)
    expect(isQuiet(1000, 1000 + QUIET_AFTER_MS)).toBe(true)
  })

  it('shows the running time like a clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7_400)).toBe('0:07')
    expect(formatClock(750_000)).toBe('12:30')
    expect(formatClock(3_723_000)).toBe('1:02:03')
  })
})
