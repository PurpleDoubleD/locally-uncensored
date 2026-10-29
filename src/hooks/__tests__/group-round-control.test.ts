/**
 * @vitest-environment jsdom
 *
 * 3.0.9, GH #199 and GH #200: a person decides more about a group round.
 *
 *  - #199: "Regenerate" on one speaker's answer asks that speaker again and
 *    keeps the answers before it. With later speakers already answered, the
 *    person picks: keep them, or ask them again from here. The old answer
 *    stays as a version ("< 1/2 >").
 *  - #200: the round follows the order of the group list, a member can sit
 *    out the next round, and "Skip speaker" ends one turn while the round
 *    goes on ("Stop round" still ends all of it).
 *
 * Driven through the real `useChat()` with only the network replaced: what
 * is asserted is who was asked, and what the chat holds afterwards.
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

import { useChat } from '../useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useGroupRoundStore, skipGroupSpeaker } from '../../stores/groupRoundStore'
import { __resetRunLanesForTests } from '../../lib/run-lanes'
import { forkMarks } from '../../lib/chat-forks'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../../lib/constants'

const A = 'openai::walt'
const B = 'openai::baron'
const C = 'openai::clara'

interface Request { model: string }
let requests: Request[] = []
let calls: Record<string, number> = {}
/** Models whose answer waits until the request is aborted. */
let hang = new Set<string>()
/** Models that write a few words and then wait until the request is aborted. */
let partial = new Set<string>()

beforeEach(() => {
  requests = []
  calls = {}
  hang = new Set()
  partial = new Set()
  __resetRunLanesForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useGroupRoundStore.setState({ live: {} })
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
    calls[body.model] = (calls[body.model] ?? 0) + 1
    if (partial.has(body.model)) {
      const signal = (init as RequestInit).signal
      const enc = new TextEncoder()
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half an answer' } }] })}\n\n`))
          signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (hang.has(body.model)) {
      const signal = (init as RequestInit).signal
      await new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) fail()
        signal?.addEventListener('abort', fail)
      })
    }
    const text = `${body.model} ${calls[body.model]}`
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  })
})
afterEach(() => vi.restoreAllMocks())

function openGroup(members = [A, B, C]): string {
  const convId = useChatStore.getState().createConversation(A, '')
  useChatStore.getState().setActiveConversation(convId)
  useChatStore.getState().setGroupModels(convId, members)
  return convId
}

const conv = (id: string) => useChatStore.getState().conversations.find((c) => c.id === id)!
const said = (id: string) => conv(id).messages.filter((m) => m.role === 'assistant').map((m) => m.content)
const asked = () => requests.map((r) => r.model)

async function withChat<T>(fn: (chat: ReturnType<typeof useChat>) => Promise<T>): Promise<T> {
  const { result } = renderHook(() => useChat())
  let out!: T
  await act(async () => { out = await fn(result.current) })
  return out
}

describe('GH #199: regenerate one speaker', () => {
  it('only the second speaker answers again; the first and the third are kept', async () => {
    const id = openGroup()
    await withChat((c) => c.sendMessage('go'))
    expect(said(id)).toEqual(['walt 1', 'baron 1', 'clara 1'])
    const second = conv(id).messages.find((m) => m.content === 'baron 1')!

    requests = []
    expect(await withChat((c) => c.regenerateSpeaker(id, second.id, 'only'))).toBe(true)
    expect(asked()).toEqual(['baron'])
    expect(said(id)).toEqual(['walt 1', 'baron 2', 'clara 1'])
    // One user line, never a second copy of it.
    expect(conv(id).messages.filter((m) => m.role === 'user').length).toBe(1)

    // The old answer is a version, and "< 2/2 >" sits on the new one.
    const fresh = conv(id).messages.find((m) => m.content === 'baron 2')!
    const mark = forkMarks(conv(id)).get(fresh.id)!
    expect(mark).toMatchObject({ index: 1, total: 2 })
    useChatStore.getState().switchFork(id, mark.key, 0)
    expect(said(id)).toEqual(['walt 1', 'baron 1', 'clara 1'])
    // Every message lives in one place: the kept third answer is a copy.
    useChatStore.getState().switchFork(id, mark.key, 1)
    const ids = conv(id).messages.map((m) => m.id)
    const oldVersion = conv(id).forks![mark.key].versions[0]!.map((m) => m.id)
    expect(ids.filter((x) => oldVersion.includes(x))).toEqual([])
  })

  it('"from here" asks the speaker and everyone after it, in the round order', async () => {
    const id = openGroup()
    await withChat((c) => c.sendMessage('go'))
    const second = conv(id).messages.find((m) => m.content === 'baron 1')!
    requests = []
    await withChat((c) => c.regenerateSpeaker(id, second.id, 'from-here'))
    expect(asked()).toEqual(['baron', 'clara'])
    expect(said(id)).toEqual(['walt 1', 'baron 2', 'clara 2'])
  })

  it('the last speaker regenerates alone, nothing later to ask about', async () => {
    const id = openGroup()
    await withChat((c) => c.sendMessage('go'))
    const third = conv(id).messages.find((m) => m.content === 'clara 1')!
    requests = []
    await withChat((c) => c.regenerateSpeaker(id, third.id, 'only'))
    expect(asked()).toEqual(['clara'])
    expect(said(id)).toEqual(['walt 1', 'baron 1', 'clara 2'])
  })

  it('negative control: "Regenerate whole round" still asks everyone again', async () => {
    const id = openGroup()
    await withChat((c) => c.sendMessage('go'))
    const second = conv(id).messages.find((m) => m.content === 'baron 1')!
    requests = []
    await withChat(async (c) => { c.regenerateMessage(id, second.id) })
    await vi.waitFor(() => expect(said(id)).toEqual(['walt 2', 'baron 2', 'clara 2']))
    expect(asked()).toEqual(['walt', 'baron', 'clara'])
  })
})

describe('GH #200: order, who answers, skip', () => {
  it('the round follows the order of the list', async () => {
    const id = openGroup([C, A, B])
    await withChat((c) => c.sendMessage('go'))
    expect(asked()).toEqual(['clara', 'walt', 'baron'])
    expect(said(id)).toEqual(['clara 1', 'walt 1', 'baron 1'])
  })

  it('a member set to sit out misses the next round only', async () => {
    const id = openGroup()
    useChatStore.getState().setGroupSitOut(id, [A, C])
    await withChat((c) => c.sendMessage('only baron'))
    expect(asked()).toEqual(['baron'])
    expect(conv(id).groupSitOut).toBeUndefined()
    await withChat((c) => c.sendMessage('everyone'))
    expect(asked()).toEqual(['baron', 'walt', 'baron', 'clara'])
  })

  it('sitting everyone out is no pick: everyone answers', async () => {
    const id = openGroup([A, B])
    useChatStore.getState().setGroupSitOut(id, [A, B])
    await withChat((c) => c.sendMessage('go'))
    expect(asked()).toEqual(['walt', 'baron'])
  })

  it('"Skip speaker" ends the turn that runs and the next speaker answers', async () => {
    const id = openGroup()
    hang.add('walt')
    const { result } = renderHook(() => useChat())
    let round!: Promise<void>
    act(() => { round = result.current.sendMessage('go') })
    await vi.waitFor(() => expect(useGroupRoundStore.getState().live[id]).toMatchObject({ speaker: A, index: 0, total: 3 }))
    await vi.waitFor(() => expect(asked()).toEqual(['walt']))
    expect(skipGroupSpeaker(id)).toBe(true)
    await act(async () => { await round })
    expect(asked()).toEqual(['walt', 'baron', 'clara'])
    // Skipped before a word: no empty bubble stands for it.
    expect(said(id)).toEqual(['baron 1', 'clara 1'])
    expect(useGroupRoundStore.getState().live[id]).toBeUndefined()
    expect(skipGroupSpeaker(id)).toBe(false)
  })

  it('a double click on "Skip speaker" skips one speaker, not two (T1 A8)', async () => {
    const id = openGroup()
    hang.add('walt')
    hang.add('baron')
    const { result } = renderHook(() => useChat())
    let round!: Promise<void>
    act(() => { round = result.current.sendMessage('go') })
    await vi.waitFor(() => expect(asked()).toEqual(['walt']))
    const t = Date.now()
    expect(skipGroupSpeaker(id, 0, t)).toBe(true)
    await vi.waitFor(() => expect(useGroupRoundStore.getState().live[id]?.index).toBe(1))
    // The second click of the pair: once as the button showed it (walt's
    // place), once after the bar had already moved on to baron.
    expect(skipGroupSpeaker(id, 0, t + 60)).toBe(false)
    expect(skipGroupSpeaker(id, 1, t + 60)).toBe(false)
    await vi.waitFor(() => expect(asked()).toEqual(['walt', 'baron']))
    // baron is still speaking; a later, separate click skips him.
    expect(useGroupRoundStore.getState().live[id]).toMatchObject({ speaker: B, index: 1 })
    expect(skipGroupSpeaker(id, 1, t + 2000)).toBe(true)
    await act(async () => { await round })
    expect(asked()).toEqual(['walt', 'baron', 'clara'])
  })

  it('a member taken out of the group while the round runs does not speak in it (T1 A10)', async () => {
    const id = openGroup()
    hang.add('walt')
    const { result } = renderHook(() => useChat())
    let round!: Promise<void>
    act(() => { round = result.current.sendMessage('go') })
    await vi.waitFor(() => expect(asked()).toEqual(['walt']))
    useChatStore.getState().setGroupModels(id, [A, B])
    expect(skipGroupSpeaker(id, 0)).toBe(true)
    await act(async () => { await round })
    expect(asked()).toEqual(['walt', 'baron'])
    expect(said(id)).toEqual(['baron 1'])
  })

  it('what a skipped speaker had already written stays in the chat', async () => {
    // Found on the Mac build: a window in the background paints no frames, so
    // the streamed words had never reached the store when the skip came, and
    // the turn was taken for an empty one and removed.
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const id = openGroup()
    partial.add('walt')
    const { result } = renderHook(() => useChat())
    let round!: Promise<void>
    act(() => { round = result.current.sendMessage('go') })
    await vi.waitFor(() => expect(asked()).toEqual(['walt']))
    await new Promise((r) => setTimeout(r, 50))
    expect(skipGroupSpeaker(id)).toBe(true)
    await act(async () => { await round })
    expect(said(id)).toEqual(['half an answer', 'baron 1', 'clara 1'])
    vi.unstubAllGlobals()
  })

  it('negative control: "Stop round" ends the round, nobody after answers', async () => {
    const id = openGroup()
    hang.add('walt')
    const { result } = renderHook(() => useChat())
    let round!: Promise<void>
    act(() => { round = result.current.sendMessage('go') })
    await vi.waitFor(() => expect(asked()).toEqual(['walt']))
    act(() => { result.current.stopGeneration() })
    await act(async () => { await round })
    expect(asked()).toEqual(['walt'])
    expect(useGroupRoundStore.getState().live[id]).toBeUndefined()
  })
})
