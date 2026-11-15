/**
 * CA (14.11.2026), measured with LU's own engine: the reports were not where
 * the model looked, and it sent the same `find` nine times in 26 calls. Every
 * shell call counted as a possible change and reset the read counter, so only
 * four identical calls in a row ended it. Inspection-only commands count as
 * reads now.
 */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard, isInspectionShell } from '../agent-loop-guard'

const sh = (command: string) => ({ name: 'shell_execute', args: JSON.stringify({ command, cwd: '/ws/LP1', timeout: 60000 }) })

describe('isInspectionShell', () => {
  it('reads', () => {
    for (const c of [
      'find . -type f -name "*.json" 2>/dev/null',
      'find . -type d 2>/dev/null | head -20',
      'ls -la',
      'grep -rn "slugify" src | head',
      'cat package.json',
      'git status',
      'wc -l src/*.ts',
    ]) expect(isInspectionShell(JSON.stringify({ command: c })), c).toBe(true)
  })

  it('anything that can write or chain is not a read', () => {
    for (const c of [
      'find . -name "*.tmp" -delete',
      'find . -name "*.js" -exec rm {} +',
      'find . | xargs rm',
      'ls > listing.txt',
      'cat a.txt; rm b.txt',
      'ls && npm install',
      'echo $(whoami)',
      'mkdir -p data/reports && ls -la data/reports',
      'npm test',
      'sed -i s/a/b/ f.txt',
      'cat x | tee y',
    ]) expect(isInspectionShell(JSON.stringify({ command: c })), c).toBe(false)
  })
})

describe('the measured run', () => {
  // The order of the real trace (loop-nachher-lokal LP2), shell calls only.
  const TRACE = [
    'find . -type d -name "reports" 2>/dev/null',
    'find . -name "*.json" -type f 2>/dev/null',
    'ls -la',
    'find . -type d 2>/dev/null | head -20',
    'find . -type d -name "data" 2>/dev/null',
    'find . -type f -name "*.json" 2>/dev/null',
    'find . -type f \\( -name "*.json" -o -name "*report*" \\) 2>/dev/null',
    'find . -type d 2>/dev/null',
    'find . -type f -name "*.json" 2>/dev/null',
    'find . -type f -name "*.json" 2>/dev/null',
    'find . -type d -name "reports" 2>/dev/null',
    'find . -type d 2>/dev/null',
    'find . -type f -name "*.json" 2>/dev/null',
    'find . -type f -name "*.json" 2>/dev/null',
  ]

  it('steers at the third identical find and ends at the fifth, not after 25 calls', () => {
    const g = new AgentLoopGuard()
    const verdicts: string[] = []
    for (const c of TRACE) {
      const v = g.recordBatch([sh(c)])
      verdicts.push(v.action)
      if (v.action === 'halt') break
    }
    // The json find is at 5, 8, 9, 12 and 13: steer at its third; the halt comes
    // by its fifth at the latest (the window detector may end it a step sooner).
    expect(verdicts.indexOf('steer')).toBe(9)
    expect(verdicts[verdicts.length - 1]).toBe('halt')
    expect(verdicts.length).toBeLessThanOrEqual(14)
  })
})
