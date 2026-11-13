/**
 * A run of rounds that only ever fail is a stall, and nothing caught it.
 *
 * Measured on the installed 2.6.2 Windows build, Coding surface, Ollama with
 * the hermes schema, 2026-08-06. One git command failed with "dubious
 * ownership" and the model then fired 18 shell_execute calls in a row trying
 * to repair file permissions, alternating between two spellings:
 *
 *   icacls "…\lu-matrix-sandbox" /grant Everyone=RX
 *   icacls "…\lu-matrix-sandbox" /grant Everyone=R,X
 *   icacls "…\lu-matrix-sandbox" /grant Everyone=(RX)
 *   …
 *
 * Six minutes of a nine-minute run, and the plan never got past step 19.
 *
 * Why the four existing detectors all missed it:
 *   1 needs three byte-identical batches BACK TO BACK, the spelling wobbled
 *   2 and 3 are scoped to READ_ONLY_TOOLS, and shell_execute is not one
 *   4 needs byte-identical narration, and the thinking text differed each time
 *
 * The signal they all lack is the result. A failing command changes nothing,
 * so the next round starts where the last one did.
 *
 * Run: npx vitest run src/lib/__tests__/loop-guard-failing-rounds.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { AgentLoopGuard } from '../agent-loop-guard'

const read = (p: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')

const fail = (name = 'shell_execute', error = 'Access is denied.') => [{ name, failed: true, error }]
const ok = (name = 'shell_execute') => [{ name, failed: false }]

describe('the icacls run from the R26 measurement', () => {
  // The real argument sequence, so the test fails if someone ever makes the
  // detector depend on the arguments again.
  const REAL_ARGS = [
    'icacls C:\\\\…\\\\lu-matrix-sandbox /grant Everyone=F',
    'icacls C:\\\\…\\\\lu-matrix-sandbox /grant Everyone=(RX)',
    'icacls "C:\\\\…\\\\lu-matrix-sandbox" /grant Everyone=RX',
    'icacls "C:\\\\…\\\\lu-matrix-sandbox" /grant Everyone=R,X',
    'icacls "C:\\\\…\\\\lu-matrix-sandbox" /grant Everyone=(RX)',
    'icacls "C:\\\\…\\\\lu-matrix-sandbox" /grant Everyone=R,X',
  ]

  it('NEGATIVE CONTROL: the call-shape detectors never fire on it', () => {
    // The model wrote a new line before every attempt in the measurement, so
    // detector 8 (silent near-copies, C83) stays out of it as well.
    const g = new AgentLoopGuard()
    REAL_ARGS.forEach((args, i) => {
      g.recordNarration(`Trying permission variant number ${i + 1} on the sandbox folder.`)
      expect(g.recordBatch([{ name: 'shell_execute', args }]).action).toBe('ok')
    })
  })

  it('silent, the same six calls meet detector 8 on the fifth (C83)', () => {
    const g = new AgentLoopGuard()
    const actions = REAL_ARGS.map((args) => g.recordBatch([{ name: 'shell_execute', args }]).action)
    expect(actions).toEqual(['ok', 'ok', 'ok', 'ok', 'steer', 'ok'])
  })

  it('but the result detector halts on the sixth failing round', () => {
    const g = new AgentLoopGuard()
    const verdicts = REAL_ARGS.map((args) => {
      g.recordBatch([{ name: 'shell_execute', args }])
      return g.recordResults(fail())
    })
    expect(verdicts.slice(0, 2).map((v) => v.action)).toEqual(['ok', 'ok'])
    expect(verdicts[2].action).toBe('steer')
    expect(verdicts[3].action).toBe('ok')
    expect(verdicts[4].action).toBe('ok')
    expect(verdicts[5].action).toBe('halt')
    expect(verdicts[5].action === 'halt' && verdicts[5].reason).toMatch(/6 rounds in a row/)
  })

  it('the steer quotes the error instead of just scolding', () => {
    const g = new AgentLoopGuard()
    g.recordResults(fail())
    g.recordResults(fail())
    const v = g.recordResults(fail('shell_execute', 'detected dubious ownership in repository'))
    expect(v.action).toBe('steer')
    expect(v.action === 'steer' && v.message).toMatch(/dubious ownership/)
    expect(v.action === 'steer' && v.message).toMatch(/move on to the next step/)
  })
})

describe('what it must NOT punish', () => {
  it('edit, test, edit, test survives even when every test fails', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 10; i++) {
      expect(g.recordResults(ok('file_edit')).action).toBe('ok')
      expect(g.recordResults(fail('run_tests', 'AssertionError')).action).toBe('ok')
    }
  })

  it('a model that fixes its command on the third try is never halted', () => {
    const g = new AgentLoopGuard()
    expect(g.recordResults(fail()).action).toBe('ok')
    expect(g.recordResults(fail()).action).toBe('ok')
    expect(g.recordResults(fail()).action).toBe('steer')
    expect(g.recordResults(ok()).action).toBe('ok')
    // and the budget is fully restored, not merely reduced
    expect(g.recordResults(fail()).action).toBe('ok')
    expect(g.recordResults(fail()).action).toBe('ok')
    expect(g.recordResults(fail()).action).toBe('steer')
  })

  it('a batch where one of several calls succeeded is progress', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 8; i++) {
      const v = g.recordResults([
        { name: 'shell_execute', failed: true, error: 'nope' },
        { name: 'file_read', failed: false },
      ])
      expect(v.action).toBe('ok')
    }
  })

  it('an empty round says nothing either way', () => {
    expect(new AgentLoopGuard().recordResults([]).action).toBe('ok')
  })
})

// ── G36 (R18b witness, 2026-08-07) ─────────────────────────────────────────
// Detector 5 resets on ANY success in the round, and the create-vite grind
// interleaved every failing retry with a file_list that worked: 15/30 minutes
// of circling, detector 5 at zero the whole time. Detector 6 keys failures on
// the executable itself and only lets a successful MUTATION clear them.
describe('G36: variants of the same failing executable', () => {
  const shellFail = (command: string, error = 'Operation cancelled') =>
    ({ name: 'shell_execute', failed: true, error, args: { command } })
  const readOk = () => ({ name: 'file_list', failed: false })

  // The real R18b shape: every failing npm variant rides with a read success.
  const R18B_VARIANTS = [
    'npm init vite@latest . -- --template react-ts',
    'npm install -g create-vite',
    'npm exec create-vite scratch/demo',
    'npm create vite@latest scratch/demo',
    'npm init vite@latest scratch/demo --yes',
    'npm create-vite . --template vanilla',
  ]

  it('steers on the 3rd and halts on the 6th failing variant despite read successes', () => {
    const g = new AgentLoopGuard()
    const verdicts = R18B_VARIANTS.map((cmd) => g.recordResults([shellFail(cmd), readOk()]))
    expect(verdicts.slice(0, 2).map((v) => v.action)).toEqual(['ok', 'ok'])
    expect(verdicts[2].action).toBe('steer')
    expect(verdicts[2].action === 'steer' && verdicts[2].message).toMatch(/'npm'/)
    expect(verdicts[2].action === 'steer' && verdicts[2].message).toMatch(/MOVE ON/)
    expect(verdicts[3].action).toBe('ok')
    expect(verdicts[4].action).toBe('ok')
    expect(verdicts[5].action).toBe('halt')
    expect(verdicts[5].action === 'halt' && verdicts[5].reason).toMatch(/6 failed 'npm' commands/)
  })

  it('pools path and extension spellings into one executable', () => {
    const g = new AgentLoopGuard()
    g.recordResults([shellFail('npm ci')])
    g.recordResults([shellFail('C:\\nodejs\\npm.CMD ci')])
    const v = g.recordResults([shellFail('/usr/local/bin/npm ci')])
    expect(v.action).toBe('steer')
  })

  it('different executables keep separate streaks', () => {
    const g = new AgentLoopGuard()
    expect(g.recordResults([shellFail('npm ci'), readOk()]).action).toBe('ok')
    expect(g.recordResults([shellFail('npx create-vite'), readOk()]).action).toBe('ok')
    expect(g.recordResults([shellFail('icacls . /grant x'), readOk()]).action).toBe('ok')
    expect(g.recordResults([shellFail('npm ci -f'), readOk()]).action).toBe('ok')
  })

  it('NEGATIVE CONTROL: a retry after a real fix starts a fresh streak', () => {
    // fail, EDIT (mutation succeeded), fail, EDIT, ... is a legitimate
    // edit-test cycle on the shell runner and must never steer or halt.
    const g = new AgentLoopGuard()
    for (let i = 0; i < 10; i++) {
      expect(g.recordResults([shellFail('node --test test/')]).action).toBe('ok')
      expect(g.recordResults([{ name: 'file_edit', failed: false }]).action).toBe('ok')
    }
  })

  it('NEGATIVE CONTROL: read-only successes do NOT reset the streak', () => {
    const g = new AgentLoopGuard()
    g.recordResults([shellFail('npm ci'), { name: 'file_read', failed: false }])
    g.recordResults([shellFail('npm ci --force'), { name: 'git_status', failed: false }])
    const v = g.recordResults([shellFail('npm ci --legacy-peer-deps'), readOk()])
    expect(v.action).toBe('steer')
  })

  it('NEGATIVE CONTROL: without a command in the args the detector stays out', () => {
    // The pre-G36 no-args behaviour is untouched: interleaved read successes
    // keep detector 5 quiet and nothing else may fire.
    const g = new AgentLoopGuard()
    for (let i = 0; i < 8; i++) {
      expect(g.recordResults([{ name: 'shell_execute', failed: true, error: 'x' }, readOk()]).action).toBe('ok')
    }
  })

  it('the hooks hand the dispatched args through', () => {
    for (const f of ['../../hooks/useCodex.ts', '../../hooks/useAgentChat.ts']) {
      expect(read(f)).toMatch(/error: r\.error \?\? [^\n]*, args: r\.dispatchedArgs/)
    }
  })
})

describe('both agent loops feed it', () => {
  for (const f of ['../../hooks/useCodex.ts', '../../hooks/useAgentChat.ts']) {
    // The real status includes a failure the tool reported as text
    // (resultFailed, bug hunt 01.10.2026; loop-guard-sees-text-failures.test.ts).
    it(`${f.split('/').pop()} calls recordResults with the real statuses`, () => {
      const src = read(f)
      expect(src).toMatch(/loopGuard\.recordResults\(/)
      expect(src).toMatch(/failed: resultFailed\(r\)/)
      expect(src).toMatch(/failVerdict\.action === 'halt'/)
      expect(src).toMatch(/failVerdict\.action === 'steer'/)
    })
  }
})
