/**
 * M310: a turn the paired phone started in a shared chat must not wait for a
 * card that only the computer draws. Before the fix, "Open this address?"
 * (strict web addresses, on by default in 3.1.0), the settings card and the
 * workflow card stood at the computer and the phone hung for up to 10 minutes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { setTurnCaps, clearTurnCaps, isPhoneTurn, PHONE_TURN_NO_CARD } from '../remote-turn-caps'
import { guardWebUrl } from '../web-url-provenance'
import { checkSelfControl } from '../self-control-policy'
import { useWebUrlConfirmStore } from '../../stores/webUrlConfirmStore'
import type { AgentRunContext } from '../../api/agent-context'

const ALL = { agent: true, files: true, terminal: true, create: true }
const run = (conversationId: string) => ({ conversationId, toolCallId: 't1', settingsCard: true } as unknown as AgentRunContext)

afterEach(() => { clearTurnCaps('phone-chat'); vi.restoreAllMocks() })

describe('a phone turn gets no desktop card', () => {
  it('knows a phone turn only while it runs', () => {
    expect(isPhoneTurn('phone-chat')).toBe(false)
    setTurnCaps('phone-chat', ALL)
    expect(isPhoneTurn('phone-chat')).toBe(true)
    expect(isPhoneTurn('other')).toBe(false)
    clearTurnCaps('phone-chat')
    expect(isPhoneTurn('phone-chat')).toBe(false)
  })

  it('an unknown web address is refused with "ask for the link" instead of a card', async () => {
    const ask = vi.spyOn(useWebUrlConfirmStore.getState(), 'ask')
    setTurnCaps('phone-chat', ALL)
    const out = await guardWebUrl('https://made-up.example.org/x', 'web_fetch', run('phone-chat'))
    expect(out).toMatch(/Ask the user to send the link/)
    expect(ask).not.toHaveBeenCalled()
  })

  it('the settings card is refused in a phone turn and allowed again after it', () => {
    setTurnCaps('phone-chat', ALL)
    const v = checkSelfControl(run('phone-chat'), { names: () => true, strong: false, what: 'Temperature' })
    expect(v).toEqual({ ok: false, why: 'surface', reply: PHONE_TURN_NO_CARD })
  })
})
