/**
 * When the downloads tray in the header opens and closes itself.
 *
 * The tray opens itself the moment a download starts, and closes itself again
 * when there is nothing left to show — but ONLY if it was the tray that opened
 * it. A tray the user opened by hand stays put. (Regression of 2026-07-26: an
 * auto-opened tray had no way back, so the panel hung over the app reading
 * "No active downloads" until the user happened to click somewhere else.)
 *
 * This used to live in two `useEffect`s inside DownloadBadge that wrote the
 * answer back into React state after every change of the download picture,
 * which React 19 flags as `set-state-in-effect` — a cascading render, landing a
 * paint later than it had to. The rule itself never depended on effects, so it
 * is a pure function here and the component applies it while rendering. Being
 * pure is also the only way it can be tested at all: the repo has no render
 * harness (vitest runs in `node`, there is no @testing-library).
 */

/** Is the tray open, and was it the tray or the user that opened it. */
export interface TrayState {
  open: boolean
  /** True only while the tray is showing itself unasked. */
  auto: boolean
}

/** The download picture in one glance. */
export interface DownloadPulse {
  /** How many downloads are running right now (paused/finished excluded). */
  active: number
  /** Whether there is ANY entry at all — running, paused, finished or failed. */
  any: boolean
}

/**
 * The tray after the download picture changed from `seen` to `now`.
 *
 * Returns the SAME object when nothing applies, so a caller can skip the state
 * write entirely.
 *
 * Two transitions, in the order the two old effects ran in:
 *
 *  1. The number of running downloads changed and something is running: a
 *     download started, so show the tray and remember that WE opened it.
 *     Keyed on the count changing, not on "> 0", so the tray does not
 *     re-assert itself on every unrelated re-render.
 *  2. The last entry went away and the tray is the one that opened itself:
 *     close it. Keyed on `any` (every entry, not just active ones), so a
 *     finished or failed row stays readable until it is cleared.
 */
export function trayAfterPulse(tray: TrayState, seen: DownloadPulse, now: DownloadPulse): TrayState {
  if (seen.active !== now.active && now.active > 0) return { open: true, auto: true }
  if (seen.any !== now.any && !now.any && tray.auto) return { open: false, auto: false }
  return tray
}

/** The tray as it starts out: shut, and not by anyone's decision. */
export const TRAY_CLOSED: TrayState = { open: false, auto: false }

/**
 * The pulse the component compares its FIRST render against.
 *
 * Zero on purpose: a download already running when the badge mounts has to
 * count as one that just started, which is what the mount pass of the old
 * auto-open effect did.
 */
export const NO_PULSE: DownloadPulse = { active: 0, any: false }
