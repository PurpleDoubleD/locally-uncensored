import { describe, it, expect } from 'vitest'
import { parseForRunner, renderResult, sniffRunner } from '../test-runner'

// CA bench CO10 (14.11.): `npm test` ran `node --test`, six tests green, and
// the step was headed "NO TESTS / UNPARSEABLE (unknown): 0/0 passed".
const SPEC_GREEN = `
> test
> node --test

✔ get returns what was set (0.30075ms)
✔ missing key is undefined (0.0545ms)
✔ evicts the least recently used (0.08ms)
✔ set on an existing key refreshes it (0.05ms)
✔ size counts entries (0.04ms)
✔ delete removes (0.04ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32.5`

const TAP_RED = `TAP version 13
ok 1 - get returns what was set
not ok 2 - evicts the least recently used
1..2
# tests 2
# pass 1
# fail 1`

describe('a test run behind npm test', () => {
  it('reads a green node --test run as passed', () => {
    const r = parseForRunner('unknown', SPEC_GREEN)
    expect(r.runner).toBe('node')
    expect(r.passed).toBe(true)
    expect(r.passedCount).toBe(6)
    expect(renderResult(r, 0)).toMatch(/^PASSED \(node\): 6\/6 passed, 0 failed\./)
  })

  it('names the failing test in TAP output', () => {
    const r = parseForRunner('unknown', TAP_RED)
    expect(r.passed).toBe(false)
    expect(r.failedCount).toBe(1)
    expect(r.failedTests).toEqual(['evicts the least recently used'])
  })

  it('falls back to the exit code, not "NO TESTS", when no summary is known', () => {
    expect(sniffRunner('all good\n')).toBe('unknown')
    const r = parseForRunner('unknown', 'all good\n')
    expect(renderResult(r, 0)).toMatch(/^RAN \(exit 0\)/)
    expect(renderResult(r, 2)).toMatch(/^FAILED \(exit 2\)/)
    expect(renderResult(r)).toMatch(/^NO TESTS/)
  })

  it('still reads the runners it knew', () => {
    expect(sniffRunner(' Tests  2 failed | 10 passed (12)')).toBe('vitest')
    expect(sniffRunner('test result: ok. 3 passed; 0 failed; 0 ignored')).toBe('cargo')
    expect(sniffRunner('===== 4 passed in 0.1s =====')).toBe('pytest')
  })
})
