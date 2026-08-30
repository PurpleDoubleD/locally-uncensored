/**
 * Nebenbefund 2 of the R10 re-measure on the real 2.6.7 Windows build
 * (2026-08-30): "the Cloud switch in the header switches OFF reliably, but
 * practically never ON. 8 clean single clicks at a spacing of 4 seconds, all
 * with real mouse events over CDP, all without effect, aria-checked stays
 * false. Over the whole session about 20 attempts from Local to Cloud, 2 of
 * them successful. Every single click from Cloud to Local worked at once."
 *
 * It reads like a broken control and it is not one. 4 seconds is
 * CLOUD_ARM_TIMEOUT_MS to the millisecond, the window the R5 fix put in front
 * of cloud mode so a single stray click could not move the app there and bill
 * the next question. A click at t=0 arms, the timer disarms at t=4000, the
 * next click lands at t=4000 plus the round trip and arms again. Eight clicks,
 * eight armings, no entry, and it would have gone on forever.
 *
 * The report names its own two exceptions and both land inside the window:
 * one space bar, and one second click 1.6 s after the first. The asymmetry it
 * reports is the guard's whole design: leaving cloud is one click, always.
 *
 * So the mechanism is understood and there is no defect to fix. What is worth
 * changing is the number. A human who reads four words, looks at the switch
 * and then decides is easily slower than four seconds, and anybody that slow
 * has the same experience the measurement had: nothing ever happens. Six is
 * the mild version, still nowhere near lying in wait.
 *
 * This file is the arithmetic, written down, so the next person who measures a
 * rhythm against this window can read why the rhythm mattered.
 *
 * Run: npx vitest run src/lib/__tests__/cloud-switch-arm-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { cloudSwitchClick, CLOUD_ARM_TIMEOUT_MS } from '../cloud-switch-guard'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

/**
 * The switch as the component runs it: a click arms, the arming expires
 * strictly AFTER the window (the timer fires at the window, and a click at the
 * same instant is a click that arrives later than the timer did).
 */
function clickRun(gapsMs: number[], window = CLOUD_ARM_TIMEOUT_MS) {
  let armed = false
  let on = false
  const actions: string[] = []
  let sinceArm = 0
  for (const gap of gapsMs) {
    if (armed) {
      sinceArm += gap
      if (sinceArm >= window) armed = false
    }
    const action = cloudSwitchClick({ on, available: true, armed })
    actions.push(action)
    if (action === 'arm') { armed = true; sinceArm = 0 }
    if (action === 'enter-cloud') { armed = false; on = true }
    if (action === 'leave-cloud') { armed = false; on = false }
  }
  return { actions, on }
}

describe('THE FINDING: the measured rhythm and the window were the same number', () => {
  it('the exact frame: 8 clicks at 4 s never enter cloud, on the old 4 s window', () => {
    const run = clickRun([0, 4000, 4000, 4000, 4000, 4000, 4000, 4000], 4000)
    expect(run.on).toBe(false)
    expect(new Set(run.actions)).toEqual(new Set(['arm']))
    expect(run.actions.length).toBe(8)
  })

  it('and the two that got through were the two that were faster', () => {
    // The report's own exceptions: a second click 1.6 s after the first.
    const run = clickRun([0, 1600], 4000)
    expect(run.actions).toEqual(['arm', 'enter-cloud'])
    expect(run.on).toBe(true)
  })

  it('THE CHANGE: a 4 s rhythm now has room instead of landing on the edge', () => {
    const run = clickRun([0, 4000])
    expect(run.actions).toEqual(['arm', 'enter-cloud'])
    expect(run.on).toBe(true)
  })

  it('the window is six seconds, mild and deliberate', () => {
    expect(CLOUD_ARM_TIMEOUT_MS).toBe(6000)
  })
})

describe('NEGATIVE CONTROL: the R5 guard is untouched, only the number moved', () => {
  it('one stray click still cannot move the app into cloud', () => {
    // The whole point of the guard: a single click on a fresh switch arms and
    // changes nothing. This is the money frame of Nebenbefund 4 of R5.
    expect(cloudSwitchClick({ on: false, available: true, armed: false })).toBe('arm')
    expect(clickRun([0]).on).toBe(false)
  })

  it('the arming still expires on its own, it does not lie in wait', () => {
    const run = clickRun([0, 60_000])
    expect(run.actions).toEqual(['arm', 'arm'])
    expect(run.on).toBe(false)
    // Bracketed, so the next mild adjustment cannot quietly become a minute.
    expect(CLOUD_ARM_TIMEOUT_MS).toBeGreaterThan(1500)
    expect(CLOUD_ARM_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('leaving cloud is still one click, at any spacing', () => {
    // The asymmetry the re-measure reported is the design: a guard on the way
    // out would only make it harder to stop spending money.
    let on = true
    for (const armed of [false, true]) {
      expect(cloudSwitchClick({ on, available: true, armed })).toBe('leave-cloud')
    }
    on = false
    expect(on).toBe(false)
  })

  it('an account without cloud still meets the gate on the first click', () => {
    expect(cloudSwitchClick({ on: false, available: false, armed: false })).toBe('open-gate')
  })
})

describe('the arming has to be visible the moment it happens', () => {
  const sw = read('src/components/cloud/CloudSwitch.tsx')

  it('the label changes with the state, on the same render as the click', () => {
    expect(sw).toMatch(/armed \? 'Switch to Cloud\?' : 'Cloud'/)
    // No transition on the text: a faded-in label is a label that was not
    // there when the user looked.
    const label = sw.slice(sw.indexOf('data-testid="cloud-switch-label"'), sw.indexOf("{armed ? 'Switch to Cloud?'"))
    expect(label).not.toMatch(/transition/)
  })

  it('the state is readable without guessing at class names', () => {
    // aria-checked answers the MODE, and correctly stays false while armed,
    // which is exactly what made the re-measure read "nothing happened".
    expect(sw).toMatch(/data-testid="cloud-switch-label"/)
    expect(sw).toMatch(/data-state=\{armed \? 'armed' : on \? 'on' : 'off'\}/)
    expect(sw).toMatch(/data-armed=\{armed \? 'true' : undefined\}/)
  })

  it('NEGATIVE CONTROL: the selector the re-measure used still works', () => {
    // aria-label stays "Cloud" and aria-checked stays the mode. Moving either
    // would break every probe written against this control so far.
    expect(sw).toMatch(/aria-label="Cloud"/)
    expect(sw).toMatch(/aria-checked=\{on\}/)
  })

  it('NEGATIVE CONTROL: the first click still writes nothing but the arming', () => {
    const arm = sw.slice(sw.indexOf("case 'arm':"), sw.indexOf("case 'enter-cloud':"))
    expect(arm).toMatch(/setArmed\(true\)/)
    expect(arm).not.toMatch(/updateSettings|setCloudGateOpen/)
  })
})
