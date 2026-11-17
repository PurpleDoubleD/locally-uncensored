/**
 * @vitest-environment jsdom
 *
 * 3.1.2: Agent Mode ist ohne Pop-up an. Die erste Nachricht eines Chats ohne
 * Arbeitsordner wartet auf die Karte "Sandbox / Folder…" und geht danach
 * genau einmal hinaus. Gemessen in Anfragen, die den Prozess verlassen, am
 * echten Hook.
 *
 * Run: npx vitest run src/hooks/__tests__/erste-agent-nachricht-wartet-auf-den-ordner.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/cloud/supabase', () => ({
  getAccessToken: async () => 'session-token-abc',
}))
vi.mock('../../api/rag', () => ({
  retrieveContext: async () => ({ context: { chunks: [], query: '', documentIds: [] }, scoredChunks: [] }),
  generateEmbeddings: async () => [[0.1, 0.2]],
}))
// Nothing here is about speech, VRAM handoffs or memory extraction.
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useChat } from '../useChat'
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
import { __resetWorkspaceAskForTests, hasOpenAsk, resolveWorkspaceAsk } from '../../lib/agent-workspace-ask'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

const sse = (payload: object) =>
  new Response(
    `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const antwort = () => sse({ choices: [{ delta: { content: 'fertig' } }] })

/** Every model call body that leaves the process. */
function zaehle(): string[] {
  const bodies: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/chat/completions')) return new Response('{}', { status: 200 })
    bodies.push(String(init?.body ?? ''))
    return antwort()
  })
  return bodies
}

function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useModelStore.setState({ models: [], activeModel: MODEL })
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  return convId
}

const userTexts = (convId: string) =>
  (useChatStore.getState().conversations.find((c) => c.id === convId)?.messages ?? [])
    .filter((m) => m.role === 'user').map((m) => m.content)

beforeEach(() => {
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  __resetWorkspaceAskForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentModeStore.setState({ agentModeActive: {}, workspaces: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useToolAuditStore.setState({ entries: {} })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off', defaultWorkspace: null },
  })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
})
afterEach(() => vi.restoreAllMocks())

describe('die erste Agent-Nachricht wartet auf die Wahl des Ordners (3.1.2)', () => {
  it('ohne Ordner geht nichts an das Modell, die Nachricht steht im Verlauf', async () => {
    const convId = seed()
    const bodies = zaehle()
    const { result } = renderHook(() => useChat())
    await act(async () => { await result.current.sendMessage('baue eine todo app') })
    expect(bodies).toHaveLength(0)
    expect(hasOpenAsk(convId)).toBe(true)
    expect(userTexts(convId)).toEqual(['baue eine todo app'])
  })

  it('nach der Wahl geht genau diese Nachricht hinaus, einmal, und steht einmal da', async () => {
    const convId = seed()
    const bodies = zaehle()
    const { result } = renderHook(() => useChat())
    await act(async () => { await result.current.sendMessage('baue eine todo app') })
    await act(async () => {
      await resolveWorkspaceAsk(convId, { kind: 'sandbox' }, result.current.sendMessage)
    })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('baue eine todo app')
    expect(userTexts(convId)).toEqual(['baue eine todo app'])
    expect(useAgentModeStore.getState().workspaces[convId]).toEqual({ kind: 'sandbox' })
    // Die Wahl gilt fuer den Chat: die zweite Nachricht fragt nicht mehr.
    await act(async () => { await result.current.sendMessage('und jetzt dunkel') })
    expect(bodies).toHaveLength(2)
    expect(hasOpenAsk(convId)).toBe(false)
  })

  it('ein Chat mit Ordner fragt gar nicht erst', async () => {
    const convId = seed()
    useAgentModeStore.getState().setWorkspace(convId, { kind: 'sandbox' })
    const bodies = zaehle()
    const { result } = renderHook(() => useChat())
    await act(async () => { await result.current.sendMessage('hallo') })
    expect(bodies).toHaveLength(1)
    expect(hasOpenAsk(convId)).toBe(false)
  })

  it('ein Chat ohne Agent fragt nie', async () => {
    const convId = seed()
    useAgentModeStore.getState().setAgentModeActive(convId, false)
    const bodies = zaehle()
    const { result } = renderHook(() => useChat())
    await act(async () => { await result.current.sendMessage('hallo') })
    expect(bodies).toHaveLength(1)
    expect(hasOpenAsk(convId)).toBe(false)
  })
})
