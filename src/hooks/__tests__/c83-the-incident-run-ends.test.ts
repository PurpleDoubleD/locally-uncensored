/**
 * @vitest-environment jsdom
 *
 * C83 driven through the real `useAgentChat().sendAgentMessage`, only the
 * network replaced: the model of the support case's run (10.11.2026) answers every
 * round with one tool call, no text, arguments of ~490 characters that wobble
 * a little, and the server reports 420-447k tokens of input per request.
 * The run had 233 such rounds. Here it must end within eight.
 *
 * Run: npx vitest run src/hooks/__tests__/c83-the-incident-run-ends.test.ts
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

// The page read: the same small status answer every time, as in the run.
vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return {
    ...actual,
    backendCall: vi.fn(async (cmd: string, args?: unknown) => {
      if (cmd === 'web_fetch') return { url: (args as { url: string }).url, status: 200, title: 'Status', text: 'All systems operational. No open incidents.' }
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
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::direct/deepseek-v4.1-flash'

/** One call of the incident's shape: ~490 characters, a detail wobbling, and
 *  never twice the same (a poll that moves its time stamp on), so the exact
 *  repeat filter of the loop lets every one through, as in the run. */
function args(i: number): string {
  const q = ['open', 'pending', 'unresolved'][i % 3]
  const t = 4 * i
  const since = `2026-11-10T09:${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}Z`
  return JSON.stringify({
    url: `https://status.example.org/api/v2/incidents?state=${q}&page=${(i % 2) + 1}&per_page=50&include=components,updates,affected_regions&sort=-updated_at&fields=id,name,status,impact,created_at,updated_at,resolved_at,shortlink,components.name,components.status,updates.body,updates.status,updates.created_at,affected_regions.name&filter[impact]=major,critical&filter[component]=api-gateway,auth-service,billing-worker,storage-cluster,edge-cache&locale=en-US&tz=UTC&since=${since}`,
  })
}

let requests = 0
/** Input tokens the server reports per request; 0 = none reported. */
let reportedInput = 0

const toolCallSse = (i: number) => {
  const call = { index: 0, id: `call_${i}`, type: 'function', function: { name: 'web_fetch', arguments: args(i) } }
  const chunks = [
    { choices: [{ delta: { role: 'assistant', content: '', tool_calls: [call] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ...(reportedInput > 0 ? [{ choices: [], usage: { prompt_tokens: reportedInput + ((i * 7919) % 27_000), completion_tokens: 140, total_tokens: reportedInput + 140 } }] : []),
  ]
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

beforeEach(() => {
  requests = 0
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
  useModelStore.setState({ models: [], activeModel: MODEL })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/chat/completions')) {
      requests++
      if (requests > 40) throw new Error('the run did not stop')
      return toolCallSse(requests)
    }
    // The page itself: the same small status answer every time.
    return new Response('<html><body>All systems operational.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  })
})
afterEach(() => vi.restoreAllMocks())

async function run() {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  const { result } = renderHook(() => useAgentChat())
  await act(async () => {
    await result.current.sendAgentMessage('Watch the status page and tell me when the incident is resolved.', undefined, { curatedTools: ['web_fetch'], chatToolsMode: true })
  })
  const answer = useChatStore.getState().conversations.find((c) => c.id === convId)!.messages.filter((m) => m.role === 'assistant').at(-1)!
  const notes = (answer.agentBlocks ?? []).filter((b) => b.phase === 'reflection').map((b) => b.content)
  return { answer, notes }
}

describe('C83: the incident run, end to end', () => {
  it('the calls have the incident\'s length', () => {
    const lengths = Array.from({ length: 20 }, (_, i) => args(i).length)
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(480)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(500)
  })

  it('with 420-447k tokens per request: warned at once, stopped by the cost brake within 8 requests', { timeout: 60_000 }, async () => {
    reportedInput = 420_000
    const { answer, notes } = await run()
    expect(requests).toBeLessThanOrEqual(8)
    expect(notes.some((n) => /^⚠ Large request: this step sent 4\d\dk tokens/.test(n))).toBe(true)
    expect(notes.some((n) => /^⛔ Stopped to protect your credits/.test(n))).toBe(true)
    expect(answer.content).toMatch(/Stopped to protect your credits: this run has sent 2\.\dM tokens/)
  })

  it('without usage numbers: the near-copy detector ends it on the 8th', { timeout: 60_000 }, async () => {
    reportedInput = 0
    const { notes } = await run()
    expect(requests).toBe(8)
    expect(notes.some((n) => /Loop guard steered the model: You have now sent 5 nearly identical web_fetch calls/.test(n))).toBe(true)
    expect(notes.some((n) => /Loop guard halted the run: 8 nearly identical web_fetch calls in a row/.test(n))).toBe(true)
  })
})
