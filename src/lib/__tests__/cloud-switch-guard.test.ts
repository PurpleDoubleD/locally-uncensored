/**
 * Nebenbefund 4 of the R5 re-measure on the 2.6.7 Windows build
 * (2026-08-30, ergebnis-r5-nachmessung.md), the one that costs money:
 *
 *   "Der Cloud-Schalter liegt als Stolperstein neben dem Modellwaehler. Ein
 *    einzelner Fehlklick in der Kopfzeile schaltete die App von Local auf
 *    Cloud, waehlte still ein Cloud-Modell und schickte die naechste Frage an
 *    die Cloud. Rueckweg ohne Rueckfrage, die vorherige lokale Modellwahl kam
 *    von selbst zurueck. Kostenrelevant, weil eine versehentlich gesendete
 *    Frage abgerechnet wird."
 *
 * It was found by making the mistake, not by looking for it. The whole chain
 * ran on one click: mode flipped, pickForMode silently put a hosted model in
 * the place of the local one, and the next Send went to lu-labs.ai and was
 * billed. Nothing in the writing area said any of it had happened.
 *
 * Two answers, both small. Going INTO cloud takes two clicks on the same spot;
 * going out stays one. And cloud mode is drawn on the composer, in words, on
 * the row the user looks at while typing.
 *
 * Run: npx vitest run src/lib/__tests__/cloud-switch-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { cloudSwitchClick, CLOUD_ARM_TIMEOUT_MS } from '../cloud-switch-guard'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p: string) => readFileSync(resolve(here, '../..', p), 'utf8')

describe('one stray click cannot move the app into cloud', () => {
  it('THE FIX: the exact frame of the re-measure, a single click arms and changes nothing', () => {
    // Local, a usable cloud account, one click. Before this it was already in
    // cloud and the next question was billed.
    expect(cloudSwitchClick({ on: false, available: true, armed: false })).toBe('arm')
  })

  it('THE FIX: the second click on the same spot is the deliberate one', () => {
    expect(cloudSwitchClick({ on: false, available: true, armed: true })).toBe('enter-cloud')
  })

  it('THE FIX: an armed switch disarms itself, it does not lie in wait', () => {
    // Long enough to read four words and move a finger, short enough that a
    // click a minute later never means something it was not meant to mean.
    expect(CLOUD_ARM_TIMEOUT_MS).toBeGreaterThan(1500)
    expect(CLOUD_ARM_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('NEGATIVE CONTROL: leaving cloud stays one click, always', () => {
    // A guard on the way out would only make it harder to stop spending
    // money, which is backwards. Armed or not, on means out.
    expect(cloudSwitchClick({ on: true, available: true, armed: false })).toBe('leave-cloud')
    expect(cloudSwitchClick({ on: true, available: true, armed: true })).toBe('leave-cloud')
    expect(cloudSwitchClick({ on: true, available: false, armed: false })).toBe('leave-cloud')
  })

  it('NEGATIVE CONTROL: an account without cloud keeps the gate it always had', () => {
    // A slip there has never cost anything, and the gate modal is itself a
    // confirmation. The deliberate path for that user is unchanged.
    expect(cloudSwitchClick({ on: false, available: false, armed: false })).toBe('open-gate')
    expect(cloudSwitchClick({ on: false, available: false, armed: true })).toBe('open-gate')
  })

  it('NEGATIVE CONTROL: the deliberate switch is two clicks on one control, no dialog', () => {
    const sw = src('components/cloud/CloudSwitch.tsx')
    expect(sw).toMatch(/cloudSwitchClick\(\{ on, available, armed \}\)/)
    // No browser dialog, and no modal of ours either: the only modal this file
    // may reach for is the pre-existing gate for an account that cannot use
    // cloud at all, which is a different branch and was never the problem.
    expect(sw).not.toMatch(/window\.confirm|[^a-zA-Z]confirm\(/)
    const arm = sw.slice(sw.indexOf("case 'arm':"), sw.indexOf("case 'enter-cloud':"))
    // The first click changes nothing but the switch's own label. No settings
    // write, no modal, no model swap.
    expect(arm).toMatch(/setArmed\(true\)/)
    expect(arm).not.toMatch(/updateSettings|setCloudGateOpen/)
  })
})

describe('the switch says what the next click will do', () => {
  it('THE FIX: an armed switch is labelled, not just tinted', () => {
    const sw = src('components/cloud/CloudSwitch.tsx')
    expect(sw).toMatch(/armed \? 'Switch to Cloud\?' : 'Cloud'/)
  })

  it('THE FIX: the arming is dropped when the switch loses focus', () => {
    expect(src('components/cloud/CloudSwitch.tsx')).toMatch(/onBlur=\{\(\) => setArmed\(false\)\}/)
  })

  it('THE FIX: the arming times out on its own', () => {
    const sw = src('components/cloud/CloudSwitch.tsx')
    expect(sw).toMatch(/setTimeout\(\(\) => setArmed\(false\), CLOUD_ARM_TIMEOUT_MS\)/)
  })
})

describe('cloud mode is visible where the money is spent', () => {
  it('THE FIX: the composer box itself changes state, not only a switch in the corner', () => {
    const input = src('components/chat/ChatInput.tsx')
    expect(input).toMatch(/const cloudMode = useSettingsStore\(\(s\) => s\.settings\.appMode\) === 'cloud'/)
    expect(input).toMatch(/data-cloud=\{cloudMode \? 'on' : undefined\}/)
  })

  it('THE FIX: it says so in words, because a colour alone is not a statement', () => {
    const input = src('components/chat/ChatInput.tsx')
    expect(input).toMatch(/data-testid="composer-cloud-state"/)
    // And the label names the cost, not just the mode.
    expect(input).toMatch(/billed to your lu-labs\.ai credits/)
  })

  it('NEGATIVE CONTROL: local mode draws none of it', () => {
    const input = src('components/chat/ChatInput.tsx')
    // The marker is behind the mode check, so a local session is untouched.
    expect(input).toMatch(/\{cloudMode && \(/)
  })
})
