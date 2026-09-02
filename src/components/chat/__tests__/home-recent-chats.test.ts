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
 * only holds the one rule that connects it to the panel: it stands in the main
 * area while the panel is collapsed, and nowhere while the panel is open.
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
import type { Conversation } from '../../../types/chat'

// The composer's dictation button reaches for the microphone and the Tauri
// bridge on mount. Neither exists here and neither is what this file is about.
vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)
const conv = (id: string, title: string, updatedAt: number): Conversation => ({
  id, title, messages: [], model: 'test-model', systemPrompt: '', mode: 'lu',
  createdAt: updatedAt, updatedAt,
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

  it('COUNTER-TEST: an open conversation replaces the home screen entirely', () => {
    // The list belongs to the empty state. Once a chat is open the transcript
    // owns the area, collapsed panel or not.
    useChatStore.setState({ activeConversationId: 'a' })
    render(createElement(ChatView))
    expect(screen.queryByTestId('home-recent-chats')).toBeNull()
  })
})
