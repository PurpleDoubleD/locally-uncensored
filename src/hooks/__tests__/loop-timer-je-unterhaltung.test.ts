/**
 * @vitest-environment jsdom
 *
 * B2 Commit 4: the pending `/loop` timer belongs to its OWN conversation, not
 * to whichever conversation last scheduled one.
 *
 * Before this, `agentLoopTimer` (useAgentChat.ts) and `codexLoopTimer`
 * (useCodex.ts) were each a single module VARIABLE. Conversation A schedules
 * its next pass and gets a handle; conversation B schedules ITS next pass
 * and OVERWRITES the same variable with its own handle. Two consequences,
 * both real:
 *
 *  - The two timers cannot coexist as far as the app can see: asking "is a
 *    pass still pending for A" after B scheduled one always answered with
 *    B's handle, never A's: there was only ever one answer for the whole
 *    app, not one per conversation.
 *  - Stop pressed for A, while B's handle is the one currently held, clears
 *    B's real browser timer by mistake and leaves A's own timer orphaned,
 *    unreachable, but still counting down on its own, because a JS timer
 *    fires independently of whether anything still references its id.
 *
 * A real fetch-count race is fought over by a SEPARATE, pre-existing rule
 * (a pass whose conversation is not the visible one is deferred/dropped, see
 * useAgentChat.ts and useCodex.ts), so counting `/chat/completions` calls
 * here would prove that rule instead of this one. This file asks the
 * question directly instead, through a test-only peek at the timer map's
 * own keys, the same shape of proof `run-lanes.ts`'s and `run-stop.ts`'s
 * own tests use for module-private state.
 *
 * Run: npx vitest run src/hooks/__tests__/loop-timer-je-unterhaltung.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/cloud/supabase', () => ({
  getAccessToken: async () => 'session-token-abc',
}))
vi.mock('../../api/rag', () => ({
  retrieveContext: async () => ({ context: { chunks: [], query: '', documentIds: [] }, scoredChunks: [] }),
  generateEmbeddings: async () => [[0.1, 0.2]],
}))
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useChat } from '../useChat'
import { __pendingAgentLoopTimersForTests } from '../useAgentChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useAgentTaskStore } from '../../stores/agentTaskStore'
import { useAgentLoopStore } from '../../stores/agentLoopStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useTodoStore } from '../../stores/todoStore'
import { useToolAuditStore } from '../../stores/toolAuditStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { __resetRunStopsForTests } from '../../lib/run-stop'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

const sse = (payload: object) =>
  new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
const textZug = () => sse({ choices: [{ delta: { content: 'weiter beim naechsten Mal' } }] })

function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  // 3.1.2: a chat without a workspace asks first (lib/agent-workspace-ask.ts).
  useAgentModeStore.getState().setWorkspace(convId, { kind: 'sandbox' })
  return convId
}

beforeEach(async () => {
  const { registerBuiltinTools, toolRegistry } = await import('../../api/mcp')
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentModeStore.setState({ agentModeActive: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useToolAuditStore.setState({ entries: {} })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' },
  })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
  useModelStore.setState({ models: [], activeModel: MODEL })
})
afterEach(() => vi.restoreAllMocks())

describe('a pending loop timer belongs to its own conversation', () => {
  it('two conversations each hold their own pending timer at once', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      return textZug()
    })

    const { result } = renderHook(() => useChat())
    const convA = seed()
    await act(async () => { await result.current.sendMessage('/loop 1s zaehle weiter') })
    const convB = seed()
    await act(async () => { await result.current.sendMessage('/loop 1s zaehle weiter') })

    // Both pending at once, a single shared variable could only ever have
    // shown the LATER of the two.
    const pending = __pendingAgentLoopTimersForTests()
    expect(pending).toContain(convA)
    expect(pending).toContain(convB)
  })

  it("stopping A cancels only A's timer; B's stays pending, untouched", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      return textZug()
    })

    const { result } = renderHook(() => useChat())
    const convA = seed()
    await act(async () => { await result.current.sendMessage('/loop 1s zaehle weiter') })
    const convB = seed()
    await act(async () => { await result.current.sendMessage('/loop 1s zaehle weiter') })
    expect(__pendingAgentLoopTimersForTests()).toContain(convA)
    expect(__pendingAgentLoopTimersForTests()).toContain(convB)

    // View is on B right now (seed() switched it there); go back to A and
    // press Stop there. B was the LAST conversation to schedule a timer,
    // exactly the shape that clobbered a shared module variable before.
    useChatStore.getState().setActiveConversation(convA)
    act(() => { result.current.stopGeneration() })

    const pending = __pendingAgentLoopTimersForTests()
    expect(pending).not.toContain(convA)
    expect(pending).toContain(convB)
  })
})
