/**
 * @vitest-environment jsdom
 *
 * The case of 15.11.2026 (LU-Admin Wecker, web-1 metadata only, no chat
 * content): a desktop agent on direct/deepseek-v4.1-flash ran 70 minutes,
 * 535 requests, 524 of them ending in tool calls, 8 finished answers, about
 * 125k input per request (peak 298k), ~729k credits. LU Cloud cut two steps
 * for repeating (chat.loop_stopped), and the work went on after both.
 *
 * Driven through the real `useAgentChat().sendAgentMessage`, only the network
 * replaced. Every call honestly differs (another page each time), so the
 * near-copy detector has nothing to catch: what has to hold is the send cap,
 * the cost brake, the server's loop stop and /loop.
 *
 * Run: npx vitest run src/hooks/__tests__/the-15-11-agent-run-stops.test.ts
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

/** A long page every time, different each time: ~40k characters. */
const page = (url: string) => `${url}\n` + Array.from({ length: 500 }, (_, i) => `Line ${i} of ${url}: build log entry with a path and a number ${i * 7}.`).join('\n')

vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return {
    ...actual,
    backendCall: vi.fn(async (cmd: string, args?: unknown) => {
      if (cmd === 'web_fetch') {
        const url = (args as { url: string }).url
        return { url, status: 200, title: 'Log', text: page(url) }
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
import { DEFAULT_SEND_WINDOW_TOKENS } from '../../lib/send-window'
import { __resetRunStopsForTests } from '../../lib/run-stop'
import { _resetCreditLedger, hourCredits } from '../../lib/agent-core/credit-ledger'
import { SERVER_LOOP_MESSAGE } from '../../lib/agent-core/server-loop-cut'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::direct/deepseek-v4.1-flash'
const RATES = { inputPerMillion: 20_000, outputPerMillion: 60_000 }

let requests = 0
/** Characters of `messages` in each request the app sent. */
let sentChars: number[] = []
/** Requests LU Cloud cuts for repeating, by number. */
let cutAt = new Set<number>()
/** Input the server reports for request i: ~125k, once 298k. */
const reported = (i: number) => (i === 6 ? 298_000 : 118_000 + ((i * 7919) % 14_000))
let reportedSum = 0

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })

// Honest work: another place each time, and a line of its own about it.
const HOSTS = ['ci.example.org', 'docs.example.net', 'status.example.com', 'git.example.io', 'artifacts.example.dev', 'wiki.example.org', 'tracker.example.net']
const PATHS = ['nightly/build', 'release/notes', 'runners/macos', 'pipelines/lint', 'packages/core', 'issues/open', 'changelog', 'deps/lockfile', 'env/vars', 'tests/flaky', 'cache/keys']
const STEPS = ['Reading the nightly log next.', 'Comparing with the release notes.', 'The runner image may be the cause.', 'Checking the lint stage.', 'Looking at the core package.', 'Open issues might mention it.', 'The changelog could explain the change.', 'Dependencies changed recently.', 'Maybe an environment variable.', 'Some tests are known to be flaky.', 'A stale cache key is possible.']
const urlOf = (i: number) => `https://${HOSTS[i % HOSTS.length]}/${PATHS[(i * 3) % PATHS.length]}/${(i * 7919) % 100_000}`

const toolCallSse = (i: number) => {
  const call = { index: 0, id: `call_${i}`, type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: urlOf(i) }) } }
  reportedSum += reported(i)
  return sse([
    { choices: [{ delta: { role: 'assistant', content: `${STEPS[i % STEPS.length]} (${i})`, tool_calls: [call] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: reported(i), completion_tokens: 140, total_tokens: reported(i) + 140 } },
  ])
}

// What the server sends when it cuts a step (server A41, lib/chat/loop-watch.ts).
const loopCutSse = () => sse([{ error: { message: 'The model started repeating the same text.', type: 'stalled', code: 'stalled_loop' } }])

beforeEach(() => {
  requests = 0
  sentChars = []
  cutAt = new Set()
  reportedSum = 0
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
  useModelStore.setState({ models: [{ name: MODEL, creditRates: RATES } as never], activeModel: MODEL })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/chat/completions')) {
      requests++
      if (requests > 80) throw new Error('the run did not stop')
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: unknown[] }
      sentChars.push(JSON.stringify(body.messages ?? []).length)
      return cutAt.has(requests) ? loopCutSse() : toolCallSse(requests)
    }
    return new Response('<html><body>log</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function run(loop?: { pass: number; intervalMs: number; task: string; startedAt: number }) {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  const { result } = renderHook(() => useAgentChat())
  const task = 'Go through the build logs and find why the nightly build fails.'
  await act(async () => {
    await result.current.sendAgentMessage(task, undefined, { curatedTools: ['web_fetch'], chatToolsMode: true, ...(loop ? { loop } : {}) })
  })
  const conv = useChatStore.getState().conversations.find((c) => c.id === convId)!
  const assistants = conv.messages.filter((m) => m.role === 'assistant')
  const answer = assistants.at(-1)!
  const runAnswer = assistants.find((m) => (m.agentBlocks ?? []).length > 0) ?? answer
  const notes = (runAnswer.agentBlocks ?? []).filter((b) => b.phase === 'reflection').map((b) => b.content)
  return { convId, answer, runAnswer, notes, assistants }
}

describe('15.11.2026: an agent run of that shape stops', () => {
  it('every step stays within the send cap while the pages pile up, and the cost brake ends the run', { timeout: 120_000 }, async () => {
    const { runAnswer, notes } = await run()
    // The 70 minutes had 535 requests. Here the run ends at 2M input.
    expect(requests).toBeLessThanOrEqual(17)
    expect(notes.some((n) => /^⛔ Stopped to protect your credits/.test(n))).toBe(true)
    expect(runAnswer.content).toMatch(/Stopped to protect your credits: this run has sent 2\.\dM tokens/)
    // The pages add up to far more than the cap; what goes out does not.
    expect(requests * 40_000).toBeGreaterThan(DEFAULT_SEND_WINDOW_TOKENS * 4 * 3)
    const capChars = DEFAULT_SEND_WINDOW_TOKENS * 4 * 1.15
    expect(Math.max(...sentChars)).toBeLessThan(capChars)
  })

  it('LU Cloud cuts a step for repeating: one more attempt, and the second cut ends the run with its sentence', { timeout: 60_000 }, async () => {
    cutAt = new Set([3, 6])
    const { runAnswer } = await run()
    // 1, 2, cut 3, retry 4, 5, cut 6: and nothing after.
    expect(requests).toBe(6)
    expect(runAnswer.content).toContain(SERVER_LOOP_MESSAGE)
    // The two cut steps were billed by the server without usage; the hour
    // counts them at the step's estimate, on top of what the others reported.
    const reportedCredits = (reportedSum * RATES.inputPerMillion + 4 * 140 * RATES.outputPerMillion) / 1_000_000
    expect(hourCredits()).toBeGreaterThan(reportedCredits)
  })

  it('a /loop pass the cost brake ended does not start the next pass', { timeout: 120_000 }, async () => {
    const { convId, assistants } = await run({ pass: 1, intervalMs: 1_000, task: 'check the build', startedAt: Date.now() })
    const before = requests
    expect(assistants.some((m) => m.content === 'The loop stopped because the run was paused to protect your credits. Start it again once that is sorted.')).toBe(true)
    expect(useAgentLoopStore.getState().loops[convId]).toBeUndefined()
    await new Promise((r) => setTimeout(r, 1_500))
    expect(requests).toBe(before)
  })

  it('with the loop guard switched off, the credit limit still pauses the task', { timeout: 120_000 }, async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, agentLoopGuard: false } }))
    const { runAnswer } = await run()
    // ~125k at 20,000 credits per million: 100,000 credits after about 40 steps.
    expect(requests).toBeLessThanOrEqual(45)
    expect(runAnswer.content).toMatch(/Paused to protect your credits: this task has used up to/)
  })
})
