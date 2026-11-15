/**
 * The live trace of the microphone while a dictation records (David,
 * 14.11.2026): a slim waveform that moves with the voice, the running time
 * next to it, and a quiet word when the microphone has heard nothing for a
 * few seconds. So a long dictation shows all along that sound arrives.
 *
 * Pure on purpose: the level comes from `useVoiceLevel()` (an AnalyserNode on
 * the real microphone stream, hooks/useVoice.ts), the drawing from
 * components/voice/MicLevelTrace.tsx. Desktop, web and phone use the same
 * numbers.
 */

/** How many readings the trace shows, oldest left, newest right. */
export const LEVEL_HISTORY = 28

/** Below this the microphone hears nothing worth showing: room noise, a fan. */
export const HEARD_LEVEL = 0.06

/** After this long without a level above HEARD_LEVEL the trace says so. */
export const QUIET_AFTER_MS = 3000

/** A bar never disappears: at silence the trace is a flat line of dots. */
export const BAR_FLOOR = 0.08

export const NO_SOUND_TEXT = 'No sound from mic'

/** An empty trace: flat. */
export function emptyHistory(size = LEVEL_HISTORY): number[] {
  return new Array<number>(size).fill(0)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

/** The trace with one more reading at the right end; the oldest one drops out. */
export function pushLevel(history: readonly number[], level: number): number[] {
  if (history.length === 0) return []
  return [...history.slice(1), clamp01(level)]
}

/**
 * The height of one bar, 0 to 1, for a level. Speech sits at 0.1 to 0.5 of
 * the stretched level, so it is lifted with a square root; silence stays at
 * the floor.
 */
export function barHeight(level: number): number {
  const l = clamp01(level)
  if (l < HEARD_LEVEL) return BAR_FLOOR
  return Math.max(BAR_FLOOR, Math.min(1, Math.sqrt(l) * 1.2))
}

/** Whether the microphone has been silent long enough to say so. */
export function isQuiet(lastHeardAt: number, now: number): boolean {
  return now - lastHeardAt >= QUIET_AFTER_MS
}

/** Milliseconds as "0:07", "12:30" or "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
