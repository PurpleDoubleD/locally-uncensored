/**
 * C83: an agent loop ate a user's credits.
 *
 * A support case, 10.11.2026 09-10Z, LU Cloud direct/deepseek-v4.1-flash: 233 tool
 * calls in one run, one every ~4 s, no text from the model at all, and every
 * request carried 420-447k tokens of input. The arguments were 487-492
 * characters long and never byte-identical, so the guard (3 identical calls)
 * never fired. ~214k credits were refunded by hand.
 *
 * The incident's exact arguments are not in our logs, only their shape, so
 * the calls below are rebuilt to it: one tool, ~490 characters of arguments,
 * a few characters wobbling from call to call.
 *
 * Run: npx vitest run src/lib/__tests__/c83-agent-loop-credits.test.ts
 */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard, argSimilarity } from '../agent-loop-guard'
import { AgentCostBrake, LARGE_REQUEST_TOKENS, RUN_HALT_TOKENS } from '../agent-cost-brake'

/** One call of the incident's shape: the same script, a wobbling detail. */
function incidentArgs(i: number): string {
  const variants = ['data', 'result', 'output', 'rows']
  const code =
    `import json, os\n` +
    `path = os.path.join(os.getcwd(), "report_${i % 3}.json")\n` +
    `with open(path, "r", encoding="utf-8") as f:\n` +
    `    ${variants[i % variants.length]} = json.load(f)\n` +
    `items = [x for x in ${variants[i % variants.length]}.get("items", []) if x.get("status") == "open"]\n` +
    `summary = {"count": len(items), "first": items[0] if items else None, "last": items[-1] if items else None}\n` +
    `print(json.dumps(summary, indent=2, ensure_ascii=False))\n` +
    `# check ${i % 2 ? 'again' : 'anew'} whether the export finished\n`
  return JSON.stringify({ language: 'python', code, timeout: 60 })
}

/** The model's text per step: none at all, as in the incident. */
const SILENT = ''

describe('C83: the incident shape', () => {
  it('rebuilt arguments really are ~490 characters and never identical', () => {
    const args = Array.from({ length: 12 }, (_, i) => incidentArgs(i))
    for (const a of args) expect(a.length).toBeGreaterThanOrEqual(480)
    for (const a of args) expect(a.length).toBeLessThanOrEqual(500)
    expect(new Set(args.slice(0, 2)).size).toBe(2)
    expect(argSimilarity(args[0], args[1])).toBeGreaterThan(0.85)
  })

  it('the guard steers on the 5th silent near-copy and halts on the 8th, not the 233rd', () => {
    const g = new AgentLoopGuard()
    const verdicts = Array.from({ length: 233 }, (_, i) => {
      g.recordNarration(SILENT)
      return g.recordBatch([{ name: 'code_execute', args: incidentArgs(i) }])
    })
    const firstSteer = verdicts.findIndex((v) => v.action === 'steer')
    const firstHalt = verdicts.findIndex((v) => v.action === 'halt')
    expect(firstSteer).toBe(4)
    expect(firstHalt).toBe(7)
    const halt = verdicts[firstHalt]
    expect(halt.action === 'halt' && halt.reason).toMatch(/8 nearly identical code_execute calls in a row/)
  })

  it('a model that still writes something new each step is not stopped by the near-copy detector', () => {
    const g = new AgentLoopGuard()
    const lines = [
      'The first report is still empty, I will look again after the export.',
      'Now the second report has 4 open items, checking the third one next.',
      'Third report loaded. Totals do not match yet, comparing with the list.',
      'Found the mismatch: two items were counted twice. Checking the fix.',
      'The fix holds for report 0. Running the same check on report 1 now.',
      'Report 1 matches too. Last one, report 2, then I write the summary.',
      'All three reports match. One final read of report 0 to confirm totals.',
      'Confirmed. Everything matches; writing the summary for you below.',
    ]
    const actions = lines.map((line, i) => {
      g.recordNarration(line)
      return g.recordBatch([{ name: 'code_execute', args: incidentArgs(i) }]).action
    })
    expect(actions).not.toContain('halt')
    expect(actions).not.toContain('steer')
  })

  it('the C44 switch still turns it off', () => {
    const g = new AgentLoopGuard({ enabled: false })
    for (let i = 0; i < 233; i++) {
      g.recordNarration(SILENT)
      expect(g.recordBatch([{ name: 'code_execute', args: incidentArgs(i) }]).action).toBe('ok')
    }
  })
})

describe('C83: no false alarms from detector 8', () => {
  it('paging through a file (only the offset changes) is not a loop', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 12; i++) {
      g.recordNarration(SILENT)
      const v = g.recordBatch([{ name: 'file_read', args: JSON.stringify({ path: 'src/big-module.ts', offset: i * 200, limit: 200 }) }])
      expect(v.action).toBe('ok')
    }
  })

  it('edit → test → edit → test alternates tools and never counts', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 10; i++) {
      g.recordNarration(SILENT)
      expect(g.recordBatch([{ name: 'file_edit', args: JSON.stringify({ path: 'src/a.ts', old: `x = ${i}`, new: `x = ${i + 1}` }) }]).action).not.toBe('halt')
      g.recordNarration(SILENT)
      expect(g.recordBatch([{ name: 'shell_execute', args: JSON.stringify({ command: 'npm test' }) }]).action).not.toBe('halt')
    }
  })

  it('clearly different arguments to the same tool are separate steps', () => {
    const g = new AgentLoopGuard()
    const files = ['README.md', 'src/main.ts', 'package.json', 'docs/guide/setup.md', 'tests/unit/a.spec.ts', 'scripts/release.sh', 'src-tauri/Cargo.toml', '.github/workflows/ci.yml', 'vite.config.ts']
    for (const path of files) {
      g.recordNarration(SILENT)
      expect(g.recordBatch([{ name: 'file_write', args: JSON.stringify({ path, content: `contents of ${path}` }) }]).action).toBe('ok')
    }
  })

  it('web searches keep their own, wider ladder', () => {
    const g = new AgentLoopGuard()
    const actions = Array.from({ length: 6 }, (_, i) => {
      g.recordNarration(SILENT)
      return g.recordBatch([{ name: 'web_search', args: JSON.stringify({ query: `deepseek flash pricing per token ${i}` }) }]).action
    })
    expect(actions.slice(0, 5)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(actions[5]).toBe('steer')
  })
})

describe('C83: the cost brake', () => {
  const incidentInput = (i: number) => 420_000 + ((i * 7919) % 27_000)

  it('the incident (420-447k per call) warns on the first call and halts within 8 calls', () => {
    const b = new AgentCostBrake({ paid: true })
    const verdicts = Array.from({ length: 233 }, (_, i) => {
      b.record(incidentInput(i))
      return b.take()
    })
    expect(verdicts[0].action).toBe('warn')
    expect(verdicts[0].action === 'warn' && verdicts[0].message).toMatch(/Large request: this step sent 4\d\dk tokens/)
    const firstHalt = verdicts.findIndex((v) => v.action === 'halt')
    expect(firstHalt).toBeGreaterThan(0)
    expect(firstHalt).toBeLessThan(8)
    const h = verdicts[firstHalt]
    expect(h.action === 'halt' && h.message).toMatch(/Stopped to protect your credits: this run has sent 2\.\dM tokens/)
    expect(h.action === 'halt' && h.message).toMatch(/Send a new message to go on/)
  })

  it('a normal paid run (32k send window, 60 steps) is never stopped', () => {
    const b = new AgentCostBrake({ paid: true })
    for (let i = 0; i < 60; i++) {
      b.record(30_000)
      expect(b.take().action).toBe('ok')
    }
    expect(b.inputTokens).toBe(1_800_000)
  })

  it('local and LAN models cost nothing per token and are never braked', () => {
    const b = new AgentCostBrake({ paid: false })
    for (let i = 0; i < 50; i++) {
      b.record(500_000)
      expect(b.take().action).toBe('ok')
    }
  })

  it('with the loop guard switched off (C44) the brake only tells, once', () => {
    const b = new AgentCostBrake({ paid: true, loopGuardEnabled: false })
    const actions = Array.from({ length: 40 }, () => {
      b.record(LARGE_REQUEST_TOKENS + 10_000)
      return b.take().action
    })
    expect(actions).not.toContain('halt')
    expect(actions.filter((a) => a === 'warn')).toHaveLength(2) // large request + passed the limit
  })

  it('calls without a reported count add nothing, the brake never guesses', () => {
    const b = new AgentCostBrake({ paid: true })
    for (let i = 0; i < 100; i++) b.record(undefined)
    b.record(0)
    expect(b.inputTokens).toBe(0)
    expect(b.take().action).toBe('ok')
    // CA (14.11.2026): 3M let the incidents of that week through.
    expect(RUN_HALT_TOKENS).toBe(2_000_000)
  })
})
