/**
 * A37, Discord "Ghidra and REA", xxcoder, 26.10.2026 (Qwen 3.8 27B on REA):
 *
 *   "Let me first check the file details and set up the project.
 *    Let me create the project and run analysis. I'll use the analyzeHeadless script.
 *    Let me first check the file details and set up the project. ..."
 *
 * Two lines in alternation, the docs read again between them with varying
 * calls. Detector 4 only halted on the SAME text three times IN A ROW, so this
 * ran until the user stopped it. The window steers the third time a plan comes
 * back and halts the fourth; a short line in an edit-test cycle is left alone.
 *
 * Run: npx vitest run src/lib/__tests__/loop-guard-a-plan-in-alternation.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { AgentLoopGuard } from '../agent-loop-guard'

const A = 'Let me first check the file details and set up the project.'
const B = "Let me create the project and run analysis. I'll use the analyzeHeadless script."

describe('a plan that comes back in alternation', () => {
  it('is steered on its third time and halted on its fourth', () => {
    const g = new AgentLoopGuard()
    const seen = [A, B, A, B, A, B, A].map((t) => g.recordNarration(t).action)
    expect(seen.slice(0, 4)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(seen[4]).toBe('steer')
    expect(seen[5]).toBe('steer')
    expect(seen[6]).toBe('halt')
  })

  it('the steer quotes the plan and asks for the next tool call, the halt says what happened', () => {
    const g = new AgentLoopGuard()
    let steer = ''
    let halt = ''
    for (const t of [A, B, A, B, A, B, A]) {
      const v = g.recordNarration(t)
      if (v.action === 'steer' && !steer) steer = v.message
      if (v.action === 'halt') halt = v.reason
    }
    expect(steer).toMatch(/same plan 3 times/)
    expect(steer).toContain('Let me first check the file details')
    expect(steer).toMatch(/next concrete tool call now/)
    expect(halt).toMatch(/same plan 4 times .* kept starting over/)
  })

  it('a short line repeated in an edit-test cycle is not a plan', () => {
    const g = new AgentLoopGuard()
    const lines = ['Now run the tests.', 'Fixing the import in auth.ts now.', 'Now run the tests.', 'Fixing the import in auth.ts now.',
      'Now run the tests.', 'Fixing the import in auth.ts now.', 'Now run the tests.']
    expect(lines.map((t) => g.recordNarration(t).action).every((a) => a === 'ok')).toBe(true)
  })

  it('plans that differ each time are left alone', () => {
    const g = new AgentLoopGuard()
    const lines = Array.from({ length: 12 }, (_, i) => `Let me open procedure number ${i} and decompile it to C for the project.`)
    expect(lines.map((t) => g.recordNarration(t).action).every((a) => a === 'ok')).toBe(true)
  })

  it('three in a row are warned, the fourth halts (C59 A5)', () => {
    const g = new AgentLoopGuard()
    expect([A, A, A, A].map((t) => g.recordNarration(t).action)).toEqual(['ok', 'ok', 'steer', 'halt'])
  })

  it('both loops pass a narration steer on instead of dropping it', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const f of ['useCodex.ts', 'useAgentChat.ts']) {
      const src = readFileSync(resolve(here, '../../hooks', f), 'utf8')
      expect(src, f).toMatch(/const batchVerdict = recordedVerdict\.action === 'ok' \? narrationVerdict : recordedVerdict/)
    }
  })
})
