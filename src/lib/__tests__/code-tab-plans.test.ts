/** C59 A4: the Code tab offers todo_write always (outside a review) and asks for the plan once. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { codePlanAllowed, planNudgeDue, PLAN_NUDGE, PLAN_NUDGE_AFTER_ROUNDS, planToolAllowed } from '../plan-gate'

const base = { mode: 'bypass', userText: 'fix the failing test', todos: [] }

describe('the Code tab plans', () => {
  it('offers todo_write without the word "plan", but not in a review', () => {
    expect(planToolAllowed(base)).toBe(false)
    expect(codePlanAllowed({ ...base, reviewMode: false })).toBe(true)
    expect(codePlanAllowed({ ...base, reviewMode: true })).toBe(false)
  })

  it('asks once, after three rounds, only without a plan and only when it may write', () => {
    const due = (o: Partial<Parameters<typeof planNudgeDue>[0]>) =>
      planNudgeDue({ rounds: PLAN_NUDGE_AFTER_ROUNDS, todos: [], alreadyNudged: false, readOnly: false, reviewMode: false, ...o })
    expect(due({})).toBe(true)
    expect(due({ rounds: 2 })).toBe(false)
    expect(due({ alreadyNudged: true })).toBe(false)
    expect(due({ readOnly: true })).toBe(false)
    expect(due({ reviewMode: true })).toBe(false)
    expect(due({ todos: [{ id: '1', content: 'x', status: 'pending' }] as never })).toBe(false)
    expect(PLAN_NUDGE).toMatch(/together with your next real tool call/)
  })

  it('the loop and both prompts carry it', () => {
    const src = readFileSync(resolve(__dirname, '../../hooks/useCodex.ts'), 'utf8')
    expect(src).toMatch(/codePlanAllowed\(\{/)
    expect(src).toMatch(/planNudgeDue\(\{/)
    expect(src).toMatch(/send todo_write with the whole plan together with your first exploring calls/)
    expect(src).toMatch(/A task of more than three steps: send todo_write with the plan together with your first calls/)
  })
})
