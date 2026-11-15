/**
 * @vitest-environment jsdom
 *
 * Issue 177: the Chat Reply Timeout field in Settings, General writes the
 * setting the chat transport reads (see the-chat-reply-timeout-reaches-the-
 * proxy.test.ts for the other half).
 *
 * Run: npx vitest run src/components/settings/__tests__/chat-reply-timeout-field.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatReplyTimeoutSettings } from '../ChatReplyTimeoutSettings'
import { useSettingsStore } from '../../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import { sectionsFor, type SettingsSectionFlags } from '../settings-nav'

const flagsOff: SettingsSectionFlags = {
  gpuPicker: false, builtinExpert: false, comfyui: false, agentMode: false, agentWorkflows: false,
  mediaTimeouts: false, chatTimeout: false, watchers: false,
}

const seconds = () => screen.getByLabelText('Chat reply timeout (s)') as HTMLInputElement
const off = () => screen.getByLabelText('Chat reply timeout off') as HTMLInputElement
const stored = () => useSettingsStore.getState().settings.chatFirstReplyTimeoutSeconds

beforeEach(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } }))
afterEach(() => cleanup())

describe('Chat Reply Timeout', () => {
  it('shows the default of 600 seconds', () => {
    render(createElement(ChatReplyTimeoutSettings))
    expect(seconds().value).toBe('600')
    expect(off().checked).toBe(false)
  })

  it('a typed number lands on blur, not on the first digit', () => {
    render(createElement(ChatReplyTimeoutSettings))
    fireEvent.change(seconds(), { target: { value: '1' } })
    expect(stored()).toBe(600)
    fireEvent.change(seconds(), { target: { value: '14400' } })
    fireEvent.blur(seconds())
    expect(stored()).toBe(14_400)
  })

  it('Off stores 0 and greys the number, unticking brings back the default', () => {
    render(createElement(ChatReplyTimeoutSettings))
    fireEvent.click(off())
    expect(stored()).toBe(0)
    expect(seconds().disabled).toBe(true)
    fireEvent.click(off())
    expect(stored()).toBe(600)
  })

  it('sits right before the image and video timeouts in General, and not in cloud mode', () => {
    const local = sectionsFor('general', { ...flagsOff, mediaTimeouts: true, chatTimeout: true })
    expect(local.indexOf('Chat Reply Timeout') + 1).toBe(local.indexOf('Image / Video Generation Timeouts'))
    const cloud = sectionsFor('general', flagsOff)
    expect(cloud).not.toContain('Chat Reply Timeout')
  })
})
