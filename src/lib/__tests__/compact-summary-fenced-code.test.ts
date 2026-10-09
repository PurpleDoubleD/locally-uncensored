import { describe, expect, it } from 'vitest'
import {
  EMPTY_SUMMARY,
  compactSummaryBody,
  parseCompactSummary,
  renderCompactSummary,
  summarySections,
} from '../compact-summary'

describe('literal code in compact summaries', () => {
  it.each(['```', '~~~'])('keeps heading-like code inside %s fences in its section', (fence) => {
    const facts = `${fence}text\nTASK\nOPEN\nNOTES\n${fence}`
    const summary = parseCompactSummary(`TASK\nRepair the parser\nFACTS\n${facts}\nOPEN\nRun the tests`)
    expect(summary.task).toBe('Repair the parser')
    expect(summary.facts).toBe(facts)
    expect(summary.open).toBe('Run the tests')
    expect(summary.rest).toBe('')
  })

  it('does not close a fence with a shorter run, another marker, or an info string', () => {
    const facts = '````text\n```\nOPEN\n~~~\nTASK\n````still-code\nNOTES\n````'
    const summary = parseCompactSummary(`FACTS\n${facts}\nOPEN\nCheck the result`)
    expect(summary.facts).toBe(facts)
    expect(summary.open).toBe('Check the result')
    expect(summary.task).toBe('')
  })

  it('accepts an indented opening and a longer closing fence without altering the code', () => {
    const facts = '   ~~~text\nOPEN\n  ~~~~~   '
    const summary = parseCompactSummary(`FACTS\n${facts}\nA fact after the fence\nOPEN\nStill pending`)
    // Only the existing section-boundary trim applies; interior whitespace is retained.
    expect(summary.facts).toBe(facts.trimStart() + '\nA fact after the fence')
    expect(summary.open).toBe('Still pending')
  })

  it('preserves the remainder of an unclosed code block', () => {
    const facts = '```sql\nOPEN\nTASK\nNOTES'
    const summary = parseCompactSummary(`FACTS\n${facts}`)
    expect(summary.facts).toBe(facts)
    expect(summary.open).toBe('')
  })

  it('keeps a fenced answer without section headings as loose text', () => {
    const answer = '```text\nTASK\nOPEN\n```'
    expect(parseCompactSummary(answer)).toEqual({ ...EMPTY_SUMMARY, rest: answer })
  })

  it('round-trips stored code and displays it under the original heading', () => {
    const original = { ...EMPTY_SUMMARY, task: 'Inspect status constants', facts: '```ts\nOPEN\nTASK\n```', open: 'Write regression coverage' }
    const rendered = renderCompactSummary(original)
    expect(parseCompactSummary(compactSummaryBody(rendered))).toEqual(original)
    expect(summarySections(rendered)).toEqual([
      { heading: 'TASK', body: original.task },
      { heading: 'FACTS', body: original.facts },
      { heading: 'OPEN', body: original.open },
    ])
  })

  it('still recognizes decorated headings outside code blocks', () => {
    const summary = parseCompactSummary('## TASK:\nRepair\n**FACTS**\nKnown value\n- OPEN -\nVerify')
    expect(summary.task).toBe('Repair')
    expect(summary.facts).toBe('Known value')
    expect(summary.open).toBe('Verify')
  })
})
