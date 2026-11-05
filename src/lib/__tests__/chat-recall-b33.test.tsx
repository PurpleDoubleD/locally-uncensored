// @vitest-environment jsdom
/**
 * B33 (3.0.9, GitHub #205): recall for long chats. What a compaction keeps
 * out of the payload is embedded locally and the related old messages come
 * back word for word, next to the summary.
 *
 *  - only messages the compaction hides are candidates (nothing twice);
 *  - an unrelated old message does not ride along (raw cosine floor);
 *  - it runs only on a local embedder; an Ollama on another host is refused
 *    and gets not a single message;
 *  - it is off unless switched on, and the switch cannot be turned on
 *    without a local embedder;
 *  - a deleted chat takes its vectors with it.
 *
 * Run: npx vitest run src/lib/__tests__/chat-recall-b33.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const env = vi.hoisted(() => ({
  lane: 'ollama-local' as string,
  embedCalls: [] as string[][],
}))
vi.mock('../../api/embed-availability', async (orig) => ({
  ...(await orig<typeof import('../../api/embed-availability')>()),
  embeddingLane: async () => ({ lane: env.lane, endpoint: env.lane === 'ollama-remote' ? 'http://10.0.0.5:11434' : null }),
}))
// Hand-built vectors: the topic decides the direction.
function vec(text: string): number[] {
  const t = text.toLowerCase()
  if (t.includes('boat') || t.includes('sail')) return [1, 0.1, 0]
  if (t.includes('cake') || t.includes('bake')) return [0, 1, 0.1]
  return [0.1, 0, 1]
}
vi.mock('../../api/rag', async (orig) => ({
  ...(await orig<typeof import('../../api/rag')>()),
  generateEmbeddings: async (texts: string[]) => { env.embedCalls.push(texts); return texts.map(vec) },
}))
vi.mock('../../hooks/useEmbedLane', () => ({
  useEmbedLane: () => (env.lane === 'pending' ? null : { lane: env.lane, endpoint: null }),
}))

import { recallCandidates, pickRecall, formatRecall, RECALL_PREAMBLE, RECALL_MAX_CHARS } from '../chat-recall'
import { recallForTurn } from '../chat-recall-run'
import { ChatRecallToggle } from '../../components/settings/ChatRecallToggle'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../constants'

const chat = [
  { id: 'u1', role: 'user', content: 'My boat is called Seagull and it has a red sail.' },
  { id: 'a1', role: 'assistant', content: 'A red sail on the Seagull, noted.' },
  { id: 'u2', role: 'user', content: 'Give me a cake recipe I can bake tonight.' },
  { id: 'a2', role: 'assistant', content: 'Bake a lemon cake: flour, sugar, eggs.' },
  { id: 't1', role: 'tool', content: 'boat boat boat (tool output)' },
  { id: 'u3', role: 'user', content: 'What about the weather on Sunday?' },
  { id: 'a3', role: 'assistant', content: 'Sunny.' },
  { id: 'u4', role: 'user', content: 'What colour was the sail of my boat again?' },
]
const compactions = [{ summary: 'They talked about a boat, a cake and the weather.', upToMessageId: 'a2' }]

beforeEach(() => { env.lane = 'ollama-local'; env.embedCalls = [] })
afterEach(cleanup)

describe('B33: which messages can come back', () => {
  it('only user and assistant turns the compaction keeps out of the payload', () => {
    expect(recallCandidates(chat, compactions).map((c) => c.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('without a compaction nothing is hidden, so nothing is recalled', () => {
    expect(recallCandidates(chat, [])).toEqual([])
    expect(recallCandidates(chat, undefined)).toEqual([])
  })

  it('the closest above the floor, back in chat order; unrelated ones stay out', () => {
    const c = recallCandidates(chat, compactions).map((x) => ({ ...x, vector: vec(x.text) }))
    expect(pickRecall(vec('sail boat'), c).map((x) => x.id)).toEqual(['u1', 'a1'])
    expect(pickRecall([0, 0, 1], c)).toEqual([])
  })

  it('the note keeps under its budget', () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, order: i, text: `user: ${'x'.repeat(1200)}` }))
    const note = formatRecall(long)
    expect(note.startsWith(RECALL_PREAMBLE)).toBe(true)
    expect(note.length).toBeLessThanOrEqual(RECALL_MAX_CHARS)
  })
})

describe('B33: the runner, local only', () => {
  const turn = { conversationId: 'c1', messages: chat, compactions, query: 'What colour was the sail of my boat again?', embeddingModel: 'nomic-embed-text' }

  it('on a local embedder the boat messages come back word for word, the cake does not', async () => {
    const note = await recallForTurn(turn)
    expect(note).toContain('red sail')
    expect(note).toContain('user: My boat is called Seagull')
    expect(note).not.toMatch(/cake/i)
  })

  it('an Ollama on another computer gets nothing, and there is no recall', async () => {
    env.lane = 'ollama-remote'
    expect(await recallForTurn(turn)).toBe('')
    expect(env.embedCalls).toEqual([])
  })

  it('no embedder, no recall and no error', async () => {
    env.lane = 'none'
    expect(await recallForTurn(turn)).toBe('')
    expect(env.embedCalls).toEqual([])
  })
})

describe('B33: the switch', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.chatRecall).toBe(false)
  })

  it('cannot be switched on without a local embedder', () => {
    env.lane = 'none'
    useSettingsStore.getState().updateSettings({ chatRecall: false })
    render(<ChatRecallToggle />)
    fireEvent.click(screen.getByRole('switch', { name: 'Recall older messages' }))
    expect(useSettingsStore.getState().settings.chatRecall).toBe(false)
    expect(screen.getByText(/Needs a local embedding model/)).toBeTruthy()
  })

  it('switches on with a local embedder', () => {
    useSettingsStore.getState().updateSettings({ chatRecall: false })
    render(<ChatRecallToggle />)
    fireEvent.click(screen.getByRole('switch', { name: 'Recall older messages' }))
    expect(useSettingsStore.getState().settings.chatRecall).toBe(true)
  })
})

describe('B33: wired into the chat turn', () => {
  const root = resolve(__dirname, '../../..')
  const useChat = readFileSync(resolve(root, 'src/hooks/useChat.ts'), 'utf8')

  it('the plain chat asks for recall only when the switch is on, after the auto-compact', () => {
    expect(useChat).toMatch(/const recallNote = settings\.chatRecall === true && !phoneSystemNote\s*\? await recallForTurn\(/)
    expect(useChat.indexOf('const recallNote')).toBeGreaterThan(useChat.indexOf('await maybeAutoCompact('))
    expect(useChat).toMatch(/\], \[turnContext, recallNote\]\.filter\(Boolean\)\.join\('\\n\\n'\)\)\)/)
  })

  it('a deleted chat takes its vectors with it', () => {
    const store = readFileSync(resolve(root, 'src/stores/chatStore.ts'), 'utf8')
    expect(store).toMatch(/\['chat-recall', \(\) => \{ void deleteRecallConversation\(id\)/)
  })
})
