/**
 * Nebenbefund (c) of the R11 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r11-nachmessung.md, Beleg r11n-shot-14-s2-jan-disabled):
 *
 *   "Disable auf dem Slot-Inhaber gibt den Slot nicht zurueck. Nach Disable auf
 *    Jan stand Jan auf DISABLED und die eingebaute Engine BLIEB auf STANDBY,
 *    mit dem inzwischen falschen Satz 'Jan took over the local OpenAI
 *    compatible slot'. Ergebnis: gar kein lokales Backend, der Chat zeigte
 *    Select Model."
 *
 * The picker caught it honestly (R10's "No models available" text with an Open
 * Settings jump), so it was never a dead end. It was still the wrong answer to
 * the question the user asked. Switching a backend off is not a wish to be left
 * without one, and an engine was standing right there waiting for this exact
 * slot.
 *
 * So Disable on the slot holder now performs the same swap Enable performs,
 * pressed from the other side: the waiting engine takes the slot back, and the
 * backend that is leaving takes the standby card. No new mechanic and no new
 * stored state, `slotHandbackUpdate` is the one that already does this.
 *
 * Run: npx vitest run src/lib/__tests__/disable-hands-the-slot-back.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { slotTakeoverUpdate, slotHandbackUpdate, standbyOccupant, type HandoverSlot } from '../openai-slot-handover'
import { noChatBackendEnabled, providerRowIds, isReturnableRow } from '../provider-visibility'
import { PROVIDER_PRESETS } from '../../api/providers/types'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

const preset = (id: string) => {
  const p = PROVIDER_PRESETS.find((x) => x.id === id)!
  return { name: p.name, baseUrl: p.baseUrl, isLocal: p.isLocal, managed: p.managed }
}
const BUILTIN = preset('builtin')
const JAN = preset('jan')

const SHIPPED: HandoverSlot = { enabled: true, ...BUILTIN }
/** The measured state: Add Provider, entry Jan, on top of the built-in engine. */
const JAN_IN_SLOT = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot

/** The provider list around that slot, as the box had it. */
const listWith = (openai: HandoverSlot) => ({
  ollama: { enabled: false },
  openai,
  anthropic: { enabled: false },
  'lu-cloud': { enabled: true },
})

/** What the Disable button used to write on any row. */
const OLD_DISABLE_PATCH = { enabled: false, disabledByUser: true }

describe('THE FIX: Disable on the slot holder gives the slot back', () => {
  it('the measured press leaves a local backend running instead of none', () => {
    const before = listWith(JAN_IN_SLOT)
    expect(noChatBackendEnabled(before, 'local')).toBe(false)

    // what it did: Jan off, built-in still only remembered, nothing local left
    const oldWay = listWith({ ...JAN_IN_SLOT, ...OLD_DISABLE_PATCH } as HandoverSlot)
    expect(noChatBackendEnabled(oldWay, 'local')).toBe(true)

    // what it does: the waiting engine takes the slot
    const patch = slotHandbackUpdate(JAN_IN_SLOT)!
    const newWay = listWith({ ...JAN_IN_SLOT, ...patch } as HandoverSlot)
    expect(newWay.openai.name).toBe('Built-in Engine')
    expect(newWay.openai.managed).toBe(true)
    expect(newWay.openai.enabled).toBe(true)
    expect(noChatBackendEnabled(newWay, 'local')).toBe(false)
  })

  it('and the backend that was switched off is not lost either', () => {
    const after = { ...JAN_IN_SLOT, ...slotHandbackUpdate(JAN_IN_SLOT)! } as HandoverSlot
    expect(standbyOccupant(after)?.name).toBe('Jan')
  })

  it('the standby sentence can no longer claim a takeover that is switched off', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    // the takeover wording is now bound to the slot actually being on. Round 14
    // put the user's own Disable in front of this branch (Nebenbefund 3,
    // R12/R13), so the condition is no longer the first one in the chain, but
    // it is the same condition and it still guards the same sentence.
    expect(pane).toMatch(/providers\.openai\.enabled \? \([\s\S]{0,400}took over the local OpenAI compatible slot/)
    // and the other state has a sentence of its own that says what is true
    expect(pane).toMatch(/holds the local OpenAI compatible slot and is switched off,\s*\n?\s*so no local backend is running/)
  })

  it('the wiring: the Disable button routes through the handback', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    // Round 14: the same handback, wrapped so the backend that leaves is
    // labelled DISABLED rather than STANDBY. slotDisableOccupantUpdate IS
    // slotHandbackUpdate plus that mark, see openai-slot-handover.ts.
    expect(pane).toMatch(/if \(!nextEnabled && id === 'openai'\) \{\s*\n\s*const handback = slotDisableOccupantUpdate\(providers\.openai\)/)
    expect(pane).toMatch(/setProviderConfig\('openai', handback\)/)
    const lib = read('src/lib/openai-slot-handover.ts')
    expect(lib).toMatch(/const patch = slotHandbackUpdate\(slot\)/)
  })
})

describe('NEGATIVE CONTROL: everything the R10 and R11 rounds settled', () => {
  it('a slot with nobody waiting still goes to the greyed DISABLED row', () => {
    // Fresh install, built-in engine in the slot, nothing displaced: there is
    // no engine to hand anything back to, so Disable stays Disable.
    expect(slotHandbackUpdate(SHIPPED)).toBeNull()
    const off = { ...SHIPPED, ...OLD_DISABLE_PATCH } as HandoverSlot
    expect(isReturnableRow(off)).toBe(true)
    expect(providerRowIds(listWith(off))).toContain('openai')
  })

  it('the plain Disable path is untouched for every other slot', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/setProviderConfig\(id, \{ enabled: nextEnabled, disabledByUser: !nextEnabled \}\)/)
    // the handback branch is reached only on the shared slot, and only downwards
    expect(pane).not.toMatch(/if \(id === 'openai'\) \{\s*\n\s*const handback/)
  })

  it('onboarding still parks the slot its own way, without a handback', () => {
    const onboarding = read('src/components/onboarding/Onboarding.tsx')
    expect(onboarding).toMatch(/setProviderConfig\('openai', \{ enabled: false, managed: false \}\)/)
    expect(onboarding).not.toMatch(/slotHandbackUpdate/)
  })

  it('Enable on the standby card still swaps, it did not become a second Disable', () => {
    const patch = slotHandbackUpdate(JAN_IN_SLOT)!
    expect(patch.enabled).toBe(true)
    expect(patch.disabledByUser).toBe(false)
  })

  it('no em dash in the new copy', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    const i = pane.indexOf('The sentence has to describe the state')
    const j = pane.indexOf('{/* No backend warning', i)
    expect(i).toBeGreaterThan(-1)
    expect(pane.slice(i, j)).not.toMatch(/[–—]/)
  })
})
