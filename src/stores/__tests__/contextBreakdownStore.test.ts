/**
 * U5: the store the agent loops publish their step split to.
 *
 * Run: npx vitest run src/stores/__tests__/contextBreakdownStore.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { publishStepBreakdown, useContextBreakdownStore } from '../contextBreakdownStore'
import { useChatStore } from '../chatStore'

beforeEach(() => {
  useContextBreakdownStore.setState({ byConv: {} })
})

describe('contextBreakdownStore', () => {
  it('keeps one split per conversation, the newest wins', () => {
    publishStepBreakdown('a', [{ role: 'user', content: 'one' }], 10)
    publishStepBreakdown('b', [{ role: 'user', content: 'two two two' }], 20)
    publishStepBreakdown('a', [{ role: 'user', content: 'three' }], 30)
    const s = useContextBreakdownStore.getState().byConv
    expect(Object.keys(s).sort()).toEqual(['a', 'b'])
    expect(s.a.rows.find((r) => r.key === 'tools')!.tokens).toBe(30)
    expect(s.a.kind).toBe('step')
  })

  it('records how many messages the conversation had', () => {
    const id = useChatStore.getState().createConversation('m', '', 'codex')
    useChatStore.getState().addMessage(id, { id: 'u1', role: 'user', content: 'hi', timestamp: 1 })
    publishStepBreakdown(id, [{ role: 'user', content: 'hi' }], 0)
    expect(useContextBreakdownStore.getState().byConv[id].atMessageCount).toBe(1)
  })

  it('ignores a missing conversation id and never throws', () => {
    publishStepBreakdown(undefined, [], 0)
    publishStepBreakdown(null, [], 0)
    expect(useContextBreakdownStore.getState().byConv).toEqual({})
    expect(() => publishStepBreakdown('x', null as never, 0)).not.toThrow()
  })

  it('clear removes only that conversation', () => {
    publishStepBreakdown('a', [], 1)
    publishStepBreakdown('b', [], 2)
    useContextBreakdownStore.getState().clear('a')
    expect(Object.keys(useContextBreakdownStore.getState().byConv)).toEqual(['b'])
    const before = useContextBreakdownStore.getState()
    useContextBreakdownStore.getState().clear('nope')
    expect(useContextBreakdownStore.getState()).toBe(before)
  })
})
