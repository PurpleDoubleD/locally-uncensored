/**
 * @vitest-environment jsdom
 *
 * B2 Commit 3: `/loop` in conversation A must survive a Stop pressed while
 * viewing conversation B.
 *
 * Before this, `useAgentLoopStore` held a single `loop: ActiveLoop | null`
 * slot for the WHOLE app, and `stopAgent()` called `.clear()` unconditionally
 * on every press, there was only one slot to clear, so any Stop, anywhere,
 * wiped whatever loop happened to be standing, including one running in a
 * completely different, still-live conversation. This did not need two loops
 * running at once to break: pressing Stop in an idle conversation B while A's
 * `/loop` was parked between passes already destroyed A's entry.
 *
 * Run: npx vitest run src/hooks/__tests__/agentLoopStore-zwei-unterhaltungen-teilen-sich-keinen-platz.test.ts
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
import { __resetRunStopsForTests, isRunStopped } from '../../lib/run-stop'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

const sse = (payload: object) =>
  new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })

/** A turn that ends the pass (text, no tool call) so the /loop driver gets
 *  to schedule the next one, same shape as stopp-beendet-den-agentenlauf. */
const textZug = () => sse({ choices: [{ delta: { content: 'weiter beim naechsten Mal' } }] })

function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  // 3.1.2: a chat without a workspace asks first (lib/agent-workspace-ask.ts).
  useAgentModeStore.getState().setWorkspace(convId, { kind: 'sandbox' })
  return convId
}

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
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

describe('a loop belongs to its own conversation, not to whichever Stop was last pressed', () => {
  it('Stop pressed while viewing B leaves a loop standing in A untouched', async () => {
    const convA = seed()
    const convB = seed()

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      return textZug()
    })

    const { result } = renderHook(() => useChat())

    // Pass 1 in A: ends in text, so the driver parks a loop for A and
    // schedules pass 2 on the interval timer.
    useChatStore.getState().setActiveConversation(convA)
    await act(async () => { await result.current.sendMessage('/loop 5s zaehle weiter') })
    expect(useAgentLoopStore.getState().loops[convA]?.conversationId).toBe(convA)

    // The user switches to a second, completely unrelated conversation and
    // presses Stop there, a conversation with nothing running at all.
    useChatStore.getState().setActiveConversation(convB)
    act(() => { result.current.stopGeneration() })
    await act(async () => { await warte(20) })

    // A's loop is still standing: a Stop for B must not reach it.
    expect(useAgentLoopStore.getState().loops[convA]?.conversationId).toBe(convA)
    expect(isRunStopped(convA)).toBe(false)
  })

  it('COUNTER-CHECK: Stop pressed while VIEWING A does end A\'s loop', async () => {
    const convA = seed()

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      return textZug()
    })

    const { result } = renderHook(() => useChat())

    useChatStore.getState().setActiveConversation(convA)
    await act(async () => { await result.current.sendMessage('/loop 5s zaehle weiter') })
    expect(useAgentLoopStore.getState().loops[convA]).toBeDefined()

    act(() => { result.current.stopGeneration() })
    await act(async () => { await warte(20) })

    expect(useAgentLoopStore.getState().loops[convA]).toBeUndefined()
    expect(isRunStopped(convA)).toBe(true)
  })
})
