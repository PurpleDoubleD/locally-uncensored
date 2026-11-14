/**
 * @vitest-environment jsdom
 *
 * CA (13.11.2026, David): the plan is pinned under the newest message, like
 * the Claude Code desktop app. One row per step, exactly one runs, the list
 * folds to one line, and once the run is over a closing box says how it ended.
 * Same component for local and cloud models: it reads only the plan the model
 * wrote through todo_write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { PlanBar, planRowStates, planCountLabel } from '../PlanBar'
import { useTodoStore, writeTodos, type TodoItem } from '../../../stores/todoStore'
import { useGenerationStore } from '../../../stores/generationStore'
import { useStagedChangesStore } from '../../../stores/stagedChangesStore'

const CONV = 'conv-plan'

function running(on: boolean) {
  useGenerationStore.setState((s) => ({ generating: { ...s.generating, [CONV]: on } }))
}

beforeEach(() => {
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useStagedChangesStore.setState({ byChat: {} } as never)
  running(false)
})
afterEach(() => cleanup())

const PLAN: TodoItem[] = [
  { content: 'Read the file', status: 'completed' },
  { content: 'Write median()', status: 'in_progress' },
  { content: 'Run the tests', status: 'pending' },
]

describe('planRowStates', () => {
  it('one step runs while the run does', () => {
    expect(planRowStates(PLAN, true)).toEqual(['done', 'running', 'open'])
  })

  it('a second in_progress reads as open, never as done', () => {
    const two = [...PLAN.slice(0, 2), { content: 'Run the tests', status: 'in_progress' as const }]
    expect(planRowStates(two, true)).toEqual(['done', 'running', 'open'])
  })

  it('nothing spins once the run is over', () => {
    expect(planRowStates(PLAN, false)).toEqual(['done', 'open', 'open'])
  })

  it('counts done steps for the folded line', () => {
    expect(planCountLabel(PLAN)).toBe('1 of 3 done')
  })
})

describe('PlanBar, pinned in the transcript', () => {
  it('shows nothing without a plan', () => {
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.queryByTestId('plan-pinned')).toBeNull()
  })

  it('lists every step with its state and sticks to the bottom of the transcript', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    const box = v.getByTestId('plan-pinned')
    expect(box.className).toMatch(/\bsticky\b/)
    expect(box.className).toMatch(/\bbottom-0\b/)
    const rows = [...v.getByTestId('plan-steps').querySelectorAll('li')]
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'running', 'open'])
    expect(v.getByTestId('plan-count').textContent).toBe('1 of 3 done')
    expect(v.container.querySelectorAll('.animate-spin')).toHaveLength(1)
    // No closing box while the run goes.
    expect(v.queryByTestId('plan-all-done')).toBeNull()
    expect(v.queryByTestId('plan-run-stopped')).toBeNull()
  })

  it('updates live and replaces the whole list when the plan changes', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    act(() => {
      writeTodos(CONV, [
        { content: 'Read the file', status: 'completed' },
        { content: 'Write median()', status: 'completed' },
        { content: 'Run the tests', status: 'in_progress' },
      ])
    })
    expect([...v.getByTestId('plan-steps').querySelectorAll('li')].map((r) => r.getAttribute('data-state')))
      .toEqual(['done', 'done', 'running'])
    act(() => { writeTodos(CONV, [{ content: 'Start over with a test first', status: 'in_progress' }]) })
    const rows = [...v.getByTestId('plan-steps').querySelectorAll('li')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Start over with a test first')
    expect(v.queryByText('Write median()')).toBeNull()
  })

  it('folds to one line with the count and the running step', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    fireEvent.click(v.getByTitle('Collapse the plan'))
    expect(v.queryByTestId('plan-steps')).toBeNull()
    expect(v.getByTestId('plan-pinned').textContent).toContain('1 of 3 done')
    expect(v.getByTestId('plan-pinned').textContent).toContain('Write median()')
    fireEvent.click(v.getByTitle('Show every step'))
    expect(v.getByTestId('plan-steps')).toBeTruthy()
  })

  it('a finished run gets a closing box, and names changes still waiting', () => {
    writeTodos(CONV, PLAN.map((t) => ({ ...t, status: 'completed' as const })))
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-all-done').textContent).toContain('every step done')
    act(() => { useStagedChangesStore.setState({ byChat: { [CONV]: [{}, {}] } } as never) })
    expect(v.getByTestId('plan-all-done').textContent).toContain('2 changes still waiting for your approval')
  })

  it('a run that ended with steps open says so, with Continue and Clear plan', () => {
    writeTodos(CONV, PLAN)
    const onContinue = vi.fn()
    const v = render(<PlanBar conversationId={CONV} onContinue={onContinue} />)
    const box = v.getByTestId('plan-run-stopped')
    expect(box.textContent).toContain('the run ended here, 1 of 3 steps done, 2 still open')
    expect(box.textContent).toContain('Next: Write median()')
    expect(v.container.querySelectorAll('.animate-spin')).toHaveLength(0)
    fireEvent.click(v.getByTestId('plan-continue'))
    expect(onContinue).toHaveBeenCalledWith('continue')
    fireEvent.click(v.getByText('Clear plan'))
    expect(useTodoStore.getState().byConversation[CONV]).toBeUndefined()
    expect(v.queryByTestId('plan-pinned')).toBeNull()
  })

  it('the closing box stays when the list is folded', () => {
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    fireEvent.click(v.getByTitle('Collapse the plan'))
    expect(v.getByTestId('plan-run-stopped')).toBeTruthy()
  })
})
