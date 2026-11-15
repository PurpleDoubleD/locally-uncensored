/**
 * @vitest-environment jsdom
 *
 * The case of 15.11.2026 in the Code tab (see the-15-11-agent-run-stops.test.ts
 * for the case itself): a `/loop` pass that ended on the cost brake or on
 * LU Cloud's loop stop must not start the next pass, which would begin with a
 * fresh brake and the same wall in front of it.
 *
 * Run: npx vitest run src/hooks/__tests__/the-15-11-code-loop-stops.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/cloud/supabase', () => ({ getAccessToken: async () => 'session-token-abc' }))
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

import { useCodex } from '../useCodex'
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
import { _resetCreditLedger } from '../../lib/agent-core/credit-ledger'
import { SERVER_LOOP_MESSAGE } from '../../lib/agent-core/server-loop-cut'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::direct/deepseek-v4.1-flash'
let requests = 0
let answerWith: (i: number) => Response

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })

beforeEach(() => {
  requests = 0
  _resetCreditLedger()
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentModeStore.setState({ agentModeActive: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useToolAuditStore.setState({ entries: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' } })
  useProviderStore.setState((s) => ({ providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } } }))
  useModelStore.setState({ models: [], activeModel: MODEL })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    if (!String(input).includes('/chat/completions')) return new Response('{}', { status: 200 })
    requests++
    if (requests > 20) throw new Error('the loop did not stop')
    return answerWith(requests)
  })
})
afterEach(() => vi.restoreAllMocks())

async function loopPass() {
  const { result } = renderHook(() => useCodex())
  const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
  useChatStore.getState().setActiveConversation(convId)
  await act(async () => { await result.current.sendInstruction('/loop 1s go through the build logs and fix the nightly build') })
  const assistants = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages.filter((m) => m.role === 'assistant')
  return { convId, assistants }
}

async function noFurtherPass(convId: string) {
  const before = requests
  expect(useAgentLoopStore.getState().loops[convId]).toBeUndefined()
  await new Promise((r) => setTimeout(r, 1_500))
  expect(requests).toBe(before)
}

describe('15.11.2026, Code tab: /loop ends where the pass hit a wall', () => {
  it('LU Cloud cut the step for repeating: its sentence, and no next pass', { timeout: 30_000 }, async () => {
    answerWith = () => sse([{ error: { message: 'The model started repeating the same text.', type: 'stalled', code: 'stalled_loop' } }])
    const { convId, assistants } = await loopPass()
    expect(assistants.some((m) => m.content.includes(SERVER_LOOP_MESSAGE))).toBe(true)
    expect(assistants.some((m) => m.content === 'The loop stopped because the run was cut off by LU Cloud because the model kept repeating itself. Start it again once that is sorted.')).toBe(true)
    await noFurtherPass(convId)
  })

  it('the cost brake ended the pass: no next pass with a fresh brake', { timeout: 30_000 }, async () => {
    answerWith = (i) => sse([
      { choices: [{ delta: { role: 'assistant', content: 'Listing the logs.', tool_calls: [{ index: 0, id: `c${i}`, type: 'function', function: { name: 'file_list', arguments: JSON.stringify({ path: `logs/${i}` }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 2_100_000, completion_tokens: 50, total_tokens: 2_100_050 } },
    ])
    const { convId, assistants } = await loopPass()
    expect(assistants.some((m) => /Stopped to protect your credits/.test(m.content))).toBe(true)
    expect(assistants.some((m) => m.content === 'The loop stopped because the run was paused to protect your credits. Start it again once that is sorted.')).toBe(true)
    await noFurtherPass(convId)
  })
})
