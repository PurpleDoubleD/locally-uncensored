// @vitest-environment jsdom
/**
 * C77: the context button of an API model whose server names no window lets
 * the user set the model window and says where the number comes from.
 *
 * Run: npx vitest run src/components/chat/__tests__/c77-api-model-window-picker.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ActiveContext } from '../../../hooks/useActiveContextWindow'

let ctx: ActiveContext

vi.mock('../../../hooks/useActiveContextWindow', () => ({
  useActiveContextWindow: () => ctx,
  useActiveWindowUse: () => 'chat',
}))

import { ContextDropdown } from '../ContextDropdown'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'

const KEY = 'https://api.example-llm.test/v1|vendor/brand-new-model-x'

function apiModel(overrides: Partial<ActiveContext> = {}): ActiveContext {
  return {
    provider: 'cloud', contextWindow: 8192, modelMax: 8192, sendWindow: 6553, isTrue: false,
    adjustable: true, sendAdjustable: true, source: 'guess', windowKey: 'openai:x::vendor/brand-new-model-x',
    modelWindow: 8192, modelWindowSource: 'guess', modelWindowSettable: true, modelWindowKey: KEY,
    ...overrides,
  }
}

beforeEach(() => {
  cleanup()
  ctx = apiModel()
  useModelStore.setState({ activeModel: 'openai:x::vendor/brand-new-model-x' })
  useSettingsStore.getState().updateSettings({ contextWindowByModel: {}, cloudSendWindowByModel: {}, contextDecay: true })
})

describe('C77: the model window of an API model', () => {
  it('names the source in the button and offers the model window', () => {
    render(<ContextDropdown />)
    const button = screen.getByRole('button', { name: /^Context window/ })
    expect(button.getAttribute('title')).toMatch(/Model context window: 8K, estimated\./)
    fireEvent.click(button)
    const section = screen.getByTestId('context-model-window')
    expect(section.textContent).toMatch(/Model context window/)
    expect(section.textContent).toMatch(/Now 8K, estimated\. This API does not report the model's context window/)
    // The send window list is still there, with its own heading.
    expect(screen.getByText('Sent per message')).toBeTruthy()
  })

  it('a pick is saved for this model under its endpoint key', () => {
    render(<ContextDropdown />)
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))
    const section = screen.getByTestId('context-model-window')
    const rows = Array.from(section.querySelectorAll('button'))
    const k128 = rows.find((b) => b.textContent?.trim() === '128K')!
    fireEvent.click(k128)
    expect(useSettingsStore.getState().settings.contextWindowByModel?.[KEY]).toBe(131072)
    // The send window was not touched.
    expect(useSettingsStore.getState().settings.cloudSendWindowByModel).toEqual({})
  })

  it('with the user value it says "set by you"', () => {
    ctx = apiModel({ modelWindow: 131072, modelWindowSource: 'user', contextWindow: 131072, modelMax: 131072 })
    useSettingsStore.getState().updateSettings({ contextWindowByModel: { [KEY]: 131072 } })
    render(<ContextDropdown />)
    const button = screen.getByRole('button', { name: /^Context window/ })
    expect(button.getAttribute('title')).toMatch(/Model context window: 128K, set by you\./)
  })

  it('a server that names its window keeps the old picker, with the source said', () => {
    ctx = apiModel({ modelWindowSettable: undefined, modelWindowKey: undefined, modelWindow: 262144, modelWindowSource: 'probe', contextWindow: 262144, modelMax: 262144 })
    render(<ContextDropdown />)
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))
    expect(screen.queryByTestId('context-model-window')).toBeNull()
    expect(screen.getByText(/Model window 256K, from server\./)).toBeTruthy()
  })
})
