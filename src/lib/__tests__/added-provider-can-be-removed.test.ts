/**
 * Nebenbefund (b) of the R11 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r11-nachmessung.md):
 *
 *   "Ein angelegter Anbieter laesst sich ueber die Oberflaeche nicht mehr
 *    entfernen. Die Jan-Karte bietet aufgeklappt nur Endpoint, Test und
 *    Disable [...] Kein Remove, kein Delete, kein Papierkorb, auch nicht im
 *    Standby- und nicht im Disabled-Zustand. Der einzige Rueckweg ist
 *    Reset AI Backends to defaults."
 *
 * The agent had to press exactly that Reset to restore the machine, which also
 * throws away every other backend the user set up.
 *
 * What "remove" can mean here is decided by the shape of the store: `ProviderId`
 * is four fixed slots and none of them is a row that could be deleted. What the
 * user added is a BACKEND he put into the shared `openai` slot on top of
 * whatever was there, and R11 already taught that slot to remember what it
 * displaced. So Remove is the handover read backwards: put the slot back the
 * way it was before the takeover and forget the backend that leaves. It is
 * offered where, and only where, such a memory exists, which keeps the built-in
 * engine and the three other slots out of reach.
 *
 * Run: npx vitest run src/lib/__tests__/added-provider-can-be-removed.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  occupantIsRemovable,
  standbyIsRemovable,
  slotRemoveOccupantUpdate,
  slotForgetStandbyUpdate,
  slotTakeoverUpdate,
  slotHandbackUpdate,
  standbyOccupant,
  type HandoverSlot,
} from '../openai-slot-handover'
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
const LMSTUDIO = preset('lmstudio')

/** The slot as it ships. */
const SHIPPED: HandoverSlot = { enabled: true, ...BUILTIN }
/** The slot after the measured path: Add Provider, entry Jan. */
const JAN_IN_SLOT: HandoverSlot = {
  enabled: true,
  ...JAN,
  ...slotTakeoverUpdate(SHIPPED, JAN),
} as HandoverSlot

describe('THE FIX: a backend put into the local slot can be taken off again', () => {
  it('the measured state offers a Remove, and it names a way back', () => {
    expect(standbyOccupant(JAN_IN_SLOT)?.name).toBe('Built-in Engine')
    expect(occupantIsRemovable(JAN_IN_SLOT)).toBe(true)
  })

  it('Remove puts the slot back exactly as it stood before the takeover', () => {
    const update = slotRemoveOccupantUpdate(JAN_IN_SLOT)!
    expect(update.name).toBe('Built-in Engine')
    expect(update.baseUrl).toBe(BUILTIN.baseUrl)
    expect(update.managed).toBe(true)
    expect(update.isLocal).toBe(true)
    expect(update.enabled).toBe(true)
    // and nothing is left half switched off from an earlier Disable
    expect(update.disabledByUser).toBe(false)
  })

  it('Remove FORGETS, where Enable swaps: no card is owed afterwards', () => {
    const after = { ...JAN_IN_SLOT, ...slotRemoveOccupantUpdate(JAN_IN_SLOT)! } as HandoverSlot
    expect(after.displaced).toBeUndefined()
    expect(standbyOccupant(after)).toBeNull()
    // the Enable next to it still swaps, which is the whole difference
    const swapped = { ...JAN_IN_SLOT, ...slotHandbackUpdate(JAN_IN_SLOT)! } as HandoverSlot
    expect(standbyOccupant(swapped)?.name).toBe('Jan')
  })

  it('the backend that is only waiting can be forgotten too', () => {
    // After Enable: Built-in Engine holds the slot, Jan waits beside it. The
    // wish to be rid of Jan is the same wish, and this is where it is pressed.
    const swapped = { ...JAN_IN_SLOT, ...slotHandbackUpdate(JAN_IN_SLOT)! } as HandoverSlot
    expect(standbyIsRemovable(swapped)).toBe(true)
    const after = { ...swapped, ...slotForgetStandbyUpdate(swapped)! } as HandoverSlot
    expect(standbyOccupant(after)).toBeNull()
    // and the slot itself was not touched
    expect(after.name).toBe('Built-in Engine')
    expect(after.enabled).toBe(true)
  })

  it('a second added backend is removable in its turn', () => {
    const lm = { ...JAN_IN_SLOT, ...slotTakeoverUpdate(JAN_IN_SLOT, LMSTUDIO) } as HandoverSlot
    expect(occupantIsRemovable(lm)).toBe(true)
    expect(slotRemoveOccupantUpdate(lm)!.name).toBe('Jan')
  })
})

describe('NEGATIVE CONTROL: what must stay un-removable', () => {
  it('the shipped slot has no Remove, because there is nothing to go back to', () => {
    expect(occupantIsRemovable(SHIPPED)).toBe(false)
    expect(slotRemoveOccupantUpdate(SHIPPED)).toBeNull()
    expect(standbyIsRemovable(SHIPPED)).toBe(false)
    expect(slotForgetStandbyUpdate(SHIPPED)).toBeNull()
  })

  it("the app's own engine is never the thing that gets removed", () => {
    // Built-in Engine back in the slot, Jan waiting: pressing Remove on the
    // built-in row would leave the slot with no floor under it and re-open the
    // hole R10 closed.
    const swapped = { ...JAN_IN_SLOT, ...slotHandbackUpdate(JAN_IN_SLOT)! } as HandoverSlot
    expect(swapped.managed).toBe(true)
    expect(occupantIsRemovable(swapped)).toBe(false)
    expect(slotRemoveOccupantUpdate(swapped)).toBeNull()
  })

  it('and it is not forgotten while it waits on standby either', () => {
    // Jan in the slot, Built-in Engine on standby: that card IS the way back.
    expect(standbyOccupant(JAN_IN_SLOT)?.managed).toBe(true)
    expect(standbyIsRemovable(JAN_IN_SLOT)).toBe(false)
    expect(slotForgetStandbyUpdate(JAN_IN_SLOT)).toBeNull()
  })

  it('the R10 and R11 mechanics are unchanged by all of this', () => {
    // takeover still remembers
    expect(slotTakeoverUpdate(SHIPPED, JAN).displaced?.name).toBe('Built-in Engine')
    // a slot that was already off is still not remembered as displaced
    expect(slotTakeoverUpdate({ ...SHIPPED, enabled: false }, JAN).displaced).toBeUndefined()
    // and handback still returns the swap patch
    expect(slotHandbackUpdate(JAN_IN_SLOT)!.name).toBe('Built-in Engine')
  })
})

describe('the wiring, so the button reaches the screen', () => {
  const pane = read('src/components/settings/ProviderConfig.tsx')

  it('the Remove button sits on the card and goes through the rule', () => {
    expect(pane).toMatch(/data-testid="provider-remove"/)
    expect(pane).toMatch(/id === 'openai' && occupantIsRemovable\(providers\.openai\)/)
    expect(pane).toMatch(/const update = slotRemoveOccupantUpdate\(providers\.openai\)/)
    // and the standby card carries the same offer
    expect(pane).toMatch(/data-testid="standby-remove"/)
    expect(pane).toMatch(/standbyIsRemovable\(providers\.openai\)/)
    expect(pane).toMatch(/const update = slotForgetStandbyUpdate\(providers\.openai\)/)
  })

  it("it asks in the house's click-again pattern, not with a dialog", () => {
    expect(pane).toMatch(/armedRemove === 'occupant' \? 'Click again to remove' : 'Remove'/)
    expect(pane).toMatch(/armedRemove === 'standby' \? 'Click again to remove' : 'Remove'/)
    // first click writes nothing, second one inside the window does it
    expect(pane).toMatch(/if \(armedRemove !== which\) \{/)
    expect(pane).toMatch(/window\.setTimeout\(\(\) => setArmedRemove\(null\), 4000\)/)
    // no second confirmation surface was added for this
    const removeBlock = pane.slice(pane.indexOf('function armOrRun'), pane.indexOf('function handBackSlot'))
    expect(removeBlock).not.toMatch(/Modal|confirm\(/)
  })

  it('NEGATIVE CONTROL: no em dash in the new copy', () => {
    const between = (a: string, b: string) => {
      const i = pane.indexOf(a)
      expect(i).toBeGreaterThan(-1)
      const j = pane.indexOf(b, i)
      expect(j).toBeGreaterThan(i)
      return pane.slice(i, j)
    }
    for (const block of [
      between('const [armedRemove', 'function handBackSlot'),
      between('{/* Remove, for a backend', '{/* Bug (g)'),
      between('{standbyIsRemovable', 'onClick={handBackSlot}'),
    ]) {
      expect(block).not.toMatch(/[–—]/)
    }
  })
})
