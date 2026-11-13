// @vitest-environment jsdom
/**
 * U5: the context list shows what fills the window, and warns calmly when a
 * local model's agent window is small, with one click to 32K through the
 * same setting the list itself writes.
 *
 * Run: npx vitest run src/components/chat/__tests__/u5-context-breakdown-dropdown.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ActiveContext } from '../../../hooks/useActiveContextWindow'

const reloadOllamaWithWindow = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('../../../api/ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/ollama')>()),
  reloadOllamaWithWindow: (...a: unknown[]) => reloadOllamaWithWindow(...a),
  readLoadedModels: async () => [],
}))
const loadLmStudioModel = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('../../../api/lmstudio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/lmstudio')>()),
  loadLmStudioModel: (...a: unknown[]) => loadLmStudioModel(...a),
}))

let ctx: ActiveContext
let use: 'chat' | 'agent' = 'agent'
vi.mock('../../../hooks/useActiveContextWindow', () => ({
  useActiveContextWindow: () => ctx,
  useActiveWindowUse: () => use,
}))

import { ContextDropdown } from '../ContextDropdown'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useChatStore } from '../../../stores/chatStore'
import { publishStepBreakdown, useContextBreakdownStore } from '../../../stores/contextBreakdownStore'

const OLLAMA = 'qwen3:8b'
const LMS = 'openai::gemma-4-31b-it-2'

function ollama(window: number): ActiveContext {
  return {
    provider: 'ollama', contextWindow: window, modelMax: 131072, sendWindow: window,
    isTrue: true, adjustable: true, source: 'probe', windowKey: '',
  }
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))

let convId = ''
beforeEach(() => {
  cleanup()
  reloadOllamaWithWindow.mockClear()
  loadLmStudioModel.mockClear()
  use = 'agent'
  ctx = ollama(32768)
  useModelStore.setState({ activeModel: OLLAMA })
  useSettingsStore.getState().updateSettings({ contextWindowOverride: 0, contextWindowByModel: {}, autoCompact: true, autoCompactThreshold: 0 })
  useContextBreakdownStore.setState({ byConv: {} })
  convId = useChatStore.getState().createConversation(OLLAMA, '', 'codex')
  useChatStore.getState().addMessage(convId, { id: 'u1', role: 'user', content: 'Fix the failing test in src/a.ts', timestamp: 1 })
})

describe('the breakdown', () => {
  it('lists every kind, free space, and says "about" before the first step', () => {
    render(<ContextDropdown />)
    open()
    const panel = screen.getByTestId('context-breakdown')
    for (const label of ['System prompt', 'Tools', 'Project files', 'Memory', 'Conversation', 'Tool results', 'Free']) {
      expect(within(panel).getByText(label)).toBeTruthy()
    }
    expect(screen.getByTestId('context-breakdown-total').textContent).toMatch(/^about .+ of 32K$/)
    // The agent's own parts are not made up before it ran.
    expect(within(screen.getByTestId('context-row-tools')).getByText('not yet')).toBeTruthy()
    expect(within(panel).getByText(/The rest shows after the first step/)).toBeTruthy()
    // 32K model window: auto-compact runs, and its mark is drawn.
    expect(screen.getByTestId('context-breakdown-threshold')).toBeTruthy()
    expect(within(panel).getByText(/Compacts by itself near/)).toBeTruthy()
  })

  it('shows the last step as sent, without "about"', () => {
    publishStepBreakdown(convId, [
      { role: 'system', content: 'You are the coding agent.'.repeat(40) },
      { role: 'user', content: 'Fix it' },
      { role: 'tool', content: 'file body '.repeat(200) },
    ], 2048)
    render(<ContextDropdown />)
    open()
    expect(screen.getByTestId('context-breakdown-total').textContent).not.toMatch(/about/)
    expect(within(screen.getByTestId('context-row-tools')).getByText('2K')).toBeTruthy()
    expect(within(screen.getByTestId('context-row-system')).queryByText('not yet')).toBeNull()
    expect(screen.getByText(/From the last step that was sent\./)).toBeTruthy()
  })
})

describe('the small window note', () => {
  it('no note and no marker at 32K', () => {
    render(<ContextDropdown />)
    expect(screen.queryByTestId('context-small-window-mark')).toBeNull()
    open()
    expect(screen.queryByTestId('context-small-window')).toBeNull()
  })

  it('Ollama at 8K in the Code tab: marker, one line, and Use 32K sets the num_ctx override', async () => {
    ctx = ollama(8192)
    render(<ContextDropdown />)
    expect(screen.getByTestId('context-small-window-mark')).toBeTruthy()
    open()
    const note = screen.getByTestId('context-small-window')
    expect(note.textContent).toContain('Small window: agent runs may forget files.')
    fireEvent.click(within(note).getByRole('button', { name: 'Use 32K' }))
    await waitFor(() => expect(reloadOllamaWithWindow).toHaveBeenCalledWith(OLLAMA, 'agent'))
    // The same setting the list writes, no second one.
    expect(useSettingsStore.getState().settings.contextWindowOverride).toBe(32768)
  })

  it('LM Studio: the fix is saved per model, like a pick from the list', async () => {
    ctx = { ...ollama(8192), provider: 'lmstudio', modelMax: 262144 }
    useModelStore.setState({ activeModel: LMS })
    render(<ContextDropdown />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Use 32K' }))
    await waitFor(() => expect(loadLmStudioModel).toHaveBeenCalledWith('gemma-4-31b-it-2', 32768))
    expect(useSettingsStore.getState().settings.contextWindowOverride).toBe(0)
    expect(Object.values(useSettingsStore.getState().settings.contextWindowByModel ?? {})).toContain(32768)
  })

  it('not in a plain chat, and never for a cloud model', () => {
    ctx = ollama(8192)
    use = 'chat'
    render(<ContextDropdown />)
    open()
    expect(screen.queryByTestId('context-small-window')).toBeNull()
    cleanup()

    use = 'agent'
    ctx = { ...ollama(8192), provider: 'cloud', windowKey: 'lu-cloud|m', sendAdjustable: true, modelWindow: 8192 }
    useModelStore.setState({ activeModel: 'lu-cloud::m' })
    render(<ContextDropdown />)
    expect(screen.queryByTestId('context-small-window-mark')).toBeNull()
    open()
    expect(screen.queryByTestId('context-small-window')).toBeNull()
  })

  it('a server LU does not start gets the note without the button', () => {
    ctx = { ...ollama(8192), provider: 'custom', windowKey: 'http://127.0.0.1:8131|m' }
    render(<ContextDropdown />)
    open()
    const note = screen.getByTestId('context-small-window')
    expect(note.textContent).toMatch(/Start the server with 32K/)
    expect(within(note).queryByRole('button')).toBeNull()
  })
})
