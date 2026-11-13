/**
 * @vitest-environment jsdom
 *
 * GH #201: a group chat on two local 256K models ("256K · max" picked for
 * both) sent only about 128K-131K tokens of a 215K story, round after round,
 * and the request carried an agent's note ("The original task still stands
 * ... re-read that specific file"). Plain chat on the same model was not cut.
 *
 * The cause was the send budget of a conversation: 0.8 of the window with the
 * A3 hysteresis on top, so the trim engaged at 0.92 of the window and then
 * dropped to 0.7 x 0.8 = 0.56 of it. The stored chat is always the full one,
 * so every later round was over the trigger again and dropped to 0.56 again.
 *
 * Driven through the real `useChat().sendMessage`, only the network and the
 * window lookup replaced: what is asserted is the request each model receives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/cloud/supabase', () => ({ getAccessToken: async () => 'session-token-abc' }))
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))
vi.mock('../../lib/run-lane-of-model', () => ({
  laneOf: () => 'cloud',
  currentLaneFacts: () => ({ openaiSlotIsLocal: true, ollamaBaseIsLocal: true }),
}))
// Both members run on a server on this machine, as in the report.
vi.mock('../../lib/lan-openai-slot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lan-openai-slot')>()),
  sendsToALanBackend: () => true,
}))
// "256K · max" picked and loaded, as the server reported it.
vi.mock('../../lib/context-compaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/context-compaction')>()),
  getChatWindowTokens: async () => 262144,
}))

import { useChat } from '../useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useGenerationStore } from '../../stores/generationStore'
import { __resetRunLanesForTests } from '../../lib/run-lanes'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../../lib/constants'
import { estimateMessageTokens } from '../../lib/context-compaction'
import { chatSendBudget } from '../../lib/chat-send-budget'
import type { Message } from '../../types/chat'

const A = 'openai::walt'
const B = 'openai::baron'

interface WireMessage { role: string; content: string }
interface Request { model: string; messages: WireMessage[] }
let requests: Request[] = []

beforeEach(() => {
  requests = []
  __resetRunLanesForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useModelStore.setState({ models: [], activeModel: A })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: 'local', cavemanMode: 'off' },
    personas: [...BUILT_IN_PERSONAS],
  })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, openai: { ...s.providers.openai, enabled: true } },
  }))
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).includes('/chat/completions')) return new Response('{}', { status: 200 })
    const body = JSON.parse(String((init as RequestInit).body)) as Request
    requests.push(body)
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'つづき。' } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  })
})
afterEach(() => vi.restoreAllMocks())

/** A Japanese story of about `tokens` tokens by the app's own estimate, told
 *  by the user and the two members in turn. */
function story(tokens: number): Message[] {
  const line = '物語はまだ続いている。'.repeat(180)
  const out: Message[] = []
  let i = 0
  while (estimateMessageTokens(out.map((m) => ({ role: m.role, content: m.content })) as never) < tokens) {
    const who = i % 3
    out.push(who === 0
      ? { id: `m${i}`, role: 'user', content: `第${i}話 ${line}`, timestamp: i }
      : { id: `m${i}`, role: 'assistant', content: `第${i}話 ${line}`, modelId: who === 1 ? A : B, timestamp: i })
    i++
  }
  return out
}

function openGroupWith(messages: Message[]): string {
  const convId = useChatStore.getState().createConversation(A, '')
  useChatStore.getState().setActiveConversation(convId)
  useChatStore.getState().setGroupModels(convId, [A, B])
  useChatStore.setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === convId ? { ...c, messages } : c)),
  }))
  return convId
}

const wireSize = (r: Request) => estimateMessageTokens(r.messages as never)
const allText = (r: Request) => r.messages.map((m) => m.content).join('\n')
const answers = (id: string) =>
  useChatStore.getState().conversations.find((c) => c.id === id)!.messages.filter((m) => m.role === 'assistant').slice(-2)

async function round(text: string) {
  const { result } = renderHook(() => useChat())
  await act(async () => { await result.current.sendMessage(text) })
}

describe('GH #201: a group member is budgeted by the context picked for it', () => {
  // The report's 215K tokens by the server's count are about 245K by the
  // app's estimate, which runs ahead on Japanese: the stored usage of a
  // request the app estimated at 146.8K said 129.5K. 245K is past the old
  // trigger (0.92 x 262144 = 241172) and inside the window.
  it('a 215K story goes out whole to a 256K member, as in plain chat', async () => {
    const history = story(245_000)
    const convId = openGroupWith(history)
    await round('続けて')

    expect(requests.map((r) => r.model)).toEqual(['walt', 'baron'])
    // Every turn of the story reached the first speaker; before the fix the
    // request held about 0.56 x 262144 = 146800 estimated tokens.
    expect(wireSize(requests[0])).toBeGreaterThan(245_000)
    expect(allText(requests[0])).toContain('第0話')
    expect(allText(requests[0])).not.toMatch(/trimmed|not included/)
    expect(answers(convId).every((m) => m.historyTrim === undefined)).toBe(true)
  })

  it('a story larger than the window is trimmed to the window, not to half of it', async () => {
    const history = story(300_000)
    const convId = openGroupWith(history)
    await round('続けて')

    const budget = chatSendBudget({ providerId: 'openai', modelWindow: 262144, contextDecay: true, localBackend: true })!
    expect(budget).toBe(262144 - 8192)
    for (const r of requests) {
      expect(wireSize(r)).toBeLessThanOrEqual(budget)
      // Not the old 0.56 of the window: the trim keeps what fits.
      expect(wireSize(r)).toBeGreaterThan(budget * 0.9)
    }
    // The note the model reads is a conversation's, not an agent's.
    const text = allText(requests[0])
    expect(text).toMatch(/\[Note: \d+ earlier messages of this conversation are not included here/)
    expect(text).not.toContain('re-read')
    expect(text).not.toContain('original task')
    // And the chat says so next to each answer.
    const said = answers(convId)
    expect(said.map((m) => m.historyTrim?.window)).toEqual([262144, 262144])
    expect(said.every((m) => (m.historyTrim?.dropped ?? 0) > 0)).toBe(true)
  })
})
