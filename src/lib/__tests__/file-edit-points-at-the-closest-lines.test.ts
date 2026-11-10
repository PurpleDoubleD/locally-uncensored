/** C59 A5: a missed old_string gets the closest lines with their number back. */
import { describe, it, expect } from 'vitest'
import { closestLines } from '../surgical-edit'

const FILE = Array.from({ length: 1500 }, (_, i) => (i === 1199 ? 'export const RETRY_LIMIT = 3' : `export const value${i + 1} = ${i + 1}`)).join('\n')

describe('closestLines', () => {
  it('finds the line a near miss meant, with its number', () => {
    expect(closestLines(FILE, 'export const RETRY_LIMIT=3')).toEqual({
      line: 1200, text: 'export const RETRY_LIMIT = 3\nexport const value1201 = 1201\nexport const value1202 = 1202',
    })
    expect(closestLines('a\n  if (x) {\n    run()\n  }\n', '\n if (x){\n run()')?.line).toBe(2)
  })

  it('offers nothing when nothing is close', () => {
    expect(closestLines(FILE, 'function totallyDifferent(arg) { return arg * 42 }')).toBeNull()
    expect(closestLines(FILE, '   \n  ')).toBeNull()
  })
})
