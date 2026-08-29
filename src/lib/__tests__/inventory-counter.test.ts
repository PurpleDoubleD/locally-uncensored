/**
 * Befund 2 of the abnahme counter-check on the 2.6.7 Windows build
 * (2026-08-29, ergebnis-abnahme-durchklick.md).
 *
 * Opening the Models page showed the Installed tab reading "Installed 0" while
 * three cards on the same page read Installed, and the rail carried "Chat 2"
 * with no badge for Image and none for Video. Measured again after a restart:
 * at 1.2 seconds the two badges were still missing, at 5.2 seconds they were
 * right. Nothing stayed wrong. But for those seconds the page stated a number
 * it had not counted, and a stated zero is a claim: you own none of these.
 *
 * The rule: a counter shows a number only once there is a number. Until then
 * it shows that it is counting.
 *
 * Run: npx vitest run src/lib/__tests__/inventory-counter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { counterView } from '../inventory-counter'

const here = dirname(fileURLToPath(import.meta.url))
const manager = readFileSync(resolve(here, '../../components/models/ModelManager.tsx'), 'utf8')

describe('a counter never states a number it has not counted', () => {
  it('THE FIX: nothing loaded yet is a loading mark, not a 0', () => {
    expect(counterView(0, { loaded: false, refreshing: false })).toEqual({ kind: 'loading' })
    expect(counterView(0, { loaded: false, refreshing: true })).toEqual({ kind: 'loading' })
  })

  it('THE FIX: the exact counter-check frame, a lane still being read', () => {
    // A first pass landed (chat models arrived, hence loaded) while a second
    // is still running for the ComfyUI lanes. That is the 1.2-second frame.
    expect(counterView(0, { loaded: true, refreshing: true })).toEqual({ kind: 'loading' })
  })

  it('a counted zero is shown, because then it is the truth', () => {
    expect(counterView(0, { loaded: true, refreshing: false })).toEqual({ kind: 'count', value: 0 })
  })

  it('a number that exists is shown immediately, refresh or not', () => {
    // The 5.2-second frame, and every frame after it.
    expect(counterView(3, { loaded: true, refreshing: false })).toEqual({ kind: 'count', value: 3 })
    expect(counterView(3, { loaded: true, refreshing: true })).toEqual({ kind: 'count', value: 3 })
    // And a stale-but-real count beats a loading mark even before the first
    // list of this session landed: a number on screen is never hidden.
    expect(counterView(8, { loaded: false, refreshing: true })).toEqual({ kind: 'count', value: 8 })
  })

  it('NEGATIVE CONTROL: a settled empty inventory is not dressed up as loading forever', () => {
    // ComfyUI is simply not installed. The page has to be allowed to say 0,
    // or the spinner becomes the new lie.
    expect(counterView(0, { loaded: true, refreshing: false }).kind).toBe('count')
  })
})

describe('the Models page routes both counters through the one rule', () => {
  it('the rail badge asks counterView', () => {
    expect(manager).toMatch(/const badge = counterView\(models\.filter\(\(m\) => m\.type === key\)\.length, inventoryState\)/)
  })

  it('the Installed badge asks counterView', () => {
    expect(manager).toMatch(/counterView\(filteredModels\.length, inventoryState\)/)
  })

  it('NEGATIVE CONTROL: neither counter prints a bare list length any more', () => {
    // This is the shape that put "Installed 0" on the screen.
    expect(manager).not.toMatch(/tabular-nums">\{filteredModels\.length\}</)
    expect(manager).not.toMatch(/\{count > 0 && \(/)
  })

  it('the empty state waits for the count too, because it makes the same claim', () => {
    expect(manager).toContain('Reading your installed models')
  })

  it('the loading mark carries a label, so it is not a mute flicker', () => {
    expect(manager).toMatch(/aria-label=\{label\}/)
  })
})
