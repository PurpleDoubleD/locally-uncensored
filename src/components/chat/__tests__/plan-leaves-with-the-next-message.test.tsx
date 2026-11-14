/**
 * @vitest-environment jsdom
 *
 * David, 14.11.2026: the pinned plan stays, ticks and all, until the user sends
 * the next message. Then it leaves the chat and the space is free again. The
 * transcript keeps it as a folded "Plan" row under the answer it belonged to
 * (lib/plan-pin.ts), and a run that writes a new plan does not erase it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { PlanBar, PlanHistoryRow } from '../PlanBar'
import { useTodoStore, writeTodos, type TodoItem } from '../../../stores/todoStore'
import { useChatStore } from '../../../stores/chatStore'
import { useGenerationStore } from '../../../stores/generationStore'
import { archiveRetiredPlan, isPlanRetired, planHistory, retiredAt } from '../../../lib/plan-pin'
import type { Message } from '../../../types/chat'

const CONV = 'conv-leaves'
const DONE: TodoItem[] = [
  { content: 'Read the file', status: 'completed' },
  { content: 'Write median()', status: 'completed' },
]

const msg = (id: string, role: Message['role'], timestamp: number, extra: Partial<Message> = {}): Message =>
  ({ id, role, content: id, timestamp, ...extra }) as Message

function seedChat(messages: Message[]) {
  useChatStore.setState({ conversations: [{ id: CONV, title: 't', messages, createdAt: 0, updatedAt: 0 } as never] } as never)
}

beforeEach(() => {
  useTodoStore.setState({ byConversation: {}, updatedAt: {}, archived: {}, planOpen: {} })
  useGenerationStore.setState((s) => ({ generating: { ...s.generating, [CONV]: false } }))
})
afterEach(() => cleanup())

describe('retiredAt', () => {
  const thread = [msg('u1', 'user', 100), msg('a1', 'assistant', 110), msg('u2', 'user', 300), msg('a2', 'assistant', 310)]

  it('a plan written in the newest run is still the current one', () => {
    expect(retiredAt(thread, 320)).toBeNull()
  })

  it('a visible user message after its last update retires it, under the answer it was written in', () => {
    expect(retiredAt(thread, 150)).toEqual({ anchorId: 'a1' })
  })

  it('hidden messages (a wake, a nudge) do not count as the user writing', () => {
    const t = [msg('u1', 'user', 100), msg('a1', 'assistant', 110), msg('w', 'user', 300, { hidden: true })]
    expect(retiredAt(t, 150)).toBeNull()
  })
})

describe('the pinned plan', () => {
  it('stays with every tick after the run, until the user writes', () => {
    seedChat([msg('u1', 'user', 1), msg('a1', 'assistant', 2)])
    writeTodos(CONV, DONE)
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-pinned')).toBeTruthy()
    expect([...v.getByTestId('plan-steps').querySelectorAll('li')].map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done'])
    act(() => {
      useChatStore.getState().addMessage(CONV, msg('u2', 'user', Date.now() + 1))
    })
    expect(v.queryByTestId('plan-pinned')).toBeNull()
    expect(isPlanRetired(CONV)).toBe(true)
  })

  it('a run that ended early also stays until the user writes', () => {
    seedChat([msg('u1', 'user', 1), msg('a1', 'assistant', 2)])
    writeTodos(CONV, [{ content: 'Read the file', status: 'completed' }, { content: 'Write median()', status: 'in_progress' }])
    const v = render(<PlanBar conversationId={CONV} />)
    expect(v.getByTestId('plan-run-stopped')).toBeTruthy()
    act(() => { useChatStore.getState().addMessage(CONV, msg('u2', 'user', Date.now() + 1)) })
    expect(v.queryByTestId('plan-pinned')).toBeNull()
  })

  it('the model keeps its plan: nothing is cleared, only no longer pinned', () => {
    seedChat([msg('u1', 'user', 1), msg('a1', 'assistant', 2)])
    writeTodos(CONV, DONE)
    act(() => { useChatStore.getState().addMessage(CONV, msg('u2', 'user', Date.now() + 1)) })
    expect(useTodoStore.getState().getTodos(CONV)).toEqual(DONE)
  })
})

describe('the folded row it leaves', () => {
  it('is one line "Plan" that opens to the ticked steps, nothing spinning', () => {
    const v = render(<PlanHistoryRow todos={[...DONE, { content: 'Run the tests', status: 'in_progress' }]} />)
    expect(v.getByTestId('plan-history').textContent).toBe('Plan')
    expect(v.queryByTestId('plan-steps')).toBeNull()
    fireEvent.click(v.getByTitle('Show the plan'))
    const rows = [...v.getByTestId('plan-steps').querySelectorAll('li')]
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done', 'open'])
    expect(v.container.querySelectorAll('.animate-spin')).toHaveLength(0)
    fireEvent.click(v.getByTitle('Fold the plan'))
    expect(v.queryByTestId('plan-steps')).toBeNull()
  })

  it('a new plan from the next run archives the old one under its answer first', () => {
    const t0 = Date.now()
    seedChat([msg('u1', 'user', t0 - 10), msg('a1', 'assistant', t0 - 5)])
    writeTodos(CONV, DONE)
    act(() => { useChatStore.getState().addMessage(CONV, msg('u2', 'user', Date.now() + 5)) })
    archiveRetiredPlan(CONV)
    const NEXT: TodoItem[] = [{ content: 'Update the README', status: 'in_progress' }]
    useTodoStore.setState((s) => ({ updatedAt: { ...s.updatedAt, [CONV]: Date.now() + 10 } }))
    writeTodos(CONV, NEXT)
    useTodoStore.setState((s) => ({ updatedAt: { ...s.updatedAt, [CONV]: Date.now() + 10 } }))
    const s = useTodoStore.getState()
    const messages = useChatStore.getState().conversations[0].messages
    const rows = planHistory(messages, s.byConversation[CONV], s.updatedAt[CONV], s.archived[CONV])
    expect(rows.get('a1')).toEqual([DONE])
    // The new plan is the pinned one, not a row.
    expect([...rows.values()].flat()).not.toContainEqual(NEXT)
  })

  it('todo_write archives before it writes', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/api/mcp/builtin-tools.ts', 'utf8')
    const at = src.indexOf('async function executeTodoWrite')
    const body = src.slice(at, src.indexOf('\n}\n', at))
    expect(body.indexOf('archiveRetiredPlan(convId)')).toBeGreaterThan(0)
    expect(body.indexOf('archiveRetiredPlan(convId)')).toBeLessThan(body.indexOf('writeTodos(convId'))
  })

  it('both transcripts draw the rows under the answers', async () => {
    const { readFileSync } = await import('node:fs')
    const read = (p: string) => readFileSync(`src/components/chat/${p.replace('../', '')}`, 'utf8')
    expect(read('../MessageList.tsx')).toMatch(/planRows\.get\(message\.id\)\?\.map/)
    expect(read('../CodexView.tsx')).toMatch(/planRows\.get\(msg\.id\)\?\.map/)
  })

  it('a deleted chat takes its archive with it', () => {
    useTodoStore.getState().archivePlan(CONV, 'a1', DONE)
    useTodoStore.getState().forgetConversation(CONV)
    expect(useTodoStore.getState().archived[CONV]).toBeUndefined()
  })
})
