// @vitest-environment jsdom
/**
 * A11: "stell Auto Compact auf 80". The change waits on a card in the tool
 * call with old → new, Accept and Decline. After Accept the card stays as a
 * row with Undo, which puts the old value back. A value changed by hand since
 * asks once more before it is set back.
 *
 * Run: npx vitest run src/components/chat/__tests__/a-settings-change-asks-on-a-card.test.tsx
 */
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ToolCallBlock } from '../ToolCallBlock'
import { ToolCallBand } from '../ToolCallBand'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useSettingsConfirmStore } from '../../../stores/settingsConfirmStore'
import { useChatStore } from '../../../stores/chatStore'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import { executeSetSetting } from '../../../api/mcp/settings-tools'
import type { AgentToolCall } from '../../../types/agent-mode'
import type { AgentRunContext } from '../../../api/agent-context'

const run: AgentRunContext = {
  token: 't', chatId: null, conversationId: 'chat-a', workspace: null, artifactMode: false,
  readOnlyShellTurn: false, mode: null, artifacts: [], settingsCard: true, toolCallId: 'call-1',
}
const call = (over: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id: 'call-1', toolName: 'set_setting', args: { key: 'autoCompactThreshold', value: '80' }, status: 'running', timestamp: 1, ...over,
})
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const threshold = () => useSettingsStore.getState().settings.autoCompactThreshold
// The tool loads its stores lazily (C60), so the first card can take a real
// moment on a cold import: wait on time, not on a count of ticks.
const waitForCard = async () => {
  const until = Date.now() + 4_000
  while (useSettingsConfirmStore.getState().queue.length === 0 && Date.now() < until) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  }
}

beforeEach(() => {
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useSettingsConfirmStore.setState({ queue: [] })
  // C60: one shared run object here; its card count starts at zero per test.
  run.selfControlCards = 0
  // C60: the user asked for it in their own message (the intent check).
  useChatStore.setState({
    activeConversationId: 'chat-a',
    conversations: [{ id: 'chat-a', title: 't', messages: [{ id: 'u1', role: 'user', content: 'set auto compact to 80 and the theme', timestamp: 1 }] }],
  } as never)
})
afterEach(cleanup)

describe('the card of a settings change', () => {
  it('shows old → new with Accept and Decline, Accept applies, then Undo puts it back', async () => {
    const pending = executeSetSetting({ key: 'autoCompactThreshold', value: '80' }, run)
    const view = render(createElement(ToolCallBlock, { toolCall: call() }))
    await waitForCard()
    expect(q('setting-change-ask')).not.toBeNull()
    expect(q('setting-change-fromto')!.textContent).toBe('Auto-compact at: auto → 80 %')
    expect([...q('setting-change-ask')!.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual(['Accept', 'Decline'])
    expect(threshold()).toBe(0)

    await act(async () => { fireEvent.click(q('setting-change-accept')!) })
    const result = await pending
    expect(threshold()).toBe(0.8)
    expect(q('setting-change-ask')).toBeNull()

    view.rerender(createElement(ToolCallBlock, { toolCall: call({ status: 'completed', result }) }))
    expect(q('setting-change-done')!.dataset.state).toBe('applied')
    expect(q('setting-change-done')!.textContent).toContain('Auto-compact at: auto → 80 %')

    await act(async () => { fireEvent.click(q('setting-change-undo')!) })
    expect(threshold()).toBe(0)
    expect(q('setting-change-done')!.dataset.state).toBe('undone')

    await act(async () => { fireEvent.click(q('setting-change-redo')!) })
    expect(threshold()).toBe(0.8)
  })

  it('Decline changes nothing and leaves no Undo', async () => {
    const pending = executeSetSetting({ key: 'autoCompactThreshold', value: '80' }, run)
    const view = render(createElement(ToolCallBlock, { toolCall: call() }))
    await waitForCard()
    await act(async () => { fireEvent.click(q('setting-change-decline')!) })
    const result = await pending
    expect(result).toMatch(/declined/)
    expect(threshold()).toBe(0)
    view.rerender(createElement(ToolCallBlock, { toolCall: call({ status: 'completed', result }) }))
    expect(q('setting-change-done')).toBeNull()
  })

  it('a value changed by hand since asks again before it is set back', async () => {
    const pending = executeSetSetting({ key: 'autoCompactThreshold', value: '80' }, run)
    render(createElement(ToolCallBlock, { toolCall: call() }))
    await waitForCard()
    await act(async () => { fireEvent.click(q('setting-change-accept')!) })
    const result = await pending
    cleanup()
    act(() => { useSettingsStore.getState().updateSettings({ autoCompactThreshold: 0.6 }) })
    render(createElement(ToolCallBlock, { toolCall: call({ status: 'completed', result }) }))
    expect(q('setting-change-done')!.dataset.state).toBe('moved')
    await act(async () => { fireEvent.click(q('setting-change-undo')!) })
    expect(threshold()).toBe(0.6)
    await act(async () => { fireEvent.click(q('setting-change-undo-anyway')!) })
    expect(threshold()).toBe(0)
  })

  it('shows in its own tool call only', async () => {
    void executeSetSetting({ key: 'autoCompactThreshold', value: '80' }, run)
    render(createElement(ToolCallBlock, { toolCall: call({ id: 'call-2' }) }))
    await waitForCard()
    expect(q('setting-change-ask')).toBeNull()
    useSettingsConfirmStore.setState({ queue: [] })
  })

  it('stays visible with Undo when the steps of the run fold into one line', async () => {
    const pending = executeSetSetting({ key: 'autoCompactThreshold', value: '80' }, run)
    await waitForCard()
    act(() => { useSettingsConfirmStore.getState().answer(useSettingsConfirmStore.getState().queue[0].req.id, true) })
    const result = await pending
    render(createElement(ToolCallBand, {
      calls: [
        { id: 'call-0', toolName: 'get_settings', args: { query: 'compact' }, status: 'completed', result: 'autoCompactThreshold = auto', timestamp: 1 },
        call({ status: 'completed', result }),
      ],
    }))
    expect(q('setting-change-done')!.dataset.state).toBe('applied')
    expect(q('setting-change-undo')).not.toBeNull()
  })
})
