/**
 * CA, cloud loops: the Agent tab names the repeats it did not run again, and
 * a re-ordered copy of a call is the same call.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { canonicalArgs, repeatLabel, skippedRepeatsNote } from '../repeat-note'

describe('canonicalArgs', () => {
  it('key order and outer spaces do not make a new call', () => {
    expect(canonicalArgs({ path: 'a.ts', limit: 5 })).toBe(canonicalArgs({ limit: 5, path: ' a.ts ' }))
    expect(canonicalArgs({ q: { b: 1, a: [{ y: 2, x: 1 }] } })).toBe(canonicalArgs({ q: { a: [{ x: 1, y: 2 }], b: 1 } }))
  })

  it('different values stay different', () => {
    expect(canonicalArgs({ path: 'a.ts' })).not.toBe(canonicalArgs({ path: 'b.ts' }))
    expect(canonicalArgs(undefined)).toBe('{}')
  })
})

describe('skippedRepeatsNote', () => {
  it('nothing skipped, nothing said', () => {
    expect(skippedRepeatsNote([])).toBeNull()
  })

  it('names every skipped call and says the result is above', () => {
    const note = skippedRepeatsNote([repeatLabel('file_read', { path: 'src/a.ts' })])!
    expect(note).toContain('file_read {"path":"src/a.ts"}')
    expect(note).toMatch(/result is above/)
  })

  it('keeps a long argument list short', () => {
    expect(repeatLabel('code_execute', { code: 'x'.repeat(500) }).length).toBeLessThan(140)
  })
})

describe('the Agent loop uses it', () => {
  const src = readFileSync(new URL('../../../hooks/useAgentChat.ts', import.meta.url), 'utf8')
  it('compares canonical arguments', () => {
    expect(src).toMatch(/tc\.function\.name \+ '\|' \+ canonicalArgs\(tc\.function\.arguments\)/)
  })
  it('names a partial repeat after the results', () => {
    expect(src).toMatch(/skippedRepeats\.push\(repeatLabel\(name, tc\.function\.arguments\)\)/)
    expect(src.indexOf('skippedRepeatsNote(skippedRepeats)')).toBeGreaterThan(src.indexOf('Now the steer sits AFTER the calls it refers to'))
  })
})
