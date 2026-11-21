// @vitest-environment jsdom
/**
 * Sharing a chat with the paired phone (CHATS-V1.md) at the desktop: the
 * button in the chat's strip, the setting and the list in the Remote
 * settings, the default for new chats, and the mark in the chat list.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { useChatStore } from '../../../stores/chatStore'
import { useCodexStore } from '../../../stores/codexStore'
import { useRemoteStore } from '../../../stores/remoteStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { ContinueOnPhoneButton } from '../ContinueOnPhoneButton'
import { SharedChatsSettings } from '../../settings/SharedChatsSettings'
import { toSidebarRow, sameSidebarRows } from '../../layout/sidebar-rows'

afterEach(() => {
  cleanup()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useRemoteStore.setState({ pairedDevices: [], connectedDevices: [] })
  useSettingsStore.getState().updateSettings({ shareNewChatsWithPhone: false })
})

describe('Continue on phone', () => {
  it('with no phone paired, leads to the Remote setup and shares nothing', async () => {
    const id = useChatStore.getState().createConversation('qwen', '')
    useRemoteStore.setState({ pairedDevices: [], connectedDevices: [], dispatchedConversationId: null })
    render(<ContinueOnPhoneButton />)
    expect(screen.getByTestId('continue-on-phone').getAttribute('title')).toBe('Set up your phone')
    fireEvent.click(screen.getByTestId('continue-on-phone'))
    await waitFor(() => expect(useCodexStore.getState().chatMode).toBe('remote'))
    expect(useChatStore.getState().activeConversationId).toBeNull()
    expect(useChatStore.getState().conversations.find((c) => c.id === id)?.remoteShared).toBeUndefined()
    useCodexStore.getState().setChatMode('lu')
  })

  it('shares the open chat and ends it again', async () => {
    const id = useChatStore.getState().createConversation('qwen', '')
    expect(useChatStore.getState().conversations[0].remoteShared).toBeUndefined()
    useRemoteStore.setState({ pairedDevices: [{ device_id: 'p1' }] as never })
    render(<ContinueOnPhoneButton />)
    const button = screen.getByTestId('continue-on-phone')
    expect(button.getAttribute('aria-label')).toBe('Continue on phone')
    fireEvent.click(button)
    await waitFor(() => expect(useChatStore.getState().conversations.find((c) => c.id === id)?.remoteShared).toBe(true))
    await waitFor(() => expect(screen.getByTestId('continue-on-phone').getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(screen.getByTestId('continue-on-phone'))
    expect(useChatStore.getState().conversations.find((c) => c.id === id)?.remoteShared).toBeUndefined()
  })

  it('"Share new chats with paired phones" is off by default and shares the next new chat when on', () => {
    expect(useSettingsStore.getState().settings.shareNewChatsWithPhone).toBe(false)
    render(<SharedChatsSettings />)
    expect(screen.getByText(/No chat is shared yet/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Share new chats with paired phones'))
    expect(useSettingsStore.getState().settings.shareNewChatsWithPhone).toBe(true)
    useChatStore.getState().createConversation('qwen', '')
    expect(useChatStore.getState().conversations[0].remoteShared).toBe(true)
  })

  it('lists the shared chats and ends sharing per chat', () => {
    const a = useChatStore.getState().createConversation('qwen', '')
    useChatStore.getState().renameConversation(a, 'Trip plan')
    useChatStore.getState().setRemoteShared(a, true)
    useChatStore.getState().createConversation('qwen', '')
    render(<SharedChatsSettings />)
    expect(screen.getByText('Trip plan')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Stop sharing Trip plan with your phone'))
    expect(useChatStore.getState().conversations.some((c) => c.remoteShared)).toBe(false)
    expect(screen.getByText(/No chat is shared yet/)).toBeTruthy()
  })

  it('the chat list row carries the mark, and a change of it repaints the row', () => {
    const id = useChatStore.getState().createConversation('qwen', '')
    const before = useChatStore.getState().conversations.map(toSidebarRow)
    expect(before[0].shared).toBe(false)
    useChatStore.getState().setRemoteShared(id, true)
    const after = useChatStore.getState().conversations.map(toSidebarRow)
    expect(after[0].shared).toBe(true)
    expect(sameSidebarRows(before, after)).toBe(false)
  })
})
