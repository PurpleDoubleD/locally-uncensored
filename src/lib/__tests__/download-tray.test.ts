/**
 * The downloads tray's open/close rule, as BEHAVIOUR.
 *
 * DownloadBadge-autoclose.test.ts guards the same three guarantees at the
 * source, because there is no render harness in this repo. That test had to be
 * re-pointed when the two `useEffect`s moved out of the component (React 19
 * `set-state-in-effect`), so this file exists to make the guarantees themselves
 * — not their spelling — the thing that is checked.
 *
 * Every case below is what the OLD two-effect version did, transition for
 * transition:
 *
 *   effect A, deps [totalActive]:  if (totalActive > 0) { open = true; auto = true }
 *   effect B, deps [hasAny]:       if (!hasAny && auto) { open = false; auto = false }
 *   button:                        open = !open; auto = false
 *
 * Run: npx vitest run src/lib/__tests__/download-tray.test.ts
 */
import { describe, it, expect } from 'vitest'
import { trayAfterPulse, TRAY_CLOSED, NO_PULSE, type TrayState } from '../download-tray'

const OPEN_AUTO: TrayState = { open: true, auto: true }
const OPEN_BY_HAND: TrayState = { open: true, auto: false }

describe('the tray opens itself when a download starts', () => {
  it('opens on the first running download', () => {
    expect(trayAfterPulse(TRAY_CLOSED, NO_PULSE, { active: 1, any: true })).toEqual(OPEN_AUTO)
  })

  it('opens for a download that was already running when the badge mounted', () => {
    // The badge is always mounted, but a restored (persisted) download can be
    // running before this component's first render. NO_PULSE is what makes that
    // read as "just started", the way the mount pass of the old effect did.
    expect(trayAfterPulse(TRAY_CLOSED, NO_PULSE, { active: 3, any: true })).toEqual(OPEN_AUTO)
  })

  it('opens again for a NEW download after the user closed it by hand', () => {
    const closedByHand: TrayState = { open: false, auto: false }
    expect(trayAfterPulse(closedByHand, { active: 1, any: true }, { active: 2, any: true }))
      .toEqual(OPEN_AUTO)
  })

  it('stays put when nothing about the picture changed', () => {
    const same = { active: 2, any: true }
    expect(trayAfterPulse(TRAY_CLOSED, same, same)).toBe(TRAY_CLOSED)
  })
})

describe('the tray closes itself, but only if it opened itself', () => {
  it('closes when the last entry goes away', () => {
    expect(trayAfterPulse(OPEN_AUTO, { active: 0, any: true }, { active: 0, any: false }))
      .toEqual({ open: false, auto: false })
  })

  it('leaves a hand-opened tray alone when the list empties', () => {
    expect(trayAfterPulse(OPEN_BY_HAND, { active: 0, any: true }, { active: 0, any: false }))
      .toBe(OPEN_BY_HAND)
  })

  it('stays open while a finished or paused row is still there to read', () => {
    // active drops to 0 but `any` is still true: the download completed and its
    // row is what the user is meant to see. This is why the close is keyed on
    // `any` and not on `active`.
    expect(trayAfterPulse(OPEN_AUTO, { active: 1, any: true }, { active: 0, any: true }))
      .toBe(OPEN_AUTO)
  })

  it('does not close a tray that is already shut', () => {
    expect(trayAfterPulse(TRAY_CLOSED, { active: 0, any: true }, { active: 0, any: false }))
      .toBe(TRAY_CLOSED)
  })
})

describe('a start beats a finish in the same change', () => {
  it('opening wins when both could apply', () => {
    // Cannot actually happen (active > 0 implies any), but the old code ran
    // effect A before effect B, so the order is pinned rather than assumed.
    expect(trayAfterPulse(OPEN_AUTO, { active: 0, any: true }, { active: 1, any: false }))
      .toEqual(OPEN_AUTO)
  })
})
