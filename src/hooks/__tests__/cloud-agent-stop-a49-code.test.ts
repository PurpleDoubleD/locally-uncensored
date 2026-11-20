/**
 * @vitest-environment jsdom
 *
 * A49 in the Code tab (Coding Agent): LU Cloud ends the run itself with HTTP
 * 409 and `agent_loop_detected` or `agent_run_limit`. Until now that read
 * "Error: [agent_loop_detected] HTTP 409 agent stopped: ..." with an error
 * field. Now, as in the Agent tab (cloud-agent-stop-a49.test.ts): what was
 * written stays, a quiet app notice under it says why, no error field,
 * nothing is sent again, and a /loop does not start its next pass.
 *
 * Driven through the real `useCodex().sendInstruction` against a real HTTP
 * server on this machine standing in for the proxy, which counts requests.
 *
 * Run: npx vitest run src/hooks/__tests__/cloud-agent-stop-a49-code.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createServer, type Server } from 'node:http'

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
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'
import { truncationNotice } from '../../lib/answer-notes'

const MODEL = 'lu-cloud::direct/deepseek-v4.1-flash'
const STOPS = {
  agent_loop_detected: 'agent stopped: it repeated the same steps 3 times. Nothing more was charged. Send a new message to go on.',
  agent_run_limit: 'agent stopped: this run reached the limit of 200 steps. Send a new message to go on.',
} as const
type Code = keyof typeof STOPS

let server: Server
let base = ''
let requests = 0
let stopAt = 1
let stopCode: Code = 'agent_loop_detected'

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const toolStep = (i: number) => sse([
  { choices: [{ delta: { role: 'assistant', content: `Listing folder ${i}.`, tool_calls: [{ index: 0, id: `c${i}`, type: 'function', function: { name: 'file_list', arguments: JSON.stringify({ path: `src/part${i}` }) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } },
])
const realFetch = globalThis.fetch

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      if (requests >= stopAt) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: STOPS[stopCode], code: stopCode }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(toolStep(requests))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => { server.close() })

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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/chat/completions')) return realFetch(`${base}/v1/chat/completions`, init)
    return new Response('{}', { status: 200 })
  })
})
afterEach(() => vi.restoreAllMocks())

async function send(text: string) {
  const { result } = renderHook(() => useCodex())
  const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
  useChatStore.getState().setActiveConversation(convId)
  await act(async () => { await result.current.sendInstruction(text) })
  const messages = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages
  const visible = messages.filter((m) => !m.hidden)
  const answer = visible.filter((m) => m.role === 'assistant').at(-1)!
  const notices = visible.filter((m) => m.role === 'system' && m.notice).map((m) => m.content)
  return { convId, answer, notices, visible }
}

for (const code of Object.keys(STOPS) as Code[]) {
  describe(`Code tab, 409 ${code}`, () => {
    it('after two steps: one request for it, the work stays, a quiet notice under it, no error', { timeout: 60_000 }, async () => {
      stopCode = code
      stopAt = 3
      const { answer, notices } = await send('go through the source folders and list what each one holds')
      expect(requests).toBe(3)
      expect(answer.content).not.toMatch(/Error:|HTTP 409|\[agent_/)
      expect(answer.content).not.toContain(STOPS[code])
      expect(answer.error).toBeUndefined()
      expect(answer.finishReason).toBe(code)
      expect(notices).toContain(truncationNotice(code))
    })

    it('at the first request: a plain sentence in the answer, no error', { timeout: 60_000 }, async () => {
      stopCode = code
      stopAt = 1
      const { answer } = await send('list the source folders')
      expect(requests).toBe(1)
      expect(answer.content).toMatch(/^The agent stopped /)
      expect(answer.error).toBeUndefined()
    })
  })
}

it('Code tab: a /loop pass LU Cloud ended does not start the next pass', { timeout: 60_000 }, async () => {
  stopCode = 'agent_loop_detected'
  stopAt = 2
  const { convId, visible } = await send('/loop 1s go through the build logs and fix the nightly build')
  const before = requests
  expect(visible.some((m) => /The loop stopped because the run was ended by LU Cloud/.test(m.content))).toBe(true)
  expect(useAgentLoopStore.getState().loops[convId]).toBeUndefined()
  await new Promise((r) => setTimeout(r, 1_500))
  expect(requests).toBe(before)
})
