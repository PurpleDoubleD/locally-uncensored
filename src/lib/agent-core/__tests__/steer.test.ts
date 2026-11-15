import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { appendSteers, steerMessage } from '../steer'
import { useSteerStore } from '../../../stores/steerStore'

type M = { role: string; content?: unknown; tool_calls?: unknown }
const make = (content: string): M => ({ role: 'user', content })

describe('a message written during a run (CA U2)', () => {
  beforeEach(() => useSteerStore.setState({ queue: {} }))

  it('enters the history as user material, oldest first, and leaves the queue', () => {
    useSteerStore.getState().add('c1', 'use vitest, not jest')
    useSteerStore.getState().add('c1', 'and keep the old name')
    const messages: M[] = [{ role: 'user', content: 'task' }, { role: 'tool', content: 'ok' }]
    const taken = appendSteers(messages, () => useSteerStore.getState().take('c1'), make)
    expect(taken.map((t) => t.text)).toEqual(['use vitest, not jest', 'and keep the old name'])
    expect(messages.slice(2).map((m) => m.content)).toEqual([steerMessage('use vitest, not jest'), steerMessage('and keep the old name')])
    expect(useSteerStore.getState().queue.c1).toEqual([])
  })

  it('never lands between a call and its results; it waits for the next round', () => {
    useSteerStore.getState().add('c1', 'stop after the tests')
    const messages: M[] = [{ role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }]
    expect(appendSteers(messages, () => useSteerStore.getState().take('c1'), make)).toEqual([])
    expect(messages).toHaveLength(1)
    expect(useSteerStore.getState().queue.c1).toHaveLength(1)
  })

  it('keeps chats apart and can take one back', () => {
    const st = useSteerStore.getState()
    st.add('a', 'one'); st.add('b', 'two')
    const id = useSteerStore.getState().queue.a[0].id
    useSteerStore.getState().remove('a', id)
    expect(useSteerStore.getState().take('a')).toEqual([])
    expect(useSteerStore.getState().take('b').map((m) => m.text)).toEqual(['two'])
  })

  it('both loops read the queue at the top of an iteration, next to the task report', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')
    for (const f of ['hooks/useAgentChat.ts', 'hooks/useCodex.ts']) {
      const s = src(f)
      const report = s.indexOf('appendTaskReport(\n')
      const steer = s.indexOf('appendSteers(', report)
      expect(report).toBeGreaterThan(0)
      expect(steer - report).toBeLessThan(600)
    }
  })
})
