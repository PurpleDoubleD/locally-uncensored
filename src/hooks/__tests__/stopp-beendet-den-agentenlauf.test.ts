/**
 * @vitest-environment jsdom
 *
 * Stop has to mean stop, counted in REQUESTS.
 *
 * Bug s of the 3.0.0 list, reported by a user on 2026-09-03 in cloud
 * mode: "i stopped it but that boy is still working and ready for the next
 * prompt", "holy f its eating my credits", "its not even doing anything jus
 * eating away". Every request that reaches the cloud after Stop is metered on
 * the server, so this is the only bug on that list that spends the customer's
 * money while they watch.
 *
 * The 2.6.8 audit asserted the Stop path three times and never proved the third
 * assertion in the built program. So this file reads no source text and trusts
 * no flag. It mounts the real hook, counts every `/chat/completions` that
 * leaves the process, presses Stop, lets time pass, and counts again. The
 * number after Stop has to be the number before it.
 *
 * Die Gegenprobe zu jeder Zahl hier: ohne Stop laeuft dieselbe Schleife bis an
 * ihre Decke, gemessen 199 Modellaufrufe. Eine "1" unten ist also ein Ergebnis
 * und kein Zufall.
 *
 * Run: npx vitest run src/hooks/__tests__/stopp-beendet-den-agentenlauf.test.ts
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
import { __resetRunStopsForTests, isRunStopped } from '../../lib/run-stop'
import { WAKE_BUNDLE_MS } from '../../lib/agent-wake'
import { makeTaskId } from '../../lib/agent-tasks'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

const sse = (payload: object) =>
  new Response(
    `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

/**
 * One model turn that asks for a tool. The loop only ends at zero tool calls,
 * so a stream shaped like this keeps it going — which is the point: whatever
 * ends the run is Stop, not the model running out of things to say.
 *
 * `todo_write` is the tool because it is the only builtin that neither touches
 * the Tauri side nor the network: it writes the plan into the todo store and
 * returns. The args differ per call so the duplicate-call breaker does not eat
 * the second one.
 */
const werkzeugZug = (call: number) => sse({
  choices: [{
    delta: {
      tool_calls: [{
        index: 0,
        id: `call_${call}`,
        type: 'function',
        function: {
          name: 'todo_write',
          arguments: JSON.stringify({ todos: [{ content: `Schritt ${call}`, status: 'in_progress' }] }),
        },
      }],
    },
  }],
})

/** One turn that ends the run: text, no tool call, and not a "done". */
const textZug = () => sse({ choices: [{ delta: { content: 'noch nicht fertig, weiter beim naechsten Mal' } }] })

/** A conversation in Agent mode on a cloud model. */
function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useModelStore.setState({ models: [], activeModel: MODEL })
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  // 3.1.2: a chat without a workspace asks first (lib/agent-workspace-ask.ts).
  useAgentModeStore.getState().setWorkspace(convId, { kind: 'sandbox' })
  return convId
}

interface Zaehler {
  /** How many model calls have left the process so far. */
  readonly n: () => number
  /** Run `fn` while the n-th model call is being answered. */
  readonly nach: (n: number, fn: () => void) => void
}

/**
 * Count every model call.
 *
 * `art: 'werkzeug'` keeps the loop running forever, `art: 'text'` lets one pass
 * end so the /loop driver gets to schedule the next one.
 */
function zaehleModellaufrufe(art: 'werkzeug' | 'text' = 'werkzeug'): Zaehler {
  let n = 0
  const haken = new Map<number, () => void>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
    n++
    const antwort = art === 'text' ? textZug() : werkzeugZug(n)
    haken.get(n)?.()
    return antwort
  })
  return { n: () => n, nach: (k, fn) => { haken.set(k, fn) } }
}

/** Real time, because the wake watcher and the /loop driver park real timers. */
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  // Ohne die eingebauten Werkzeuge liefe die Schleife zwar, aber jedes
  // Werkzeug faende keinen Rumpf und antwortete mit einem Fehler. Der Fall
  // "Stop waehrend das Werkzeug laeuft" haette dann gar kein Fenster.
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
})
afterEach(() => vi.restoreAllMocks())

describe('Stop, gemessen in Anfragen an die Wolke', () => {
  it('nach Stop verlaesst keine weitere Anfrage den Prozess', async () => {
    seed()
    const zaehler = zaehleModellaufrufe()
    const { result } = renderHook(() => useChat())

    // Stop mid-stream on the first answer, the way a human presses it.
    zaehler.nach(1, () => { result.current.stopGeneration() })

    await act(async () => { await result.current.sendMessage('go') })
    const beimStop = zaehler.n()
    await act(async () => { await warte(50) })

    expect(beimStop).toBe(1)
    expect(zaehler.n()).toBe(1)
  })

  it('ein fertiger Hintergrundagent startet nach Stop KEINEN neuen Zug', async () => {
    // Das Loch, das den Kunden Geld gekostet hat, gemessen: 1 Aufruf bis zum
    // Stop, 200 danach. Ein Hintergrundagent laeuft nach Stop absichtlich
    // weiter (sub-agent.ts schreibt aus, warum). Sein ERGEBNIS holte danach
    // aber den Hauptagenten zurueck — ein voller Agentenzug in die Wolke, eine
    // Sekunde nach Stop, ohne dass jemand etwas geschrieben hat. Die Regel in
    // lib/agent-wake.ts kannte den Stop nicht.
    const convId = seed()
    const zaehler = zaehleModellaufrufe()
    const { result } = renderHook(() => useChat())

    zaehler.nach(1, () => {
      // Der Hintergrundagent wird waehrend des Zuges fertig, der Mensch drueckt
      // Stop. Genau diese Reihenfolge meldete a user.
      const aufgabe = makeTaskId(1)
      useAgentTaskStore.getState().start({
        id: aufgabe, convId, goal: 'nachsehen', context: '',
        background: true, startedAt: Date.now(), controller: new AbortController(),
      })
      useAgentTaskStore.getState().finish(aufgabe, {
        status: 'done', output: 'fertig', endedAt: Date.now(),
      })
      result.current.stopGeneration()
    })

    await act(async () => { await result.current.sendMessage('go') })
    const beimStop = zaehler.n()
    await act(async () => { await warte(WAKE_BUNDLE_MS + 500) })

    expect(beimStop).toBe(1)
    expect(zaehler.n()).toBe(1)
    // Und das Ergebnis ist nicht verloren, nur ungemeldet: der naechste Zug,
    // den der Mensch selbst ausloest, nimmt es mit.
    expect(useAgentTaskStore.getState().forConv(convId)[0].reported).toBe(false)
  })

  it('Stop waehrend einer Werkzeugausfuehrung beendet den Lauf genauso', async () => {
    // Der Stop faellt nicht in den Modellaufruf, sondern in das Fenster danach,
    // in dem das Werkzeug laeuft. Die Pruefspur bekommt ihren Eintrag genau
    // dann, wenn der Ausfuehrer ein Werkzeug ANSTELLT — kein Zeitgeber, der
    // auch frueher oder spaeter feuern koennte.
    const convId = seed()
    const zaehler = zaehleModellaufrufe()
    const { result } = renderHook(() => useChat())

    const ab = useToolAuditStore.subscribe((s) => {
      if (!s.entries[convId]?.length) return
      ab()
      result.current.stopGeneration()
    })

    await act(async () => { await result.current.sendMessage('go') })
    await act(async () => { await warte(50) })

    // Das Werkzeug ist wirklich angestellt worden, der Stop lag also im
    // richtigen Fenster und nicht davor.
    expect(useToolAuditStore.getState().entries[convId]).toHaveLength(1)
    // Und er greift bis in das Werkzeug hinein: ohne Stop schreibt
    // `todo_write` seinen Plan (im selben Aufbau nachgemessen), hier nicht.
    expect(useTodoStore.getState().getTodos(convId)).toHaveLength(0)
    expect(zaehler.n()).toBe(1)
  })

  it('Stop raeumt einen wartenden /loop-Pass weg', async () => {
    // Der Zustand ZWISCHEN zwei Paessen. Es generiert nichts, die Leiste ueber
    // dem Eingabefeld ist der einzige Stop auf dem Schirm, und der landete auf
    // einem Stop, der von der Schleife nichts wusste: der naechste Pass ging
    // trotzdem in die Wolke, und der naechste, und der naechste.
    const convId = seed()
    const zaehler = zaehleModellaufrufe('text')
    const { result } = renderHook(() => useChat())

    await act(async () => { await result.current.sendMessage('/loop 1s zaehle weiter') })
    // Pass 1 ist durch, Pass 2 haengt am Zeitgeber, die Leiste steht.
    expect(zaehler.n()).toBe(1)
    expect(useAgentLoopStore.getState().loops[convId]?.conversationId).toBe(convId)

    act(() => { result.current.stopGeneration() })
    await act(async () => { await warte(1500) })

    // Die Zahl zuerst, denn sie ist die Rechnung.
    expect(zaehler.n()).toBe(1)
    expect(useAgentLoopStore.getState().loops[convId]).toBeUndefined()
    expect(isRunStopped(convId)).toBe(true)
  })

  it('nach Stop laeuft die Schleife auf eine neue Nachricht wieder an', async () => {
    // Die Gegenprobe. Ein Stop, der den Chat fuer den Rest der Sitzung
    // lahmlegt, waere dieselbe Sorte Fehler mit anderem Vorzeichen.
    const convId = seed()
    const zaehler = zaehleModellaufrufe()
    const { result } = renderHook(() => useChat())

    zaehler.nach(1, () => { result.current.stopGeneration() })
    await act(async () => { await result.current.sendMessage('go') })
    expect(zaehler.n()).toBe(1)
    expect(isRunStopped(convId)).toBe(true)

    zaehler.nach(2, () => { result.current.stopGeneration() })
    await act(async () => { await result.current.sendMessage('nochmal') })

    expect(zaehler.n()).toBe(2)
    expect(isRunStopped(convId)).toBe(true)
  })
})
