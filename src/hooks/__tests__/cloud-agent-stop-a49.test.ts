/**
 * @vitest-environment jsdom
 *
 * A49 (lu-labs.ai, 3.1.3): LU Cloud ends an agent run itself with HTTP 409
 * and `agent_loop_detected` or `agent_run_limit`. The desktop showed it as
 * "Agent error: agent stopped: ...". Now the run ends calmly: what was
 * written stays, a quiet line under it says why (finishReason), there is no
 * error field, nothing is sent again, and a /loop does not start its next
 * pass.
 *
 * Driven through the real `useAgentChat().sendAgentMessage` against a real
 * HTTP server on this machine standing in for the proxy: every chat
 * completions request of the app goes there, and the server counts them.
 *
 * Run: npx vitest run src/hooks/__tests__/cloud-agent-stop-a49.test.ts
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
vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return {
    ...actual,
    backendCall: vi.fn(async (cmd: string, args?: unknown) => {
      if (cmd === 'web_fetch') {
        const url = (args as { url: string }).url
        return { url, status: 200, title: 'Page', text: `Contents of ${url}` }
      }
      return actual.backendCall(cmd as never, args as never)
    }),
  }
})

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
import { __resetRunStopsForTests } from '../../lib/run-stop'
import { _resetCreditLedger } from '../../lib/agent-core/credit-ledger'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'
import { truncationNotice } from '../../lib/answer-notes'

const MODEL = 'lu-cloud::direct/deepseek-v4.1-flash'

/** The proxy's sentences as A49 sends them (fix/w4-a49-agent-loop). */
const STOPS = {
  agent_loop_detected: 'agent stopped: it repeated the same steps 3 times. Nothing more was charged. Send a new message to go on.',
  agent_run_limit: 'agent stopped: this run reached the limit of 200 steps. Send a new message to go on.',
} as const
type Code = keyof typeof STOPS

let server: Server
let base = ''
let requests = 0
/** From which request on the server answers 409, and with which code. */
let stopAt = 1
let stopCode: Code = 'agent_loop_detected'

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const toolStep = (i: number) => sse([
  { choices: [{ delta: { role: 'assistant', content: `Looking at page ${i}.`, tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: `https://docs.example.org/page/${i}` }) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } },
])

const realFetch = globalThis.fetch

beforeAll(async () => {
  server = createServer((req, res) => {
    // The body is not needed: every call counts, the reply depends on the count.
    req.on('data', () => {})
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
  useAgentModeStore.setState({ agentModeActive: {}, workspaces: {}, workspaceSlugs: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useToolAuditStore.setState({ entries: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off', webStrictUrls: false } })
  useProviderStore.setState((s) => ({ providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } } }))
  useModelStore.setState({ models: [{ name: MODEL } as never], activeModel: MODEL })
  // Every chat completions request goes to the stand-in proxy, as it was sent.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/chat/completions')) return realFetch(`${base}/v1/chat/completions`, init)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => { vi.restoreAllMocks() })

async function run(loop?: { pass: number; intervalMs: number; task: string; startedAt: number }) {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  const { result } = renderHook(() => useAgentChat())
  await act(async () => {
    await result.current.sendAgentMessage('Read the docs pages and sum up the setup steps.', undefined, { curatedTools: ['web_fetch'], chatToolsMode: true, ...(loop ? { loop } : {}) })
  })
  const conv = useChatStore.getState().conversations.find((c) => c.id === convId)!
  const assistants = conv.messages.filter((m) => m.role === 'assistant')
  const answer = assistants.find((m) => (m.agentBlocks ?? []).length > 0) ?? assistants.at(-1)!
  return { convId, answer, assistants }
}

for (const code of Object.keys(STOPS) as Code[]) {
  describe(`409 ${code}`, () => {
    it('after two steps: one request to the proxy for it, a quiet stop under the work, no "Agent error"', { timeout: 60_000 }, async () => {
      stopCode = code
      stopAt = 3
      const { answer } = await run()
      // 1, 2, the stop, and nothing after: no retry of any layer.
      expect(requests).toBe(3)
      expect(answer.content).not.toMatch(/Agent error/)
      expect(answer.content).not.toContain(STOPS[code])
      expect(answer.error).toBeUndefined()
      expect(answer.finishReason).toBe(code)
      expect(truncationNotice(answer.finishReason)).toMatch(/^Agent stopped /)
    })

    it('at the first request: the bubble says why in a plain sentence, still no error', { timeout: 60_000 }, async () => {
      stopCode = code
      stopAt = 1
      const { answer } = await run()
      expect(requests).toBe(1)
      expect(answer.content).toMatch(/^The agent stopped /)
      expect(answer.content).not.toMatch(/Agent error|error/i)
      expect(answer.error).toBeUndefined()
      expect(answer.finishReason).toBe(code)
    })
  })
}

it('a /loop pass LU Cloud ended does not start the next pass', { timeout: 60_000 }, async () => {
  stopCode = 'agent_loop_detected'
  stopAt = 2
  const { convId, assistants } = await run({ pass: 1, intervalMs: 1_000, task: 'check the docs', startedAt: Date.now() })
  const before = requests
  expect(before).toBe(2)
  expect(assistants.some((m) => /The loop stopped because the run was ended by LU Cloud/.test(m.content))).toBe(true)
  expect(useAgentLoopStore.getState().loops[convId]).toBeUndefined()
  await new Promise((r) => setTimeout(r, 1_500))
  expect(requests).toBe(before)
})
