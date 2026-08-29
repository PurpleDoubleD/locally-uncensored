/**
 * Befund 4 of the abnahme counter-check on the 2.6.7 Windows build
 * (2026-08-29, ergebnis-abnahme-durchklick.md).
 *
 * The tester switched the model mid-chat. The wire of that same turn carried
 * model=Qwen3-4B-Q4_K_M, correctly, and the saved chat still read
 * "openai::Hermes-3-Llama-3.2-3B" (wire-p3b.txt). The request was right; the
 * record was not, and the record is what an export, a reopened chat and every
 * later reader see.
 *
 * Pure bookkeeping, so it is fixed as bookkeeping: every path that changes
 * the selection goes through modelStore.setActiveModel, and that is where the
 * open chat is told.
 *
 * Run: npx vitest run src/stores/__tests__/conversation-model-follows-switch.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => false),
  backendCall: vi.fn(async () => undefined),
}))
vi.mock('../../api/ollama', () => ({ unloadModel: vi.fn(async () => undefined) }))
vi.mock('../../api/lmstudio', () => ({ unloadLmStudioModel: vi.fn(async () => undefined) }))
vi.mock('../../api/engine', () => ({ activateBuiltinModel: vi.fn(async () => undefined) }))

import { useModelStore } from '../modelStore'
import { useChatStore } from '../chatStore'

const HERMES = 'openai::Hermes-3-Llama-3.2-3B.Q4_K_M'
const QWEN = 'openai::Qwen3-4B-Q4_K_M'

const openChat = (model: string) => {
  const id = useChatStore.getState().createConversation(model, '')
  return id
}

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useModelStore.setState({ models: [], activeModel: null })
})

describe('the open chat records the model it is actually running on', () => {
  it('THE FIX: the exact counter-check frame, Hermes chat switched to Qwen3', () => {
    useModelStore.setState({ activeModel: HERMES })
    const id = openChat(HERMES)

    useModelStore.getState().setActiveModel(QWEN)

    expect(useChatStore.getState().conversations.find((c) => c.id === id)!.model).toBe(QWEN)
  })

  it('NEGATIVE CONTROL: the chats beside it are not rewritten', () => {
    const other = openChat(HERMES)
    const open = openChat(HERMES)
    useChatStore.setState({ activeConversationId: open })
    useModelStore.setState({ activeModel: HERMES })

    useModelStore.getState().setActiveModel(QWEN)

    const byId = new Map(useChatStore.getState().conversations.map((c) => [c.id, c.model]))
    expect(byId.get(open)).toBe(QWEN)
    expect(byId.get(other)).toBe(HERMES)
  })

  it('NEGATIVE CONTROL: no open chat is not an error, and writes nothing', () => {
    openChat(HERMES)
    useChatStore.setState({ activeConversationId: null })

    expect(() => useModelStore.getState().setActiveModel(QWEN)).not.toThrow()
    expect(useChatStore.getState().conversations[0].model).toBe(HERMES)
  })

  it('NEGATIVE CONTROL: clearing the selection does not blank the record', () => {
    // The Local/Cloud switch clears the pick when the new mode has nothing to
    // offer. That is a state of the picker, not a statement about the chat.
    const id = openChat(HERMES)
    useModelStore.setState({ activeModel: HERMES })

    useModelStore.getState().setActiveModel(null)

    expect(useChatStore.getState().conversations.find((c) => c.id === id)!.model).toBe(HERMES)
  })

  it('NEGATIVE CONTROL: picking a model does not move the chat up the sidebar', () => {
    // updatedAt orders the list. Choosing a model is not activity in the chat.
    const id = openChat(HERMES)
    const before = useChatStore.getState().conversations.find((c) => c.id === id)!.updatedAt
    useModelStore.setState({ activeModel: HERMES })

    useModelStore.getState().setActiveModel(QWEN)

    expect(useChatStore.getState().conversations.find((c) => c.id === id)!.updatedAt).toBe(before)
  })

  it('NEGATIVE CONTROL: re-picking the same model touches no state at all', () => {
    const id = openChat(QWEN)
    const before = useChatStore.getState().conversations
    useModelStore.setState({ activeModel: HERMES })

    useModelStore.getState().setActiveModel(QWEN)

    // Same array identity: nothing to write means no persist round either.
    expect(useChatStore.getState().conversations).toBe(before)
    expect(useChatStore.getState().conversations.find((c) => c.id === id)!.model).toBe(QWEN)
  })

  it('a first pick with no previous model is recorded too', () => {
    // setActiveModel returns early on the VRAM handling when there was no
    // previous model. The record must still be written.
    const id = openChat(HERMES)
    useModelStore.setState({ activeModel: null })

    useModelStore.getState().setActiveModel(QWEN)

    expect(useChatStore.getState().conversations.find((c) => c.id === id)!.model).toBe(QWEN)
  })
})
