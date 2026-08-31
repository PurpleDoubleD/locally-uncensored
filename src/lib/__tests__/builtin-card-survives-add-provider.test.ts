/**
 * Nebenbefund 3 of the R10 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r10-nachmessung.md). The one path found on which a
 * provider card really does vanish without a trace, and the one that fits the
 * user report R9 and R10 were both read against.
 *
 * The measured frame (r10n-q1-11-jan-hinzu.png): Settings, AI Backends, Add
 * Provider, entry "Jan" (http://localhost:1337/v1). Afterwards the list holds
 * Jan (LOCAL) and LU Cloud. The Built-in Engine card is gone, together with
 * the BUILT-IN ENGINE (EXPERT) section, and nothing on the Jan card says where
 * the built-in engine went.
 *
 * Then the sharp edge (r10n-q1-12, r10n-q1-13): switching Jan off leaves the
 * Jan card standing with its Enable button, but now there is no local backend
 * at all. The picker says "No models available" and lists none of the three
 * installed local models, although the user never switched the built-in engine
 * off.
 *
 * The way back exists and is unlabelled: Add Provider, entry "Built-in
 * Engine". Whoever wrote "the card was completely gone, no way back" almost
 * certainly walked this path, not the Disable button of R9, which measured
 * clean in R10.
 *
 * The fix reuses the mechanic R10 built for Disable, on the slot rather than
 * on a provider id: the displaced backend keeps a greyed card with an Enable
 * button that hands the slot back. It swaps rather than forgets, so the
 * backend that just came in does not vanish as silently in its turn.
 *
 * Run: npx vitest run src/lib/__tests__/builtin-card-survives-add-provider.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  isDifferentBackend,
  slotTakeoverUpdate,
  slotHandbackUpdate,
  standbyOccupant,
  type HandoverSlot,
} from '../openai-slot-handover'
import { providerRowIds, isReturnableRow } from '../provider-visibility'
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

/** The slot as the re-measure found it before Add Provider was touched. */
const SHIPPED: HandoverSlot = { enabled: true, ...BUILTIN }

describe('THE FIX: Add Provider no longer makes the built-in card disappear', () => {
  it('the exact frame: adding Jan remembers the built-in engine it pushed out', () => {
    const update = slotTakeoverUpdate(SHIPPED, JAN)
    expect(update.name).toBe('Jan')
    expect(update.baseUrl).toBe('http://localhost:1337/v1')
    expect(update.managed).toBe(false)
    expect(update.displaced).toEqual(BUILTIN)
  })

  it('so the list still has a card to draw for the built-in engine', () => {
    const after = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    expect(standbyOccupant(after)?.name).toBe('Built-in Engine')
  })

  it('and Enable on that card hands the slot back to the built-in engine', () => {
    const after = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    const back = slotHandbackUpdate(after)!
    expect(back.name).toBe('Built-in Engine')
    expect(back.baseUrl).toBe('http://127.0.0.1:8127/v1')
    expect(back.managed).toBe(true)
    expect(back.enabled).toBe(true)
  })

  it('the handback swaps, it does not forget: Jan takes the standby card', () => {
    // R10 measured this in the other direction too: adding Built-in Engine
    // back made the Jan card disappear in its turn.
    const after = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    const restored = { ...after, ...slotHandbackUpdate(after) } as HandoverSlot
    expect(standbyOccupant(restored)?.name).toBe('Jan')
    expect(standbyOccupant(restored)?.baseUrl).toBe('http://localhost:1337/v1')
  })

  it('the sharp edge: Jan added, then Jan disabled, and the way back still stands', () => {
    // r10n-q1-12/13: the Jan card kept its Enable button, but there was no
    // local backend at all and the picker listed none of the three installed
    // local models, although nobody had switched the built-in engine off.
    const after = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    const janOff = { ...after, enabled: false, disabledByUser: true }
    // Two ways out on screen now: Enable on the Jan row it switched off,
    expect(isReturnableRow(janOff)).toBe(true)
    // and Enable on the built-in engine standing by.
    expect(standbyOccupant(janOff)?.name).toBe('Built-in Engine')
    const back = slotHandbackUpdate(janOff)!
    expect(back.name).toBe('Built-in Engine')
    expect(back.enabled).toBe(true)
    // Switching a backend off is not the same as giving up its slot, so the
    // Disable mark does not travel with the slot.
    expect(back.disabledByUser).toBe(false)
    // And Jan is not lost by taking the way back, even from the off state.
    // (`managed` is written out as an explicit false when the slot is stored,
    // where the preset simply does not carry the flag.)
    expect(back.displaced).toEqual({ ...JAN, managed: false })
  })

  it('a second takeover remembers the backend it actually pushed out', () => {
    // Jan holds the slot, LM Studio takes it: the standby card has to name
    // Jan, not the built-in engine Jan itself had displaced one step earlier.
    // Only one backend can stand by, so the memory has to move with the slot.
    const withJan = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    const withLmStudio = { ...withJan, ...slotTakeoverUpdate(withJan, LMSTUDIO) } as HandoverSlot
    expect(withLmStudio.name).toBe('LM Studio')
    expect(standbyOccupant(withLmStudio)?.name).toBe('Jan')
    expect(slotHandbackUpdate(withLmStudio)!.name).toBe('Jan')
  })

  it('a cloud preset takes the same slot and is remembered the same way', () => {
    // Every OpenAI-protocol backend shares this one slot, so Add Provider,
    // OpenRouter loses the built-in card exactly as Jan did.
    const openrouter = preset('openrouter')
    const update = slotTakeoverUpdate(SHIPPED, openrouter)
    expect(update.displaced).toEqual(BUILTIN)
    expect(update.isLocal).toBe(false)
  })
})

describe('NEGATIVE CONTROL: the counter-poles of R10 are untouched', () => {
  it('a fresh install owes no standby card', () => {
    expect(standbyOccupant(SHIPPED)).toBe(null)
    expect(slotHandbackUpdate(SHIPPED)).toBe(null)
  })

  it('onboarding handing the slot to Ollama leaves nothing behind', () => {
    // Onboarding.tsx writes openai { enabled: false, managed: false } without
    // anyone pressing anything. A slot that is already parked is not being
    // taken from the user, so nothing is remembered and no card is owed.
    const parked: HandoverSlot = { ...SHIPPED, enabled: false, managed: false }
    const update = slotTakeoverUpdate(parked, JAN)
    expect(update.displaced).toBeUndefined()
    expect(standbyOccupant({ ...parked, ...update } as HandoverSlot)).toBe(null)
  })

  it('the onboarding choice of an external backend leaves nothing behind either', () => {
    // BackendSelector and the onboarding wizard both write the slot directly,
    // not through Add Provider, and neither goes near this rule.
    const sel = read('src/components/onboarding/BackendSelector.tsx')
    const onb = read('src/components/onboarding/Onboarding.tsx')
    expect(sel).not.toMatch(/slotTakeoverUpdate|displaced/)
    expect(onb).not.toMatch(/slotTakeoverUpdate|displaced/)
  })

  it('re-selecting the backend that is already there changes nothing', () => {
    const update = slotTakeoverUpdate(SHIPPED, BUILTIN)
    expect(update.displaced).toBeUndefined()
    expect(isDifferentBackend(SHIPPED, BUILTIN)).toBe(false)
  })

  it('a trailing slash is not a different server', () => {
    expect(isDifferentBackend(SHIPPED, { ...BUILTIN, baseUrl: 'http://127.0.0.1:8127/v1/' })).toBe(false)
  })

  it('the Disable rule of R10 still decides the rows, and is not disturbed', () => {
    const afterAdd = {
      ollama: { enabled: false },
      openai: { enabled: true },
      anthropic: { enabled: false },
      'lu-cloud': { enabled: true },
    }
    // The standby card is drawn beside these rows, not inside them: the slot
    // list still holds exactly the four ids it always did.
    expect(providerRowIds(afterAdd)).toEqual(['openai', 'lu-cloud'])
  })

  it('coming back to the remembered backend by another route clears the card', () => {
    // Reset AI Backends drops the whole slot to shipped values, and Add
    // Provider on the same entry writes it directly. Neither may leave a card
    // offering a way back to where the slot already is.
    const after = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    const resetish = { ...after, ...BUILTIN, enabled: true }
    expect(standbyOccupant(resetish)).toBe(null)
  })

  it('a re-enable does not throw away a standby card that is still owed', () => {
    const after = { ...SHIPPED, ...slotTakeoverUpdate(SHIPPED, JAN) } as HandoverSlot
    const janOff = { ...after, enabled: false }
    const janOnAgain = { ...janOff, ...slotTakeoverUpdate(janOff, JAN) } as HandoverSlot
    expect(standbyOccupant(janOnAgain)?.name).toBe('Built-in Engine')
  })
})

describe('the wiring, so the rule reaches the screen', () => {
  const pane = read('src/components/settings/ProviderConfig.tsx')

  it('Add Provider writes through the rule instead of overwriting the slot', () => {
    expect(pane).toMatch(/setProviderConfig\('openai', slotTakeoverUpdate\(providers\.openai, \{/)
    // The line the re-measure hit, gone.
    expect(pane).not.toMatch(
      /setProviderConfig\('openai', \{ enabled: true, name: preset\.name, baseUrl: preset\.baseUrl/,
    )
  })

  it('the pane draws the standby card, with the badge and the Enable button', () => {
    expect(pane).toMatch(/const standby = standbyOccupant\(providers\.openai\)/)
    expect(pane).toMatch(/\{standby && \(/)
    expect(pane).toMatch(/STANDBY<\/span>/)
    expect(pane).toMatch(/onClick=\{handBackSlot\}[\s\S]{0,400}>\s*Enable\s*<\/button>/)
  })

  it('the card says WHY the backend left, in English, and names the way back', () => {
    expect(pane).toMatch(/took over the local OpenAI compatible slot/)
    expect(pane).toMatch(/Press Enable to hand the slot back to/)
  })

  it('Enable on it goes through the handback rule, not through a second mechanism', () => {
    expect(pane).toMatch(/const update = slotHandbackUpdate\(providers\.openai\)/)
    expect(pane).toMatch(/setProviderConfig\('openai', update\)/)
  })

  it('NEGATIVE CONTROL: the R10 Disable card is still there, unchanged', () => {
    expect(pane).toMatch(/if \(isReturnableRow\(config\)\)/)
    expect(pane).toMatch(/DISABLED<\/span>/)
    expect(pane).toMatch(
      /setProviderConfig\(id, \{ enabled: nextEnabled, disabledByUser: !nextEnabled \}\)/,
    )
  })

  it('NEGATIVE CONTROL: no em dash anywhere in the new copy', () => {
    const start = pane.indexOf('{standby && (')
    const end = pane.indexOf('{/* No backend warning')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(pane.slice(start, end)).not.toMatch(/[–—]/)
  })
})
