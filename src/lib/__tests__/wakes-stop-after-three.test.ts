/**
 * CA (13.11.2026): every wake is a full paid agent run nobody typed, and it may
 * order new background agents whose end wakes again. At most three in a row,
 * then the watcher waits for the user's next own message.
 */
import { describe, it, expect } from 'vitest'
import { createWakeWatcher, MAX_WAKES_IN_A_ROW } from '../agent-wake'
import type { AgentTask } from '../agent-tasks'

function rig() {
  const st = { userTurn: 'u1' as string | null, tasks: [] as AgentTask[] }
  const sent: string[] = []
  const timers: Array<() => void> = []
  const w = createWakeWatcher({
    conversationId: () => 'c',
    tasks: () => st.tasks,
    isRunning: () => false,
    isStopped: () => false,
    activeModel: () => 'lu-cloud::x',
    send: async (t) => { sent.push(t); st.tasks = st.tasks.map((x) => ({ ...x, reported: true })) },
    lastUserTurn: () => st.userTurn,
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
    bundleMs: 1,
  })
  const finishOne = async (n: number) => {
    st.tasks = [...st.tasks, { id: `t${n}`, status: 'done', reported: false } as unknown as AgentTask]
    w.check()
    while (timers.length) timers.shift()!()
    await Promise.resolve(); await Promise.resolve()
  }
  return { st, sent, finishOne }
}

describe('background wakes in a row', () => {
  it('stop after three, without the user in between', async () => {
    const r = rig()
    for (let i = 0; i < 6; i++) await r.finishOne(i)
    expect(MAX_WAKES_IN_A_ROW).toBe(3)
    expect(r.sent).toHaveLength(3)
  })

  it('a new message from the user starts the count again', async () => {
    const r = rig()
    for (let i = 0; i < 4; i++) await r.finishOne(i)
    expect(r.sent).toHaveLength(3)
    r.st.userTurn = 'u2'
    await r.finishOne(9)
    expect(r.sent).toHaveLength(4)
  })
})
