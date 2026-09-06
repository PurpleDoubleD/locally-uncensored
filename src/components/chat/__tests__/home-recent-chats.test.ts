/**
 * @vitest-environment jsdom
 *
 * The empty chat screen, mounted for real (2.6.8, David).
 *
 * "auch die Latest Chats dann im Hauptscreen wie in der Webapp, ausser man
 *  klappt das Sidepanel auf."
 *
 * The list itself is covered in
 * src/components/layout/__tests__/sidebar-collapse-parity.test.ts. This file
 * holds the rule that connects it to the panel: it stands in the main area
 * while the panel is collapsed, and nowhere while the panel is open.
 *
 * Widened after the screen check on the bundle (David, 2026-09-02): the list
 * only stood on the no-chat screen, so New Chat led to a blank main area. It
 * has to stand above the composer for as long as the open chat is still empty,
 * and go the moment the first message is sent.
 *
 * Run: npx vitest run src/components/chat/__tests__/home-recent-chats.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatView } from '../ChatView'
import { useUIStore } from '../../../stores/uiStore'
import { useChatStore } from '../../../stores/chatStore'
import { useCompareStore } from '../../../stores/compareStore'
import type { Conversation, Message } from '../../../types/chat'

// The composer's dictation button reaches for the microphone and the Tauri
// bridge on mount. Neither exists here and neither is what this file is about.
vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)
const conv = (id: string, title: string, updatedAt: number): Conversation => ({
  id, title, messages: [], model: 'test-model', systemPrompt: '', mode: 'lu',
  createdAt: updatedAt, updatedAt,
})

const said = (text: string): Message => ({
  id: `m-${text}`, role: 'user', content: text, timestamp: NOW,
})

beforeEach(() => {
  useUIStore.setState({ currentView: 'chat', sidebarOpen: false })
  useCompareStore.setState({ isComparing: false })
  useChatStore.setState({
    conversations: [conv('a', 'Yesterdays thread', NOW - 3600_000)],
    activeConversationId: null,
  })
})

afterEach(() => {
  cleanup()
})

describe('the latest chats on the home screen', () => {
  it('collapsed panel: the list stands in the main area', () => {
    render(createElement(ChatView))
    const list = screen.getByTestId('home-recent-chats')
    expect(list.textContent).toContain('Yesterdays thread')
  })

  it('expanded panel: the list is gone from the main area', () => {
    // Not hidden, not empty: absent. Expanded it lives in the side panel, and
    // the same list twice on one screen is the thing to avoid.
    useUIStore.setState({ sidebarOpen: true })
    render(createElement(ChatView))
    expect(screen.queryByTestId('home-recent-chats')).toBeNull()
  })

  it('a click on a row opens that chat, so the screen is a launcher', () => {
    render(createElement(ChatView))
    fireEvent.click(screen.getByText('Yesterdays thread'))
    expect(useChatStore.getState().activeConversationId).toBe('a')
  })

})

describe('an open but still empty chat', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [conv('a', 'Yesterdays thread', NOW - 3600_000), conv('fresh', 'New Chat', NOW)],
      activeConversationId: 'fresh',
    })
  })

  it('collapsed panel: the list stands above the composer', () => {
    render(createElement(ChatView))
    const list = screen.getByTestId('home-recent-chats')
    expect(list.textContent).toContain('Yesterdays thread')
    // The composer is still there, at the bottom, and the list did not replace it.
    expect(document.querySelector('textarea')).toBeTruthy()
  })

  it('the chat you are in is not offered as somewhere to go', () => {
    render(createElement(ChatView))
    expect(screen.getByTestId('home-recent-chats').textContent).not.toContain('New Chat')
  })

  it('the first message clears it', () => {
    useChatStore.setState({
      conversations: [
        conv('a', 'Yesterdays thread', NOW - 3600_000),
        { ...conv('fresh', 'New Chat', NOW), messages: [said('hello')] },
      ],
      activeConversationId: 'fresh',
    })
    render(createElement(ChatView))
    expect(screen.queryByTestId('home-recent-chats')).toBeNull()
  })

  it('COUNTER-TEST: expanded panel, no list even in an empty chat', () => {
    useUIStore.setState({ sidebarOpen: true })
    render(createElement(ChatView))
    expect(screen.queryByTestId('home-recent-chats')).toBeNull()
  })

  it('COUNTER-TEST: a system prompt is not something the user said', () => {
    // The count has to match what MessageList shows, or a chat with a persona
    // would come up looking used before anybody typed anything.
    useChatStore.setState({
      conversations: [
        conv('a', 'Yesterdays thread', NOW - 3600_000),
        {
          ...conv('fresh', 'New Chat', NOW),
          messages: [{ id: 'sys', role: 'system', content: 'You are blunt.', timestamp: NOW }],
        },
      ],
      activeConversationId: 'fresh',
    })
    render(createElement(ChatView))
    expect(screen.getByTestId('home-recent-chats')).toBeTruthy()
  })

  it('COUNTER-TEST: a remote session keeps its own screen', () => {
    // Remote has its own banners and its own state under the transcript. A
    // recent-chats list on top of that is noise, not a launcher.
    useChatStore.setState({
      conversations: [
        conv('a', 'Yesterdays thread', NOW - 3600_000),
        { ...conv('fresh', 'Dispatched', NOW), mode: 'remote' },
      ],
      activeConversationId: 'fresh',
    })
    render(createElement(ChatView))
    expect(screen.queryByTestId('home-recent-chats')).toBeNull()
  })
})
