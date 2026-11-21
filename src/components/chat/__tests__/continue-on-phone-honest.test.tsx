// @vitest-environment jsdom
/**
 * D8 (Discord, 02.11.): "Continue on phone" shared the chat, but nothing on
 * the phone showed it. The phone app 3.0.7 and the browser remote did not read
 * shared chats; the phone app does since 3.0.10 (M310). The desktop says so, at
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
  it('the button keeps a short tooltip, the detail stays in the settings list', () => {
    const id = useChatStore.getState().createConversation('qwen', '')
    render(<ContinueOnPhoneButton />)
    expect(screen.getByTestId('continue-on-phone').getAttribute('title')).toBe('Set up your phone')
    act(() => useChatStore.getState().setRemoteShared(id, true))
    expect(screen.getByTestId('continue-on-phone').getAttribute('title')).toBe('Stop sharing with phone')
  })

  it('the list of shared chats says it once, with what reaches the phone until then', () => {
    render(<SharedChatsSettings />)
    const note = screen.getByTestId('shared-chats-phone-note')
    expect(note.textContent).toMatch(/LU phone app \(3\.0\.10 or newer\)/)
    expect(note.textContent).toMatch(/browser remote does not show them/)
    expect(note.textContent).toMatch(/does not go back to the phone/)
  })
})
