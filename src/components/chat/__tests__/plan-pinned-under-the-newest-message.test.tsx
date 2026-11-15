/**
 * @vitest-environment jsdom
 *
 * CA (13.11.2026, David): the plan is pinned under the newest message, like
 * the Claude Code desktop app. One row per step, exactly one runs, the list
 * folds to one line, and once the run is over a closing box says how it ended.
 * Same component for local and cloud models: it reads only the plan the model
 * wrote through todo_write.
 *
 * David, 14.11.2026, on the first version, a floating card: "Looks nothing
 * like Claude Code. Claude Code is not a glass surface, it is integrated into
 * the chat much more cleanly." Since then it is a plain list in the flow of
 * the chat, and the block "part of the page" below keeps it one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { PlanBar, planRowStates } from '../PlanBar'
import { useTodoStore, writeTodos, type TodoItem } from '../../../stores/todoStore'
import { useGenerationStore } from '../../../stores/generationStore'
import { useStagedChangesStore } from '../../../stores/stagedChangesStore'

const CONV = 'conv-plan'

function running(on: boolean) {
  useGenerationStore.setState((s) => ({ generating: { ...s.generating, [CONV]: on } }))
}

beforeEach(() => {
  // No choice made yet: open, the default (David, 14.11.2026).
  useTodoStore.setState({ byConversation: {}, updatedAt: {}, planOpen: {} })
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
    // No count (David, 14.11.2026): the head is the word, the ticks say how far.
    expect(v.getByTestId('plan-title').textContent).toBe('Plan')
    expect(box.textContent).not.toMatch(/\d+\s*(?:of|\/)\s*\d+/)
    expect(v.container.querySelectorAll('.animate-spin')).toHaveLength(1)
    // No closing box while the run goes.
    expect(v.queryByTestId('plan-all-done')).toBeNull()
    expect(v.queryByTestId('plan-run-stopped')).toBeNull()
  })

  it('is part of the page, not a sheet on top of it', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    const box = v.getByTestId('plan-pinned')
    // No card: nothing in it floats, casts a shadow, blurs or rings the list.
    const classes = [box, ...box.querySelectorAll('*')].map((el) => el.getAttribute('class') ?? '').join(' ')
    expect(classes).not.toMatch(/(?<![\w-])(?:lu-elevated|shadow(?:-\w+)?|backdrop-blur(?:-\w+)?|ring-\w+)(?![\w-])/)
    // Text scrolls under a sticky list, so it needs a ground: the transcript's
    // own colour (index.css), which is why it reads as the page.
    expect(box.className).toMatch(/(?<![\w-])lu-chat-scrim(?![\w-])/)
    // On the left edge of the answer text: 12 px row padding, the 24 px avatar
    // column, its 8 px gap and the text's own 4 px.
    expect(box.className).toMatch(/(?<![\w-])pl-12(?![\w-])/)
  })

  it('a finished step steps back, it is not crossed out', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    const [done, runs] = [...v.getByTestId('plan-steps').querySelectorAll('li')]
    expect(done.innerHTML).not.toMatch(/line-through/)
    // Three tones and no bold: the running step is the full text colour, the
    // finished one a thinned-out one.
    expect(done.querySelector('span')?.className).toMatch(/text-gray-900\/60/)
    expect(runs.querySelector('span')?.className).toMatch(/(?<![\w-])text-gray-900(?![\w/-])/)
    expect(runs.innerHTML).not.toMatch(/font-(?:medium|semibold|bold)/)
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

  it('folds to one line with its name and the running step', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    fireEvent.click(v.getByTitle('Collapse the plan'))
    expect(v.queryByTestId('plan-steps')).toBeNull()
    expect(v.getByTestId('plan-pinned').textContent).toContain('Plan')
    expect(v.getByTestId('plan-pinned').textContent).toContain('Write median()')
    expect(v.getByTestId('plan-pinned').textContent).not.toMatch(/of 3/)
    fireEvent.click(v.getByTitle('Show every step'))
    expect(v.getByTestId('plan-steps')).toBeTruthy()
  })

  it('a finished plan is its count and the greyed list, no tick, no sentence', () => {
    // David, 14.11.2026, on the live build: drop the tick and "every step done".
    writeTodos(CONV, PLAN.map((t) => ({ ...t, status: 'completed' as const })))
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-title').textContent).toBe('Plan')
    expect(v.getByTestId('plan-pinned').textContent).not.toMatch(/3 of 3|3\/3/)
    expect([...v.getByTestId('plan-steps').querySelectorAll('li')].map((r) => r.getAttribute('data-state')))
      .toEqual(['done', 'done', 'done'])
    expect(v.getByTestId('plan-pinned').textContent).not.toMatch(/every step done/i)
    expect(v.queryByTestId('plan-changes-waiting')).toBeNull()
    expect(v.container.innerHTML).not.toMatch(/emerald/)
  })

  it('changes still waiting for approval are named under a finished plan', () => {
    writeTodos(CONV, PLAN.map((t) => ({ ...t, status: 'completed' as const })))
    const v = render(<PlanBar conversationId={CONV} />)
    act(() => { useStagedChangesStore.setState({ byChat: { [CONV]: [{}, {}] } } as never) })
    expect(v.getByTestId('plan-changes-waiting').textContent).toContain('2 changes still waiting for your approval')
    expect(v.getByTestId('plan-changes-waiting').textContent).not.toMatch(/every step done/i)
  })

  it('a run that ended with steps open says so, with Continue and Clear plan', () => {
    writeTodos(CONV, PLAN)
    const onContinue = vi.fn()
    const v = render(<PlanBar conversationId={CONV} onContinue={onContinue} />)
    const box = v.getByTestId('plan-run-stopped')
    expect(box.textContent).toContain('the run ended before every step was done')
    expect(box.textContent).not.toMatch(/of 3/)
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

describe('open by default, folded by a click, kept per chat (David, 14.11.2026)', () => {
  beforeEach(() => { useTodoStore.setState({ planOpen: {} }) })

  it('starts open, with every step and no count', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-steps')).toBeTruthy()
    expect(v.getByTitle('Collapse the plan')).toBeTruthy()
    expect(v.getByTestId('plan-pinned').textContent).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
  })

  it('folded while running: "Plan" and the running step with its spinner', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    fireEvent.click(v.getByTitle('Collapse the plan'))
    expect(v.queryByTestId('plan-steps')).toBeNull()
    const step = v.getByTestId('plan-folded-step')
    expect(step.textContent).toBe('Write median()')
    expect(step.querySelector('.animate-spin')).toBeTruthy()
  })

  it('folded and through: "Plan" with a tick, nothing else', () => {
    useTodoStore.getState().setPlanOpen(CONV, false)
    writeTodos(CONV, PLAN.map((t) => ({ ...t, status: 'completed' as const })))
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-folded-done')).toBeTruthy()
    expect(v.queryByTestId('plan-folded-step')).toBeNull()
    expect(v.container.querySelectorAll('.animate-spin')).toHaveLength(0)
  })

  it('the choice stays while the run goes on and through a redraw', () => {
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    fireEvent.click(v.getByTitle('Collapse the plan'))
    expect(useTodoStore.getState().planOpen[CONV]).toBe(false)
    act(() => { writeTodos(CONV, [{ content: 'Read the file', status: 'completed' }, { content: 'Write median()', status: 'completed' }, { content: 'Run the tests', status: 'in_progress' }]) })
    expect(v.queryByTestId('plan-steps')).toBeNull()
    v.unmount()
    const again = render(<PlanBar conversationId={CONV} />)
    expect(again.queryByTestId('plan-steps')).toBeNull()
    fireEvent.click(again.getByTitle('Show every step'))
    expect(again.getByTestId('plan-steps')).toBeTruthy()
    expect(useTodoStore.getState().planOpen[CONV]).toBe(true)
  })

  it('another chat keeps its own state', () => {
    useTodoStore.getState().setPlanOpen('other-chat', false)
    running(true)
    writeTodos(CONV, PLAN)
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-steps')).toBeTruthy()
  })
})
