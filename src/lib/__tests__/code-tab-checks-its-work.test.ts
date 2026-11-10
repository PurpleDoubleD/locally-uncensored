/** C59 A5: a Code run that changed files and checked nothing is told once to run a check. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCheckCommand, newVerifyState, recordVerifyRound, verifyNudgeDue } from '../verify-nudge'

const opts = { readOnly: false, reviewMode: false }

describe('verify before done', () => {
  it('knows a check command when it sees one', () => {
    for (const c of ['npm test', 'node --test', 'npx vitest run', 'pytest -q', 'cargo check', 'npx tsc --noEmit', 'npm run build', 'python3 -I slugify.py "Hallo Welt"', 'make']) {
      expect(isCheckCommand(c), c).toBe(true)
    }
    for (const c of ['ls -la', 'git status', 'cat package.json', 'mkdir -p out', 'mv a b']) {
      expect(isCheckCommand(c), c).toBe(false)
    }
  })

  it('a write without a check after it asks once; a check clears it', () => {
    const s = newVerifyState()
    recordVerifyRound(s, [{ name: 'file_edit', failed: false }])
    expect(verifyNudgeDue(s, opts)).toBe(true)
    expect(verifyNudgeDue(s, opts)).toBe(false)

    const t = newVerifyState()
    recordVerifyRound(t, [{ name: 'file_write', failed: false }, { name: 'shell_execute', failed: false, command: 'node --test' }])
    expect(verifyNudgeDue(t, opts)).toBe(false)
  })

  it('a failed write, a read-only run or a review never asks', () => {
    const s = newVerifyState()
    recordVerifyRound(s, [{ name: 'file_edit', failed: true }])
    expect(verifyNudgeDue(s, opts)).toBe(false)
    const r = newVerifyState()
    recordVerifyRound(r, [{ name: 'file_edit', failed: false }])
    expect(verifyNudgeDue(r, { readOnly: true, reviewMode: false })).toBe(false)
    expect(verifyNudgeDue(r, { readOnly: false, reviewMode: true })).toBe(false)
  })

  it('the Code loop feeds and asks it', () => {
    const src = readFileSync(resolve(__dirname, '../../hooks/useCodex.ts'), 'utf8')
    expect(src).toMatch(/recordVerifyRound\(verifyState, results\.map/)
    expect(src).toMatch(/if \(verifyNudgeDue\(verifyState, \{ readOnly: readOnlyTurn, reviewMode \}\)\)/)
  })
})
