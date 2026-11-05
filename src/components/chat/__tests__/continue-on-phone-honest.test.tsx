// @vitest-environment jsdom
/**
 * D8 (Discord, 02.11.): "Continue on phone" shared the chat, but nothing on
 * the phone showed it. The phone app 3.0.7 and the browser remote do not read
 * shared chats at all; only the next phone app does. The desktop says so, at
 * the button and above the list of shared chats.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { useChatStore } from '../../../stores/chatStore'
import { ContinueOnPhoneButton } from '../ContinueOnPhoneButton'
import { SharedChatsSettings } from '../../settings/SharedChatsSettings'

afterEach(() => {
  cleanup()
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

describe('Continue on phone says which phone shows a shared chat', () => {
  it('the button names the next phone app, shared or not', () => {
    const id = useChatStore.getState().createConversation('qwen', '')
    render(<ContinueOnPhoneButton />)
    expect(screen.getByTestId('continue-on-phone').getAttribute('title')).toMatch(/next LU phone app/)
    expect(screen.getByTestId('continue-on-phone').getAttribute('title')).toMatch(/browser remote/)
    act(() => useChatStore.getState().setRemoteShared(id, true))
    expect(screen.getByTestId('continue-on-phone').getAttribute('title')).toMatch(/^Shared with your phone\. .*next LU phone app/)
  })

  it('the list of shared chats says it once, with what reaches the phone until then', () => {
    render(<SharedChatsSettings />)
    const note = screen.getByTestId('shared-chats-phone-note')
    expect(note.textContent).toMatch(/next LU phone app/)
    expect(note.textContent).toMatch(/phone app 3\.0\.7 and the browser remote/)
    expect(note.textContent).toMatch(/does not go back to the phone/)
  })
})
