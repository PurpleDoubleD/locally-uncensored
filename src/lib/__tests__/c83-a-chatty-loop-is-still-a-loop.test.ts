/**
 * CA, cloud loops (13.11.2026): detector 8 (C83) counted only SILENT
 * near-copies. A cloud reasoner like GLM writes one line before every call,
 * "Let me check the file again." with a word changed, and that line reset the
 * streak to one each step, so the same call ran until the budget ended it.
 * A line that is a near-copy of the last one is no news.
 */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard } from '../agent-loop-guard'

const call = (i: number) => [{
  name: 'code_execute',
  args: JSON.stringify({ language: 'python', code: `import json\nd = json.load(open("data/reports/report_${i % 3}.json"))\nprint(len([x for x in d["items"] if x["status"] == "open"]))  # try ${i % 2}` }),
}]

describe('detector 8 with a line before every call', () => {
  it('a near-copied line does not reset the streak: steer, then halt', () => {
    const g = new AgentLoopGuard()
    const verdicts: string[] = []
    for (let i = 0; i < 10; i++) {
      g.recordNarration(`Let me check the report file again, attempt ${i + 1}.`)
      const v = g.recordBatch(call(i))
      verdicts.push(v.action)
      if (v.action === 'halt') break
    }
    expect(verdicts).toContain('steer')
    expect(verdicts[verdicts.length - 1]).toBe('halt')
  })

  it('a line with real news each step keeps it out', () => {
    const g = new AgentLoopGuard()
    const lines = [
      'Counting open items in the first report.',
      'The first report has 52 open, now the second one.',
      'Second done with 52 as well; checking the third.',
      'All three counted, adding them up and comparing.',
      'Double checking the status spelling in the data.',
      'Status field confirmed, writing the summary now.',
    ]
    for (let i = 0; i < lines.length; i++) {
      g.recordNarration(lines[i])
      expect(g.recordBatch(call(i)).action).toBe('ok')
    }
  })
})
