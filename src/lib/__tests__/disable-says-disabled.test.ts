/**
 * Nebenbefund 3 of the R12/R13 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r1213-nachmessung.md):
 *
 *   "Disable auf dem Slot-Inhaber setzt den Anbieter nicht auf DISABLED,
 *    sondern auf STANDBY. Das ist die freundlichere Auslegung und verhindert
 *    genau die Meldung aus T2. Es weicht aber von der Beschriftung ab: der
 *    Knopf heisst Disable, das Ergebnis ist ein Rollentausch."
 *
 * The swap itself is right and stays exactly as R11 built it: the engine
 * waiting for the slot takes it back, so nobody is left without a local
 * backend. Only the word on the card was wrong. STANDBY is what a backend gets
 * when something ELSE took the slot from it; this one was switched off by hand,
 * and the button that did it says Disable.
 *
 * So the card reads DISABLED and carries `disabledByUser`, the same mark every
 * other switched-off row in the pane carries. Enable and Remove stay on it: the
 * way back must not depend on how the backend got there.
 *
 * Run: npx vitest run src/lib/__tests__/disable-says-disabled.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  slotTakeoverUpdate,
  slotHandbackUpdate,
  slotDisableOccupantUpdate,
  standbyOccupant,
  standbyIsRemovable,
  type HandoverSlot,
} from '../openai-slot-handover'
import { noChatBackendEnabled } from '../provider-visibility'
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

const listWith = (openai: HandoverSlot) => ({
  ollama: { enabled: false },
  openai,
  anthropic: { enabled: false },
  'lu-cloud': { enabled: true },
})

describe('THE FIX: Disable on the slot holder says the backend is disabled', () => {
  const afterDisable = { ...JAN_IN_SLOT, ...slotDisableOccupantUpdate(JAN_IN_SLOT)! } as HandoverSlot

  it('the card of the backend the user switched off carries the mark', () => {
    expect(standbyOccupant(afterDisable)?.name).toBe('Jan')
    expect(standbyOccupant(afterDisable)?.disabledByUser).toBe(true)
  })

  it('the pane draws DISABLED for it, and keeps STANDBY for a real takeover', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/const standbyOff = standby\?\.disabledByUser === true/)
    expect(pane).toMatch(/\{standbyOff\s*\n?\s*\? <span[^>]*>DISABLED<\/span>/)
    expect(pane).toMatch(/: <span[^>]*>STANDBY<\/span>\}/)
  })

  it('and the sentence under it names the press instead of a takeover', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/\{standbyOff \? \([\s\S]{0,400}You switched \{standby\.name\} off/)
    expect(pane).toMatch(/Press Enable to switch \{standby\.name\}\s*\n?\s*\{' '\}back on and give it the slot again/)
  })

  it('the Disable button is the only thing that writes the mark', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/if \(!nextEnabled && id === 'openai'\) \{\s*\n\s*const handback = slotDisableOccupantUpdate\(providers\.openai\)/)
    // Add Provider still takes the slot without claiming anybody switched off
    expect(standbyOccupant(JAN_IN_SLOT)?.disabledByUser).toBeUndefined()
  })

  it('Enable and Remove stay on the card, whichever way it got there', () => {
    expect(standbyIsRemovable(afterDisable)).toBe(true)
    const back = slotHandbackUpdate(afterDisable)!
    expect(back.enabled).toBe(true)
    expect(back.name).toBe('Jan')
    // and switching it back on clears the mark rather than dragging it along
    expect(back.disabledByUser).toBe(false)
    const reEnabled = { ...afterDisable, ...back } as HandoverSlot
    expect(standbyOccupant(reEnabled)?.name).toBe('LU Engine')
    expect(standbyOccupant(reEnabled)?.disabledByUser).toBeUndefined()
  })
})

describe('NEGATIVE CONTROL: everything R10, R11 and R13 settled', () => {
  it('the swap itself is untouched, the slot still goes back to the engine', () => {
    // The R11 finding: Disable on the slot holder must not leave the machine
    // with no local backend at all.
    const patch = slotDisableOccupantUpdate(JAN_IN_SLOT)!
    const after = listWith({ ...JAN_IN_SLOT, ...patch } as HandoverSlot)
    expect(after.openai.name).toBe('LU Engine')
    expect(after.openai.managed).toBe(true)
    expect(after.openai.enabled).toBe(true)
    expect(noChatBackendEnabled(after, 'local')).toBe(false)
  })

  it('the slot itself is NOT marked disabled, only the card that left it', () => {
    // Marking the slot would grey out the engine that just took it over, which
    // is the hole R10 closed. The mark belongs to the backend, not the seat.
    const patch = slotDisableOccupantUpdate(JAN_IN_SLOT)!
    expect(patch.disabledByUser).toBe(false)
    expect(patch.enabled).toBe(true)
  })

  it('a slot with nobody waiting still goes to the plain greyed DISABLED row', () => {
    // Fresh install, built-in engine in the slot, nothing displaced: there is
    // nobody to hand the slot to, so the ordinary Disable path applies and the
    // R10 row is what the user sees.
    expect(slotDisableOccupantUpdate(SHIPPED)).toBeNull()
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/setProviderConfig\(id, \{ enabled: nextEnabled, disabledByUser: !nextEnabled \}\)/)
    expect(pane).toMatch(/if \(isReturnableRow\(config\)\)/)
  })

  it('Enable on the standby card is still a swap and never writes the mark', () => {
    // Pressing Enable is the opposite wish, so the backend it displaces goes to
    // STANDBY, not to DISABLED.
    const patch = slotHandbackUpdate(JAN_IN_SLOT)!
    const after = { ...JAN_IN_SLOT, ...patch } as HandoverSlot
    expect(standbyOccupant(after)?.name).toBe('Jan')
    expect(standbyOccupant(after)?.disabledByUser).toBeUndefined()
  })

  it('Add Provider still labels the backend it pushed out STANDBY', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/took over the local OpenAI compatible slot/)
    expect(standbyOccupant(JAN_IN_SLOT)?.name).toBe('LU Engine')
    expect(standbyOccupant(JAN_IN_SLOT)?.disabledByUser).toBeUndefined()
  })

  it('the parked-slot sentence onboarding needs is still there', () => {
    const pane = read('src/components/settings/ProviderConfig.tsx')
    expect(pane).toMatch(/holds the local OpenAI compatible slot and is switched off,\s*\n?\s*so no local backend is running/)
  })

  it('no em dash in the new copy', () => {
    const lib = read('src/lib/openai-slot-handover.ts')
    const i = lib.indexOf('The patch DISABLE on the slot holder writes')
    expect(i).toBeGreaterThan(-1)
    expect(lib.slice(i, lib.indexOf('export function slotDisableOccupantUpdate', i))).not.toMatch(/[–—]/)
    const pane = read('src/components/settings/ProviderConfig.tsx')
    const j = pane.indexOf('Two ways to land here')
    expect(j).toBeGreaterThan(-1)
    expect(pane.slice(j, pane.indexOf('{/* No backend warning', j))).not.toMatch(/[–—]/)
  })
})
