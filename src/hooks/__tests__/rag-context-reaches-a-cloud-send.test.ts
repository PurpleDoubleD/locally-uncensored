/**
 * @vitest-environment jsdom
 *
 * The other half of A9, driven through the real hook.
 *
 * The wire-level companion (api/__tests__/rag-context-reaches-the-cloud.test.ts)
 * builds the suffix by hand and proves the transport carries it. Review S2 asked
 * for the step in between, and it is the step that actually breaks: useChat and
 * useAgentChat have to CALL the builder and append the result to the system
 * prompt. A refactor that drops one of those two lines leaves every pure test
 * green and ships a Docs button that silently does nothing.
 *
 * So this file mounts useChat for real, puts documents in the RAG store, stubs
 * only retrieval itself, and reads the JSON body of the outgoing LU Cloud
 * request.
 *
 * Review S3 lives here too: a document is not sent, a SELECTION is. The 200-chunk
 * case proves the 199 passages that did not match stay home. Without it "the text
 * appears in the body" would also pass for an implementation that shipped the
 * whole library on every turn, at the user's expense, in a mode where tokens are
 * money.
 *
 * Run: npx vitest run src/hooks/__tests__/rag-context-reaches-a-cloud-send.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { TextChunk } from '../../types/rag'

const retrieveContext = vi.fn()
vi.mock('../../api/rag', () => ({
  retrieveContext: (...a: unknown[]) => retrieveContext(...a),
  generateEmbeddings: async () => [[0.1, 0.2]],
}))
vi.mock('../../api/cloud/supabase', () => ({
  getAccessToken: async () => 'session-token-abc',
}))
// Nothing in this file is about speech, VRAM handoffs or memory extraction.
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useChat } from '../useChat'
import { useAgentChat } from '../useAgentChat'
import { useChatStore } from '../../stores/chatStore'
import { useRAGStore } from '../../stores/ragStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { RETRIEVAL_FAILED_MESSAGE } from '../../lib/rag-prompt'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'
const HIT = 'The service level target for the Bergheim site is 99.95 percent.'

const okStream = () =>
  new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })

function chunk(i: number, content: string): TextChunk {
  return { id: `c${i}`, documentId: 'doc-1', content, embedding: [0.1, 0.2], index: i } as TextChunk
}

/** A conversation with one indexed document and RAG switched on. */
function seed(chunks: TextChunk[]) {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useRAGStore.setState({
    // Ein echtes DocumentMeta. Das `as any`, das hier stand, hat eine falsche
    // Form verdeckt: `chunks` statt `chunkCount`, kein `type`, kein `addedAt`.
    documents: {
      [convId]: [{ id: 'doc-1', name: 'sla.pdf', type: 'pdf', size: 1, addedAt: 0, chunkCount: chunks.length }],
    },
    chunks,
    ragEnabled: { [convId]: true },
    chunksLoaded: true,
    retrievalError: null,
  })
  useModelStore.setState({ models: [], activeModel: MODEL })
  return convId
}

/** Send one message and hand back the JSON body of the request that went out. */
async function send(text = 'What is the target for Bergheim?') {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okStream())
  const { result } = renderHook(() => useChat())
  await act(async () => {
    await result.current.sendMessage(text)
  })
  const call = spy.mock.calls.find((c) => String(c[0]).includes('/chat/completions'))
  return {
    sent: !!call,
    raw: call ? String((call[1] as RequestInit).body) : '',
    body: call ? JSON.parse(String((call[1] as RequestInit).body)) : null,
  }
}

/** The same send, but through Agent mode, which builds its own system prompt. */
async function sendAsAgent(text = 'What is the target for Bergheim?') {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okStream())
  const { result } = renderHook(() => useAgentChat())
  await act(async () => {
    await result.current.sendAgentMessage(text)
  })
  const call = spy.mock.calls.find((c) => String(c[0]).includes('/chat/completions'))
  return {
    sent: !!call,
    raw: call ? String((call[1] as RequestInit).body) : '',
    body: call ? JSON.parse(String((call[1] as RequestInit).body)) : null,
  }
}

/** Eine Nachricht so, wie sie auf der Leitung steht. */
type Wire = { role: string; content: string }
const systemOf = (body: { messages: Wire[] } | null) =>
  body?.messages.find((m) => m.role === 'system')?.content ?? ''

beforeEach(() => {
  retrieveContext.mockReset()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useRAGStore.setState({ documents: {}, chunks: [], ragEnabled: {}, retrievalError: null })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' },
  })
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      'lu-cloud': { ...s.providers['lu-cloud'], enabled: true },
    },
  }))
})
afterEach(() => vi.restoreAllMocks())

describe('useChat puts the retrieved passages into the cloud request', () => {
  it('the matching passage arrives in the system message', async () => {
    seed([chunk(0, HIT)])
    retrieveContext.mockResolvedValue({
      context: { chunks: [{ content: HIT }], query: 'q', documentIds: ['doc-1'] },
      scoredChunks: [],
    })

    const { sent, body } = await send()
    expect(sent).toBe(true)
    const system = systemOf(body)
    expect(system).toContain(HIT)
    expect(system).toContain('[Source 1]')
  })

  it('with RAG switched off the same send carries nothing of the kind', async () => {
    // Negative control on the hook: the document is indexed and present, only
    // the toggle is off, and the request must come out clean.
    const convId = seed([chunk(0, HIT)])
    useRAGStore.setState({ ragEnabled: { [convId]: false } })
    retrieveContext.mockResolvedValue({
      context: { chunks: [{ content: HIT }], query: 'q', documentIds: ['doc-1'] },
      scoredChunks: [],
    })

    const { raw } = await send()
    expect(retrieveContext).not.toHaveBeenCalled()
    expect(raw).not.toContain('Bergheim site is 99.95')
    expect(raw).not.toContain('[Source 1]')
  })

  it('a retrieval that finds nothing spends no tokens on an empty instruction', async () => {
    seed([chunk(0, HIT)])
    retrieveContext.mockResolvedValue({
      context: { chunks: [], query: 'q', documentIds: [] },
      scoredChunks: [],
    })

    const { raw } = await send()
    expect(raw).not.toContain('[Source 1]')
    expect(raw).not.toContain('Use the following document context')
  })
})

describe('a selection is sent, not the library (S3)', () => {
  it('199 passages that did not match stay on the machine', async () => {
    const all = [
      chunk(0, HIT),
      ...Array.from({ length: 199 }, (_, i) =>
        chunk(i + 1, `Filler passage number ${i + 1} about unrelated internal matters.`),
      ),
    ]
    seed(all)
    // Retrieval hands back the one hit, which is its whole job.
    retrieveContext.mockResolvedValue({
      context: { chunks: [{ content: HIT }], query: 'q', documentIds: ['doc-1'] },
      scoredChunks: [],
    })

    const { raw } = await send()
    expect(raw).toContain('Bergheim site is 99.95')
    // Every single one of the others, checked individually rather than by a
    // length heuristic that a bigger payload could still slip past.
    for (let i = 1; i <= 199; i++) {
      expect(raw).not.toContain(`Filler passage number ${i} `)
    }
    expect(raw.match(/\[Source \d+\]/g)).toHaveLength(1)
  })
})

describe('a retrieval that fails is said out loud, not swallowed (S4)', () => {
  it('the turn still goes out, and the user is told the documents were not read', async () => {
    seed([chunk(0, HIT)])
    retrieveContext.mockRejectedValue(new Error('embeddings server not reachable'))

    const { sent, raw } = await send()
    expect(sent).toBe(true)
    expect(raw).not.toContain('[Source 1]')
    expect(useRAGStore.getState().retrievalError).toBe(RETRIEVAL_FAILED_MESSAGE)
  })

  it('switching Document Chat off clears the notice too', async () => {
    // Nebenbefund from the review: it was only cleared inside the retrieval
    // block, so a user who read the warning and switched RAG off kept a stale
    // alarm over a composer that is no longer searching any documents.
    const convId = seed([chunk(0, HIT)])
    useRAGStore.getState().setRetrievalError(RETRIEVAL_FAILED_MESSAGE)
    useRAGStore.getState().setRagEnabled(convId, false)
    expect(useRAGStore.getState().retrievalError).toBeNull()
  })

  it('switching it back ON does not resurrect or invent a notice', async () => {
    // Negative control on the same line: enabling must leave the field alone.
    const convId = seed([chunk(0, HIT)])
    useRAGStore.getState().setRetrievalError(RETRIEVAL_FAILED_MESSAGE)
    useRAGStore.getState().setRagEnabled(convId, true)
    expect(useRAGStore.getState().retrievalError).toBe(RETRIEVAL_FAILED_MESSAGE)
  })

  it('a later good turn clears the notice', async () => {
    // Negative control: a sticky warning would be its own bug, telling the user
    // their documents are broken forever after one hiccup.
    seed([chunk(0, HIT)])
    useRAGStore.getState().setRetrievalError(RETRIEVAL_FAILED_MESSAGE)
    retrieveContext.mockResolvedValue({
      context: { chunks: [{ content: HIT }], query: 'q', documentIds: ['doc-1'] },
      scoredChunks: [],
    })

    await send()
    expect(useRAGStore.getState().retrievalError).toBeNull()
  })
})

describe('Agent mode carries the documents too, from the same builder', () => {
  it('the matching passage arrives in the agent run system prompt', async () => {
    seed([chunk(0, HIT)])
    retrieveContext.mockResolvedValue({
      context: { chunks: [{ content: HIT }], query: 'q', documentIds: ['doc-1'] },
      scoredChunks: [],
    })

    const { sent, body } = await sendAsAgent()
    expect(sent).toBe(true)
    const system = systemOf(body)
    expect(system).toContain(HIT)
    expect(system).toContain('[Source 1]')
  })

  it('with RAG off the agent run carries none of it', async () => {
    // Negative control for the second surface, same as plain chat.
    const convId = seed([chunk(0, HIT)])
    useRAGStore.setState({ ragEnabled: { [convId]: false } })
    retrieveContext.mockResolvedValue({
      context: { chunks: [{ content: HIT }], query: 'q', documentIds: ['doc-1'] },
      scoredChunks: [],
    })

    const { raw } = await sendAsAgent()
    expect(raw).not.toContain('Bergheim site is 99.95')
    expect(raw).not.toContain('[Source 1]')
  })
})
