/**
 * GH #197: the pure parts of the long text field: search, the count, and the
 * kept height.
 *
 * Run: npx vitest run src/lib/__tests__/long-text-field.test.ts
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { findMatches, formatCount, readFieldHeight, writeFieldHeight, MAX_MATCHES } from '../long-text'

beforeEach(() => localStorage.clear())

describe('search', () => {
  it('finds every place, ignoring case', () => {
    expect(findMatches('Baron and the baron', 'BARON')).toEqual([{ start: 0, end: 5 }, { start: 14, end: 19 }])
    expect(findMatches('abc', '')).toEqual([])
    expect(findMatches('abc', 'x')).toEqual([])
  })

  it('stops counting at a cap, so one letter in a huge prompt stays cheap', () => {
    expect(findMatches('a'.repeat(20_000), 'a')).toHaveLength(MAX_MATCHES)
  })

  it('a 40,000 token prompt (160,000 characters) is searched in well under a frame', () => {
    const text = 'The baron walks slowly through the hall. '.repeat(4000)
    const t0 = performance.now()
    const hits = findMatches(text, 'hall')
    expect(hits).toHaveLength(4000)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('count', () => {
  it('groups thousands the same way everywhere', () => {
    expect(formatCount(160000)).toBe('160,000')
    expect(formatCount(999)).toBe('999')
  })
})

describe('the kept height', () => {
  it('remembers per field and ignores nonsense', () => {
    expect(readFieldHeight('persona-prompt')).toBeUndefined()
    writeFieldHeight('persona-prompt', 412.4)
    expect(readFieldHeight('persona-prompt')).toBe(412)
    expect(readFieldHeight('persona-reminder')).toBeUndefined()
    writeFieldHeight('persona-prompt', 5)
    expect(readFieldHeight('persona-prompt')).toBe(412)
    localStorage.setItem('lu-long-text-height:x', 'abc')
    expect(readFieldHeight('x')).toBeUndefined()
  })
})
