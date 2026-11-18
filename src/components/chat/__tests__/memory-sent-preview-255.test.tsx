// @vitest-environment jsdom
/**
 * GH #255 (3.1.2): the brain icon shows what the last request of THIS chat
 * carried, in full, with the ones left out named; each memory has a pin
 * "always send"; Settings > Memory has the switch for sending, the token
 * budget, the length of one memory and the switch of the open chat.
 *
 * Run: npx vitest run src/components/chat/__tests__/memory-sent-preview-255.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => null),
  isTauri: () => false,
  isMacOS: () => false,
  openExternal: vi.fn(),
}))

import { useMemoryStore, __setMemoryEmbedFn } from '../../../stores/memoryStore'
import { useChatStore } from '../../../stores/chatStore'
import { MemoryDebugToggle } from '../MemoryDebugPanel'
import { MemorySettings } from '../../settings/MemorySettings'

const SETTINGS = { autoExtractEnabled: false, autoExtractInAllModes: false, maxMemoriesInPrompt: 10, maxMemoryChars: 3000 }
const LONG = 'A'.repeat(900) + ' The red umbrella stayed on the bench.'

function openPopover() {
  render(<MemoryDebugToggle />)
  fireEvent.click(screen.getByTitle('Memory: view, add or delete the context injected into prompts'))
}

let convId = ''
beforeEach(() => {
  __setMemoryEmbedFn(async (texts) => texts.map(() => []))
  useMemoryStore.setState({ entries: [], forgotten: [], pinnedMemoryIds: [], lastInjection: {}, activeMemoryOwner: null, settings: { ...SETTINGS } })
  convId = useChatStore.getState().createConversation('model-a', '')
  useChatStore.getState().setActiveConversation(convId)
  const add = (title: string, content: string) => useMemoryStore.getState().addMemory({ type: 'user', title, description: '', content, tags: [], source: 'manual' })
  add('Umbrella day', LONG)
  add('Tea', 'Mara likes tea')
})
afterEach(() => cleanup())

describe('brain icon: the last request of this chat', () => {
  it('shows nothing before this chat sent a request', () => {
    openPopover()
    expect(screen.queryByTestId('memory-sent-preview')).toBeNull()
  })

  it('shows the count, the tokens and the whole block, not 800 characters of it', async () => {
    await useMemoryStore.getState().getMemoryContextAsync('umbrella', 8192, { conversationId: convId })
    openPopover()
    expect(screen.getByTestId('memory-sent-summary').textContent).toMatch(/^1 of 2 sent, [\d,]+ \/ [\d,]+ tokens$/)
    expect(screen.getByTestId('memory-sent-preview').textContent).toContain('The red umbrella stayed on the bench.')
  })

  it('names the ones the budget left out', async () => {
    useMemoryStore.setState({ settings: { ...SETTINGS, memoryTokenBudget: 120 } })
    await useMemoryStore.getState().getMemoryContextAsync('', 8192, { conversationId: convId })
    openPopover()
    expect(screen.getByTestId('memory-sent-preview').textContent).toContain('Left out: Umbrella day')
  })

  it('says so when this chat sends no memories', async () => {
    await useMemoryStore.getState().getMemoryContextAsync('tea', 8192, { conversationId: convId, chatOff: true })
    openPopover()
    expect(screen.getByTestId('memory-sent-summary').textContent).toBe('Memories are switched off for this chat')
  })

  it('the pin on a row makes the memory "always send"', () => {
    openPopover()
    fireEvent.click(screen.getByLabelText('Pin Tea'))
    const tea = useMemoryStore.getState().entries.find((e) => e.title === 'Tea')!
    expect(useMemoryStore.getState().pinnedMemoryIds).toEqual([tea.id])
    expect(screen.getByLabelText('Unpin Tea').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Settings > Memory', () => {
  it('has the switch for sending, the token budget, the length and the switch of this chat', () => {
    render(<MemorySettings />)
    fireEvent.click(screen.getByTestId('memory-inject-enabled'))
    expect(useMemoryStore.getState().settings.injectEnabled).toBe(false)
    fireEvent.change(screen.getByTestId('memory-token-budget'), { target: { value: '30000' } })
    expect(useMemoryStore.getState().settings.memoryTokenBudget).toBe(30000)
    fireEvent.change(screen.getByTestId('memory-token-budget'), { target: { value: '' } })
    expect(useMemoryStore.getState().settings.memoryTokenBudget).toBeNull()
    fireEvent.change(screen.getByTestId('memory-max-chars'), { target: { value: '6000' } })
    expect(useMemoryStore.getState().settings.maxMemoryChars).toBe(6000)
    fireEvent.click(screen.getByTestId('memory-chat-send'))
    expect(useChatStore.getState().conversations.find((c) => c.id === convId)?.memoryOff).toBe(true)
    fireEvent.click(screen.getByTestId('memory-chat-send'))
    expect(useChatStore.getState().conversations.find((c) => c.id === convId)?.memoryOff).toBeUndefined()
  })
})
