/**
 * @vitest-environment jsdom
 *
 * GH #264, the moment between Stop and the real end of the run, through the
 * real hooks. Stop clears the generating flag at once. The stream can take a
 * while to close, and the run still writes into the answer when it does, so
 * Edit has to stay shut until then and open for good afterwards, without
 * token numbers.
 *
 * Run: npx vitest run src/hooks/__tests__/edit-waits-for-the-end-of-a-stopped-run.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/rag', () => ({
  retrieveContext: async () => ({ context: { chunks: [], query: '', documentIds: [] }, scoredChunks: [] }),
  generateEmbeddings: async () => [[0.1, 0.2]],
}))
vi.mock('../../api/cloud/supabase', () => ({ getAccessToken: async () => 'session-token-abc' }))
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useChat } from '../useChat'
import { useAgentChat } from '../useAgentChat'
import { useChatStore } from '../../stores/chatStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { useReplyWriteStore } from '../../stores/replyWriteStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { __resetRunStopsForTests } from '../../lib/run-stop'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'
const encoder = new TextEncoder()
const piece = (text: string) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)

/** A stream that ignores the abort signal, as a slow connection does, and ends when told to. */
function slowStream() {
  let push!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) { push = c; c.enqueue(piece('A half written answer')) },
    cancel() { /* the test ends it */ },
  })
  const end = () => { try { push.enqueue(piece(' tail')); push.close() } catch { /* already cancelled */ } }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/chat/completions')) return new Response(body, { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return end
}

const reply = (convId: string) =>
  useChatStore.getState().conversations.find((c) => c.id === convId)!.messages.filter((m) => m.role === 'assistant').at(-1)!

beforeEach(() => {
  __resetRunStopsForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useReplyWriteStore.setState({ open: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' } })
  useProviderStore.setState((s) => ({ providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } } }))
  useModelStore.setState({ models: [{ name: MODEL } as never], activeModel: MODEL })
})
afterEach(() => { vi.restoreAllMocks() })

async function stopMidStream(start: () => Promise<unknown>, stop: (convId: string) => void, convId: string, end: () => void) {
  let running!: Promise<unknown>
  await act(async () => { running = start() })
  await vi.waitFor(() => expect(useGenerationStore.getState().generating[convId]).toBe(true), { timeout: 5_000 })
  const id = reply(convId).id
  expect(useReplyWriteStore.getState().open[id]).toBe(1)

  act(() => stop(convId))
  // The flag is gone, the writer is not.
  expect(useGenerationStore.getState().generating[convId]).toBeUndefined()
  expect(useReplyWriteStore.getState().open[id]).toBe(1)

  await act(async () => { end(); await running })
  expect(useReplyWriteStore.getState().open[id]).toBeUndefined()
}

describe('Stop, then the real end of the run', () => {
  it('plain chat', { timeout: 20_000 }, async () => {
    const convId = useChatStore.getState().createConversation(MODEL, '')
    useChatStore.getState().setActiveConversation(convId)
    const end = slowStream()
    const { result } = renderHook(() => useChat())
    await stopMidStream(() => result.current.sendMessage('Tell me a story.'), () => result.current.stopGeneration(), convId, end)
    // The case of the report: a stopped plain answer has no token numbers.
    expect(reply(convId).usage).toBeUndefined()
  })

  it('agent', { timeout: 20_000 }, async () => {
    const convId = useChatStore.getState().createConversation(MODEL, '')
    useChatStore.getState().setActiveConversation(convId)
    const end = slowStream()
    const { result } = renderHook(() => useAgentChat())
    await stopMidStream(
      () => result.current.sendAgentMessage('Tell me a story.', undefined, { curatedTools: ['web_fetch'], chatToolsMode: true }),
      (id) => { result.current.stopAgent(id); useGenerationStore.getState().abortConversation(id) },
      convId,
      end,
    )
  })
})
