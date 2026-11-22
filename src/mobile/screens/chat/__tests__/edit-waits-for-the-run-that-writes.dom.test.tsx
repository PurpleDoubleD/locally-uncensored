// @vitest-environment jsdom
/**
 * Stop on an agent run clears both busy flags at once, while the run can still
 * write its last text into the answer. An edit saved in that gap was
 * overwritten (measured through the real useAgentChat, 21.11.2026). The phone's
 * way into the edit and its Save both wait for the run to end.
 *
 * Run: npx vitest run src/mobile/screens/chat/__tests__/edit-waits-for-the-run-that-writes.dom.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const seen = vi.hoisted(() => ({ pushed: [] as string[] }))
vi.mock('../../../nav', async (orig) => {
  const real = await orig<typeof import('../../../nav')>()
  return {
    ...real,
    nav: { ...real.nav, push: (route: string) => { seen.pushed.push(route) }, back: async () => {}, setLeaveGuard: () => {} },
    useParams: () => ({ id: 'c1', messageId: 'a1' }),
    useRoute: () => ({ key: 'edit' }),
    useLeaveGuard: () => {},
    useSheet: () => ({ props: { chatId: 'c1', messageId: 'a1' }, close: () => {} }),
  }
})
vi.mock('../../../ui', async (orig) => ({ ...(await orig<typeof import('../../../ui')>()), toast: () => {} }))

import MessageEditPage from '../MessageEditPage'
import MessageSheet from '../MessageSheet'
import { useChatStore } from '../../../../stores/chatStore'
import { beginReplyWrite, useReplyWriteStore } from '../../../../stores/replyWriteStore'

const stored = () => useChatStore.getState().conversations[0].messages[0].content

beforeEach(() => {
  seen.pushed = []
  useReplyWriteStore.setState({ open: {} })
  useChatStore.setState({
    activeConversationId: 'c1',
    conversations: [{ id: 'c1', title: 't', model: 'm', systemPrompt: '', createdAt: 1, updatedAt: 1, messages: [{ id: 'a1', role: 'assistant', content: 'A stopped answer', timestamp: 1 }] }] as never,
  })
})
afterEach(cleanup)

describe('the way into the edit', () => {
  it('is shut while the stopped run still writes, and opens when it has ended', () => {
    const end = beginReplyWrite('a1')
    render(<MessageSheet />)
    fireEvent.click(screen.getByTestId('m-chat-message-edit'))
    expect(seen.pushed).toEqual([])
    act(() => end())
    fireEvent.click(screen.getByTestId('m-chat-message-edit'))
    expect(seen.pushed).toEqual(['/chat/:id/message/:messageId/edit'])
  })
})

describe('Save on the edit page', () => {
  it('writes nothing while the run still writes, and saves once it has ended', () => {
    const end = beginReplyWrite('a1')
    render(<MessageEditPage />)
    fireEvent.change(screen.getByTestId('m-chat-edit-field'), { target: { value: 'My edit' } })
    fireEvent.click(screen.getByTestId('m-chat-edit-save'))
    expect(stored()).toBe('A stopped answer')
    act(() => end())
    fireEvent.click(screen.getByTestId('m-chat-edit-save'))
    expect(stored()).toBe('My edit')
  })
})
