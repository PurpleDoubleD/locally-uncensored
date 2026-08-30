/**
 * What one click on the Cloud switch is allowed to do.
 *
 * Nebenbefund 4 of the R5 re-measure on the 2.6.7 Windows build (2026-08-30).
 * A single stray click in the header moved the app from Local to Cloud, a
 * cloud model was picked silently in its place, and the next question went to
 * lu-labs.ai and was billed. The way back was one click and the previous local
 * pick came back by itself, so the slip cost nothing but the question, and a
 * question is exactly the thing that costs money here. It was found by making
 * the mistake, not by looking for it.
 *
 * The guard is the smallest one that can work: going INTO cloud takes two
 * clicks on the same spot, going OUT stays one.
 *
 * Two clicks on the same control, with no dialog, no mouse travel and no
 * modal, is the cheapest confirmation there is. It costs the deliberate
 * switcher one extra click in the place his finger already is. It costs a slip
 * nothing at all: the armed state says what it is about to do and disarms
 * itself after a few seconds.
 *
 * The account that cannot use cloud is untouched. Its first click already
 * opens the gate modal, which is a confirmation of its own, and a slip there
 * has never cost anything.
 */

export type CloudSwitchAction =
  /** Cloud is on. One click goes back to Local, always, no confirmation. */
  | 'leave-cloud'
  /** No usable cloud account. Opens the gate, exactly as before. */
  | 'open-gate'
  /** First click of two. Nothing changes yet, the switch says what it will do. */
  | 'arm'
  /** Second click, deliberate. Now the app moves to Cloud. */
  | 'enter-cloud'

export interface CloudSwitchState {
  /** Is the app in cloud mode right now. */
  on: boolean
  /** Is the cloud axis usable (signed in, licensed, budget). */
  available: boolean
  /** Did a first click already arm this switch. */
  armed: boolean
}

/**
 * How long an armed switch waits for the second click.
 *
 * Long enough to move a finger and read four words, short enough that an armed
 * switch is never lying in wait minutes later for a click that means something
 * else entirely.
 *
 * Was 4000. Nebenbefund 2 of the R10 re-measure (2026-08-30) read as a defect
 * and is not one: "the Cloud switch only ever switches OFF, about 2 of 20
 * attempts got INTO cloud". The measurement was 8 clean single clicks at a
 * spacing of 4 seconds, which is this constant exactly. A click at t=0 arms,
 * the timer disarms at t=4000, and the next click lands at t=4000 plus the
 * round trip, so it arms again instead of entering. Eight clicks, eight
 * armings, no entry, systematically. The report names its own two exceptions
 * and both fit: one space bar, and one second click 1.6 s after the first.
 * Leaving cloud is one click and worked every single time, which is the other
 * half of the picture.
 *
 * So the guard did what it was built to do and the reading was wrong. It is
 * still a poor number to have picked, because a human who reads four words,
 * looks at the switch and then decides is easily slower than four seconds, and
 * anybody who is that slow experiences the same thing the measurement did:
 * nothing happens, ever. Six seconds is the mild version. It stays far inside
 * the window the test brackets, it is still nowhere near lying in wait, and it
 * gives a rhythm of four seconds room instead of landing on it.
 */
export const CLOUD_ARM_TIMEOUT_MS = 6000

export function cloudSwitchClick(state: CloudSwitchState): CloudSwitchAction {
  // Leaving cloud is free and always was. A guard on the way out would only
  // make it harder to stop spending money, which is backwards.
  if (state.on) return 'leave-cloud'
  if (!state.available) return 'open-gate'
  return state.armed ? 'enter-cloud' : 'arm'
}
