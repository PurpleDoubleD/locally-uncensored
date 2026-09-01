/**
 * Nebenbefund 2 of the R9 re-measure (2026-08-30): "Reset AI Backends to
 * defaults" looked like a dud on the first click. It is not. It is the same
 * arm-then-confirm mechanic the Cloud switch got in round 6, and the round 6
 * decision was that two clicks on ONE control is the cheapest confirmation
 * there is, cheaper than a dialog.
 *
 * So this round changes no behaviour. It checks the only thing that was ever
 * in question: whether the armed state SAYS so on screen. It does, in three
 * ways at once, and this test pins all three so a later refactor cannot quietly
 * turn the first click into a dud for real.
 *
 *   1. the label swaps to "Click again to reset <tab>"
 *   2. the colour goes from grey to red
 *   3. the weight goes to medium
 *
 * Plus the two releases that keep an armed button from lying in wait: the 4 s
 * timeout and the disarm on a tab switch.
 *
 * Run: npx vitest run src/lib/__tests__/reset-arming-is-visible.test.ts
 */
import { describe, it, expect } from 'vitest'
import { armedScopeFor } from '../reset-arming'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

const settingsPage = read('src/components/settings/SettingsPage.tsx')
const cloudSwitch = read('src/components/cloud/CloudSwitch.tsx')

describe('the reset button is armed visibly, which is why it stays as it is', () => {
  it('the label says what the next click will do', () => {
    expect(settingsPage).toMatch(
      /armed === 'section' \? `Click again to reset \$\{tabLabel\}` : `Reset \$\{tabLabel\} to defaults`/,
    )
  })

  it('the reset-everything button relabels too', () => {
    expect(settingsPage).toMatch(
      /armed === 'all' \? 'Click again to reset everything' : 'Reset all settings'/,
    )
  })

  it('and the armed button turns red and heavier, not only wordier', () => {
    expect(settingsPage).toMatch(
      /armed === 'section' \? 'text-red-400 font-medium' : 'text-gray-500 hover:text-red-400'/,
    )
  })

  it('the first click changes nothing else: it only arms and returns', () => {
    expect(settingsPage).toMatch(
      /if \(armed !== which\) \{\s*setArmed\(which\)[\s\S]{0,200}return\s*\}/,
    )
  })
})

describe('an armed button is never lying in wait', () => {
  it('it disarms itself after four seconds', () => {
    expect(settingsPage).toMatch(/setTimeout\(\(\) => setArmed\(null\), 4000\)/)
  })

  it('and a tab switch disarms it, so General cannot fire on Agent', () => {
    // This used to pin the effect that did it: useEffect(() => { setArmed(null) }, [tab]).
    // The effect is gone (it disarmed one render late, and React 19's
    // set-state-in-effect rule is right about that); the rule now lives in
    // armedScopeFor(), tested as behaviour just below. What stays pinned here
    // is that SettingsPage reads `armed` THROUGH that rule and never keeps a
    // raw armed flag that a tab switch could miss.
    expect(settingsPage).toMatch(/const armed = armedScopeFor\(arm, tab\)/)
    expect(settingsPage).not.toMatch(/useState<'section' \| 'all' \| null>/)
  })
})

describe('armedScopeFor: an arm is only live on the tab it was made on', () => {
  it('is armed on the tab the click happened on', () => {
    expect(armedScopeFor({ scope: 'section', tab: 'general' }, 'general')).toBe('section')
    expect(armedScopeFor({ scope: 'all', tab: 'general' }, 'general')).toBe('all')
  })

  it('is NOT armed on any other tab — General cannot fire on Agent', () => {
    expect(armedScopeFor({ scope: 'section', tab: 'general' }, 'agent')).toBeNull()
    expect(armedScopeFor({ scope: 'all', tab: 'general' }, 'backends')).toBeNull()
  })

  it('coming back to the tab does not re-arm a stale click either', () => {
    // The 4 s timer clears the arm outright; nothing else can resurrect it.
    expect(armedScopeFor(null, 'general')).toBeNull()
  })
})

describe('the same mechanic the Cloud switch uses, on purpose', () => {
  it('the Cloud switch arms and relabels the same way', () => {
    expect(cloudSwitch).toMatch(/armed \? 'Switch to Cloud\?' : 'Cloud'/)
    expect(cloudSwitch).toMatch(/setArmed\(true\)/)
  })

  it('NEGATIVE CONTROL: neither control opens a confirm dialog, that was the choice', () => {
    // The round 6 reasoning: no dialog, no mouse travel, no second surface.
    expect(cloudSwitch).not.toMatch(/window\.confirm/)
    expect(settingsPage).not.toMatch(/window\.confirm\(/)
  })

  it('NEGATIVE CONTROL: the reset still needs the SECOND click to fire', () => {
    // resetSettingsKeys must sit AFTER the arm-and-return guard, never before.
    const guard = settingsPage.indexOf('if (armed !== which)')
    const fires = settingsPage.indexOf('resetSettingsKeys(SETTINGS_TAB_RESET_KEYS[tab])')
    expect(guard).toBeGreaterThan(-1)
    expect(fires).toBeGreaterThan(guard)
  })

  it('NEGATIVE CONTROL: the backends reset still hands the slot back to the engine', () => {
    expect(settingsPage).toContain(
      "if (tab === 'backends') useProviderStore.getState().resetProvidersToDefaults()",
    )
  })
})
