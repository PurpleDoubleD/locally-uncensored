/**
 * @vitest-environment jsdom
 *
 * Blocker 3 (review-lanes.md, Runde 3): ein wartender /loop-Pass ueberlebt
 * Abmelden und Fenster schliessen.
 *
 * `stopAllBackgroundWork()` (`lib/background-shutdown.ts`) raeumt den
 * SPEICHER des /loop auf (`useAgentLoopStore.clear`), aber nicht den
 * Browser-Zeitgeber: die Zeitgeber liegen in `agentLoopTimers`
 * (`useAgentChat.ts`) und `codexLoopTimers` (`useCodex.ts`), und bisher
 * loeschten nur `stopAgent`/`stopCodex` sie. Der faellige Rueckruf pruefte
 * beim Feuern nur, ob DIESE Unterhaltung schon etwas generiert und ob sie die
 * sichtbare ist, nicht, ob der Nutzer den Lauf per Stop-Merker
 * (`lib/run-stop.ts`) beendet hat. Nach Abmelden, Fenster schliessen oder App
 * beenden feuerte der Zeitgeber also trotzdem und schickte eine bezahlte
 * Cloud-Anfrage in eine Sitzung, die die App dem Nutzer bereits als beendet
 * gezeigt hatte.
 *
 * Fix: `isRunStopped(convForLoop)` als ERSTE Pruefung in beiden
 * `fireLoopPass`-Rueckrufen, noch vor dem bestehenden
 * generating/sichtbar-Check.
 *
 * Dieser Test faehrt mit Fake-Timern: /loop starten, den Zeitgeber wirklich
 * REGISTRIEREN lassen (Pass 1 laeuft echt durch), `stopAllBackgroundWork()`
 * rufen (derselbe Pfad wie Abmelden/Fenster schliessen/App beenden), dann
 * den Zeitgeber vorspulen. Der Fetch-Zaehler muss bei 1 (dem ersten,
 * bereits gelaufenen Pass) stehen bleiben statt auf 2 zu steigen.
 *
 * Run: npx vitest run src/hooks/__tests__/loop-pass-ueberlebt-stopAllBackgroundWork-nicht.test.ts
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
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useChat } from '../useChat'
import { __pendingAgentLoopTimersForTests } from '../useAgentChat'
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
import { stopAllBackgroundWork } from '../../lib/background-shutdown'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

const sse = (payload: object) =>
  new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
// Never says the /loop magic-done word, so the driver always schedules
// another pass, that is what gives Blocker 3 something real to prevent.
const textZug = () => sse({ choices: [{ delta: { content: 'weiter beim naechsten Mal' } }] })

function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  // 3.1.2: a chat without a workspace asks first (lib/agent-workspace-ask.ts).
  useAgentModeStore.getState().setWorkspace(convId, { kind: 'sandbox' })
  return convId
}

beforeEach(async () => {
  const { registerBuiltinTools, toolRegistry } = await import('../../api/mcp')
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentModeStore.setState({ agentModeActive: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useToolAuditStore.setState({ entries: {} })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' },
  })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
  useModelStore.setState({ models: [], activeModel: MODEL })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ein wartender /loop-Pass ueberlebt stopAllBackgroundWork() nicht', () => {
  it('nach Abmelden/Fenster-schliessen/App-beenden (stopAllBackgroundWork) geht keine weitere Anfrage raus, wenn der Zeitgeber vorgespult wird', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      calls++
      return textZug()
    })

    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useChat())
      const convA = seed()

      // Pass 1: runs for real, ends without the done-marker, so the driver
      // schedules pass 2 on a real setTimeout held in agentLoopTimers.
      await act(async () => {
        await result.current.sendMessage('/loop 30s zaehle weiter')
      })
      expect(calls).toBe(1)
      expect(__pendingAgentLoopTimersForTests()).toContain(convA)
      expect(useAgentLoopStore.getState().loops[convA]).toBeDefined()

      // The trigger this test stands in for: sign-out, window close, app
      // quit. Clears the loop STORE, but that alone is not what a real
      // browser setTimeout obeys.
      act(() => { stopAllBackgroundWork() })
      expect(useAgentLoopStore.getState().loops[convA]).toBeUndefined()

      // Fast-forward well past pass 2's due time.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })

      // The fix: no second request left the process.
      expect(calls).toBe(1)
      // And the timer map itself is clean, not just quiet this once.
      expect(__pendingAgentLoopTimersForTests()).not.toContain(convA)
    } finally {
      vi.useRealTimers()
    }
  })
})
