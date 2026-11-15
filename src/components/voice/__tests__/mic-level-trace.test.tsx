// @vitest-environment jsdom
/**
 * The live trace of the microphone while a dictation records (David,
 * 14.11.2026): flat in silence, moving with the voice, the running time next
 * to it, and "No sound from mic" after a few seconds without any level.
 *
 * Run: npx vitest run src/components/voice/__tests__/mic-level-trace.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const mic = vi.hoisted(() => ({ level: 0 }))
vi.mock('../../../hooks/useVoice', () => ({
  LEVEL_INTERVAL_MS: 90,
  voiceLevel: () => mic.level,
}))

import { MicLevelTrace } from '../MicLevelTrace'
import { BAR_FLOOR, LEVEL_HISTORY, NO_SOUND_TEXT, QUIET_AFTER_MS } from '../../../lib/mic-level'

function heights(): number[] {
  return [...screen.getByTestId('mic-level-bars').querySelectorAll('i')].map((bar) =>
    Number(/scaleY\(([\d.]+)\)/.exec((bar as HTMLElement).style.transform)?.[1]),
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T16:00:00Z'))
  mic.level = 0
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MicLevelTrace', () => {
  it('is a flat line in silence and moves when the voice comes', () => {
    render(<MicLevelTrace since={Date.now()} />)
    expect(heights()).toHaveLength(LEVEL_HISTORY)
    act(() => { vi.advanceTimersByTime(900) })
    expect(heights().every((h) => h === BAR_FLOOR)).toBe(true)

    mic.level = 0.4
    act(() => { vi.advanceTimersByTime(450) })
    const now = heights()
    expect(now[now.length - 1]).toBeGreaterThan(0.6)
    // the newest readings stand, the older ones are still the flat line
    expect(now[0]).toBe(BAR_FLOOR)
  })

  it('shows the running time', () => {
    render(<MicLevelTrace since={Date.now()} />)
    expect(screen.getByTestId('mic-level-clock').textContent).toBe('0:00')
    act(() => { vi.advanceTimersByTime(7_050) })
    expect(screen.getByTestId('mic-level-clock').textContent).toBe('0:07')
  })

  it('says "No sound from mic" after a few seconds without level, and takes it back when sound comes', () => {
    render(<MicLevelTrace since={Date.now()} />)
    act(() => { vi.advanceTimersByTime(QUIET_AFTER_MS - 200) })
    expect(screen.queryByTestId('mic-level-quiet')).toBeNull()
    act(() => { vi.advanceTimersByTime(400) })
    expect(screen.getByTestId('mic-level-quiet').textContent).toBe(NO_SOUND_TEXT)

    mic.level = 0.3
    act(() => { vi.advanceTimersByTime(100) })
    expect(screen.queryByTestId('mic-level-quiet')).toBeNull()
  })

  it('also says it in the middle of a long take, not only at the start', () => {
    mic.level = 0.3
    render(<MicLevelTrace since={Date.now()} />)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.queryByTestId('mic-level-quiet')).toBeNull()
    mic.level = 0
    act(() => { vi.advanceTimersByTime(QUIET_AFTER_MS + 100) })
    expect(screen.getByTestId('mic-level-quiet')).toBeTruthy()
  })
})
