/**
 * @vitest-environment jsdom
 *
 * T1 2026-10-29 (GH #201 follow-up): three local members on a 16K window. The
 * first speaker wrote 82 500 characters, and both later speakers of the round
 * ended on "This message is longer than the model can read at once": the
 * trim drops only older turns and always keeps the newest, and the newest was
 * that one answer. The refusal sentence then went to the next speaker as the
 * failed speaker's answer, since it carried no error field.
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
vi.mock('../../lib/lan-openai-slot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lan-openai-slot')>()),
  sendsToALanBackend: () => true,
}))
vi.mock('../../lib/context-compaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/context-compaction')>()),
  getChatWindowTokens: async () => 16384,
}))

import { useChat } from '../useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useGenerationStore } from '../../stores/generationStore'
import { __resetRunLanesForTests } from '../../lib/run-lanes'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../../lib/constants'
import { estimateMessageTokens, shortenLongTurns } from '../../lib/context-compaction'
import { chatSendBudget } from '../../lib/chat-send-budget'
import { historyTrimNote } from '../../lib/history-trim-note'

const A = 'openai::qwen05'
const B = 'openai::qwen05-zwei'
const C = 'openai::coder15'

interface WireMessage { role: string; content: string }
interface Request { model: string; messages: WireMessage[] }
let requests: Request[] = []
let reply: (model: string) => Response

const LONG = 'The robot walked on. '.repeat(3929).slice(0, 82_500)
const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
const refused = () =>
  new Response(JSON.stringify({ error: { code: 400, message: 'request (16866 tokens) exceeds the available context size (16384 tokens), try increasing it', type: 'exceed_context_size_error' } }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })

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
    return reply(body.model)
  })
})
afterEach(() => vi.restoreAllMocks())

function openGroup(): string {
  const convId = useChatStore.getState().createConversation(A, '')
  useChatStore.getState().setActiveConversation(convId)
  useChatStore.getState().setGroupModels(convId, [A, B, C])
  return convId
}

const wireSize = (r: Request) => estimateMessageTokens(r.messages as never)
const allText = (r: Request) => r.messages.map((m) => m.content).join('\n')
const turns = (id: string) =>
  useChatStore.getState().conversations.find((c) => c.id === id)!.messages.filter((m) => m.role === 'assistant')

async function round(text: string) {
  const { result } = renderHook(() => useChat())
  await act(async () => { await result.current.sendMessage(text) })
}

describe('a long answer earlier in the same round', () => {
  it('goes to the later speakers shortened to their window, and the chat keeps it whole', async () => {
    reply = (model) => sse(model === 'qwen05' ? LONG : `${model} answer.`)
    const convId = openGroup()
    await round('Write a long story of 600 words about a robot.')

    expect(requests.map((r) => r.model)).toEqual(['qwen05', 'qwen05-zwei', 'coder15'])
    const budget = chatSendBudget({ providerId: 'openai', modelWindow: 16384, contextDecay: true, localBackend: true })!
    for (const r of requests.slice(1)) {
      expect(wireSize(r)).toBeLessThanOrEqual(budget)
      // Head and tail of the long answer are still there, the middle is cut.
      const text = allText(r)
      expect(text).toContain('[openai::qwen05] The robot walked on.') // tagged as the other speaker
      expect(text).toContain('The robot walked on.')
      expect(text).toMatch(/…\[truncated \d+ chars\]…/)
      // And the person's own line, the one being answered, went out whole.
      expect(text).toContain('Write a long story of 600 words about a robot.')
    }
    const said = turns(convId)
    expect(said[0].content).toBe(LONG)
    expect(said.slice(1).map((m) => m.content)).toEqual(['qwen05-zwei answer.', 'coder15 answer.'])
    expect(said.slice(1).map((m) => m.historyTrim)).toEqual([{ dropped: 0, window: 16384, shortened: 1 }, { dropped: 0, window: 16384, shortened: 1 }])
    expect(historyTrimNote(said[1].historyTrim!, 'qwen05-zwei')).toBe(
      '1 long message was sent shortened to qwen05-zwei to fit its 16K context. The chat itself keeps it whole.',
    )
  })

  it('a refused speaker\'s sentence is not sent to the next speaker as its answer', async () => {
    reply = (model) => (model === 'qwen05' ? refused() : sse(`${model} answer.`))
    const convId = openGroup()
    await round('hallo')

    const said = turns(convId)
    expect(said[0].content).not.toBe('')
    expect(said[0].error).toBeTruthy()
    expect(said[0].error!.at).toBe(0)
    const later = requests.filter((r) => r.model !== 'qwen05')
    expect(later.map((r) => r.model)).toEqual(['qwen05-zwei', 'coder15'])
    for (const r of later) {
      expect(allText(r)).not.toContain(said[0].content)
      expect(allText(r)).not.toContain('[openai::qwen05]')
    }
  })
})

describe('shortenLongTurns', () => {
  const m = (role: string, content: string) => ({ role, content })

  it('leaves a payload that fits as it is', () => {
    const msgs = [m('system', 's'), m('user', 'a'), m('assistant', 'b')]
    expect(shortenLongTurns(msgs, 1000)).toEqual({ messages: msgs, shortened: 0 })
  })

  it('a group keeps the person\'s line and cuts the speaker before, even when that one is last', () => {
    const msgs = [m('system', 's'), m('user', 'go on'), m('user', '[a] ' + 'x'.repeat(80_000))]
    const out = shortenLongTurns(msgs, 4000, (x) => x.content.includes('go on'))
    expect(out.shortened).toBe(1)
    expect(out.messages[1].content).toBe('go on')
    expect(out.messages[2].content.startsWith('[a] xxx')).toBe(true)
    expect(estimateMessageTokens(out.messages as never)).toBeLessThanOrEqual(4000)
  })

  it('never cuts the system prompt or the message being answered', () => {
    const big = 'x'.repeat(40_000)
    const msgs = [m('system', big), m('user', big), m('user', big)]
    const out = shortenLongTurns(msgs, 12_000)
    expect(out.shortened).toBe(1)
    expect(out.messages[0].content).toBe(big)
    expect(out.messages[2].content).toBe(big)
    expect(out.messages[1].content.length).toBeLessThan(big.length)
  })

  it('cuts the longest turn first and only as far as needed', () => {
    const msgs = [m('system', 's'), m('user', 'y'.repeat(4000)), m('user', 'x'.repeat(80_000)), m('user', 'go')]
    const out = shortenLongTurns(msgs, 6000)
    expect(out.shortened).toBe(1)
    expect(out.messages[1].content).toBe('y'.repeat(4000))
    expect(estimateMessageTokens(out.messages as never)).toBeLessThanOrEqual(6000)
    expect(estimateMessageTokens(out.messages as never)).toBeGreaterThan(5000)
  })
})
