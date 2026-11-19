// @vitest-environment jsdom
/**
 * W48 (GitHub #257, mirh: "you don't seem to be able to see the final system
 * prompt anywhere"): the context list's "System prompt" row opens the system
 * prompt the last request of this chat really carried, no new pop-up.
 *
 * Run: npx vitest run src/components/chat/__tests__/w48-sent-system-prompt.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextBreakdownPanel } from '../ContextBreakdownPanel'
import { useChatStore } from '../../../stores/chatStore'
import { noteSentSystemPrompt, publishStepBreakdown, sentSystemText, useContextBreakdownStore } from '../../../stores/contextBreakdownStore'

let convId = ''
beforeEach(() => {
  useContextBreakdownStore.setState({ byConv: {}, systemByConv: {} })
  convId = useChatStore.getState().createConversation('qwen', '')
  useChatStore.getState().setActiveConversation(convId)
})
afterEach(() => cleanup())

describe('what the last request sent as system prompt', () => {
  it('joins the system messages in order and leaves the rest out', () => {
    expect(sentSystemText([
      { role: 'system', content: 'You are LU.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Today is Thursday.' },
    ])).toBe('You are LU.\n\nToday is Thursday.')
  })

  it('an agent step records it through the breakdown it publishes', () => {
    publishStepBreakdown(convId, [{ role: 'system', content: 'agent prompt' }, { role: 'user', content: 'x' }], 0)
    expect(useContextBreakdownStore.getState().systemByConv[convId]?.text).toBe('agent prompt')
  })

  it('the System prompt row opens it in the context list', () => {
    noteSentSystemPrompt(convId, [{ role: 'system', content: 'You are a pirate.\nCurrent date: 2026-11-19' }, { role: 'user', content: 'hi' }])
    render(<ContextBreakdownPanel window={8192} modelWindow={8192} agent={false} />)
    expect(screen.queryByTestId('context-system-text')).toBeNull()
    const toggle = screen.getByTestId('context-system-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    const text = screen.getByTestId('context-system-text')
    expect(text.textContent).toContain('You are a pirate.')
    expect(text.textContent).toContain('Current date: 2026-11-19')
    expect(text.textContent).toContain('exactly as the model got it')
    fireEvent.click(toggle)
    expect(screen.queryByTestId('context-system-text')).toBeNull()
  })

  it('says so when the last request had none', () => {
    noteSentSystemPrompt(convId, [{ role: 'user', content: 'hi' }])
    render(<ContextBreakdownPanel window={8192} modelWindow={8192} agent={false} />)
    fireEvent.click(screen.getByTestId('context-system-toggle'))
    expect(screen.getByTestId('context-system-text').textContent).toContain('had no system prompt')
  })

  it('before any request the row is plain text, nothing to open', () => {
    render(<ContextBreakdownPanel window={8192} modelWindow={8192} agent={false} />)
    expect(screen.queryByTestId('context-system-toggle')).toBeNull()
    expect(screen.getByTestId('context-row-system').textContent).toContain('System prompt')
  })
})
