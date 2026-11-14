/**
 * @vitest-environment jsdom
 *
 * B1 Nachbesserung Runde 2, Punkt 5 des Auftrags (lanes.md): der B1-Fix
 * (`stopAllBackgroundWork()` ueber Abmelden, Fenster schliessen, App
 * beenden) muss den B2-Umbau (AgentRunState/activeAgentRuns statt Hook-Refs
 * in useAgentChat.ts) mit erfassen. `lib/background-shutdown.test.ts`
 * beweist die Vereinigungslogik bereits gegen SIMULIERTEN Store-Zustand
 * (`laufenderStrom()` etc.); dieser Test faehrt sie gegen ZWEI ECHTE,
 * gleichzeitig laufende useAgentChat()-Laeufe (Unterhaltung A und B), im
 * selben Aufbau wie useAgentChat-zwei-agentenlaeufe-vermischen-nicht.test.ts.
 *
 * Warum das nicht automatisch aus dem B2-Umbau folgt, obwohl kein Code hier
 * geaendert wurde: `stopAllBackgroundWork()` bricht ueber
 * `useGenerationStore.getState().abortConversation(convId)` ab, und
 * useAgentChat.ts registriert seinen AbortController weiterhin unter genau
 * diesem Mechanismus (`registerAborter(convId, () => { abort.abort(); ... })`,
 * unveraendert seit vor B2). Der Test misst das nach, statt es nur aus dem
 * Diff zu behaupten.
 *
 * Run: npx vitest run src/hooks/__tests__/stopAllBackgroundWork-trifft-zwei-agentenlaeufe.test.ts
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

import { useAgentChat } from '../useAgentChat'
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
import { stopAllBackgroundWork } from '../../lib/background-shutdown'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

function controllableSSE() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const enc = new TextEncoder()
  return {
    readable,
    pushContent(text: string) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`))
    },
    // 'in_progress', not 'completed': an open plan item makes the agent loop
    // steer for ANOTHER round (G16, lib/plan-reconcile.ts) instead of ending
    // after this one. That is the point here: it gives Stop something real
    // to prevent, a genuine next request that would otherwise follow.
    pushTool(id: string) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0, id, type: 'function',
              function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'x', status: 'in_progress' }] }) },
            }],
          },
        }],
      })}\n\n`))
    },
    done() {
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  return convId
}

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

describe('stopAllBackgroundWork() beendet zwei gleichzeitig laufende Agentenlaeufe', () => {
  it('nach stopAllBackgroundWork() verlaesst fuer KEINE der beiden Unterhaltungen eine weitere Anfrage den Prozess', async () => {
    const convA = seed()
    const convB = seed()

    // Round 1 (tool call, plan item left 'in_progress' so G16 plan-reconcile
    // drives a real round 2) and round 2 are BOTH hand-driven, per
    // conversation, so the test can stop each run exactly between the two
    // requests: mid-loop, not mid-connect or after the run already ended on
    // its own, which would make "no further request" true for free.
    const streamA1 = controllableSSE()
    const streamB1 = controllableSSE()
    const streamA2 = controllableSSE()
    const streamB2 = controllableSSE()
    let callsA = 0
    let callsB = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      const body = String(init?.body ?? '')
      const asStream = (s: ReturnType<typeof controllableSSE>) =>
        new Response(s.readable, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (body.includes('task-A')) {
        callsA++
        if (callsA === 1) return asStream(streamA1)
        if (callsA === 2) return asStream(streamA2)
        throw new Error('a third request for conversation A left the process after stopAllBackgroundWork()')
      }
      if (body.includes('task-B')) {
        callsB++
        if (callsB === 1) return asStream(streamB1)
        if (callsB === 2) return asStream(streamB2)
        throw new Error('a third request for conversation B left the process after stopAllBackgroundWork()')
      }
      throw new Error('unexpected request body: ' + body.slice(0, 200))
    })

    const { result } = renderHook(() => useAgentChat())

    let runA!: Promise<void>
    let runB!: Promise<void>
    await act(async () => {
      useChatStore.getState().setActiveConversation(convA)
      runA = result.current.sendAgentMessage('task-A')
      useChatStore.getState().setActiveConversation(convB)
      runB = result.current.sendAgentMessage('task-B')
      await tick()

      // Round 1 for both, ending in a tool call: the loop moves on to
      // dispatch round 2 for each.
      streamA1.pushTool('call-A')
      streamA1.done()
      streamB1.pushTool('call-B')
      streamB1.done()
      for (let i = 0; i < 50 && (callsA < 2 || callsB < 2); i++) await tick()
    })

    // Round 2 has genuinely been requested for both; the loop is mid-run,
    // not idle and not between messages.
    expect(callsA).toBe(2)
    expect(callsB).toBe(2)

    // The trigger this test stands in for: sign-out, window close, app quit.
    // Fired while round 2's response has not even started arriving yet.
    act(() => { stopAllBackgroundWork() })

    // Both conversations carry the sticky stop marker, same as pressing Stop
    // in each of them individually.
    expect(isRunStopped(convA)).toBe(true)
    expect(isRunStopped(convB)).toBe(true)

    // Round 2 itself is let through to completion (a real connection
    // in flight when Stop is pressed is not retroactively unsent); the
    // question this test answers is whether the loop reaches for a THIRD
    // round afterwards. It must not: the third call throws in the mock
    // above, so a regression fails loudly here instead of just miscounting.
    await act(async () => {
      streamA2.pushContent('final-answer-A')
      streamA2.done()
      streamB2.pushContent('final-answer-B')
      streamB2.done()
      await Promise.allSettled([runA, runB])
      await tick()
      await tick()
    })

    expect(callsA).toBe(2)
    expect(callsB).toBe(2)
  })
})
