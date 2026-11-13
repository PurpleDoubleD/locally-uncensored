// @vitest-environment jsdom
/**
 * GH #198: the chat's Sampling popup keeps this chat's own custom rows, shows
 * which ones come from the persona, and Reset clears the chat's rows too.
 *
 * Run: npx vitest run src/components/chat/__tests__/custom-params-in-the-sampling-popup.test.tsx
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useChatStore } from '../../../stores/chatStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useModelStore } from '../../../stores/modelStore'
import { SamplingControls } from '../SamplingControls'

const conversation = {
  id: 'c1', title: 'c1', messages: [], model: 'm', systemPrompt: '', createdAt: 0, updatedAt: 0,
  personaId: 'baron', personaEnabled: true,
}
const baron = {
  id: 'baron', name: 'Baron', icon: 'User', systemPrompt: 'You are Baron.', isBuiltIn: false,
  customParams: [{ key: 'xtc_threshold', type: 'number' as const, value: '0.1' }, { key: 'temperature', type: 'number' as const, value: '1.9' }],
}

beforeEach(() => {
  useChatStore.setState({ conversations: [conversation] as never, activeConversationId: 'c1' })
  useSettingsStore.setState({ personas: [baron] })
  useSettingsStore.getState().updateSettings({ personasEnabled: true })
  useModelStore.setState({ activeModel: 'ollama::qwen3:4b' })
})
afterEach(cleanup)

const conv = () => useChatStore.getState().conversations.find((c) => c.id === 'c1')!

describe('custom rows in the Sampling popup', () => {
  it('a row typed here is this chat\'s own, and the persona\'s keys are named', () => {
    render(<SamplingControls />)
    fireEvent.click(screen.getByTestId('sampling-trigger'))
    expect(screen.getByTestId('custom-params-inherited').textContent).toBe('From persona Baron: xtc_threshold')
    fireEvent.click(screen.getByTestId('custom-param-add'))
    fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'dry_base' } })
    fireEvent.change(screen.getByLabelText('Parameter value'), { target: { value: '1.75' } })
    expect(conv().customParams).toEqual([{ key: 'dry_base', type: 'number', value: '1.75' }])
    // The speaker line lists both, the chat's and the persona's.
    const line = screen.getByTestId('sampling-speaker').textContent ?? ''
    expect(line).toContain('dry_base 1.75')
    expect(line).toContain('xtc_threshold 0.1')
    expect(screen.getByTestId('sampling-changed-marker')).toBeTruthy()
  })

  it('Reset clears the chat\'s rows, the persona keeps its own', () => {
    useChatStore.getState().setConversationCustomParams('c1', [{ key: 'dry_base', type: 'number', value: '2' }])
    render(<SamplingControls />)
    fireEvent.click(screen.getByTestId('sampling-trigger'))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(conv().customParams).toBeUndefined()
    expect(useSettingsStore.getState().personas[0].customParams).toHaveLength(2)
  })
})
