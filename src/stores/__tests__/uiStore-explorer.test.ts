/**
 * uiStore persist (2.6.6 C3 / R1).
 *
 * This store was NOT persisted before. It carries currentView and
 * cloudGateOpen, so a naive persist would change what the app does on start:
 * it would reopen on whatever tab was left behind, or come up with the cloud
 * gate on screen. partialize therefore has to hold EXACTLY the two explorer
 * fields, and this test is the guard on that word "exactly".
 *
 * Run: npx vitest run src/stores/__tests__/uiStore-explorer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The suite runs in node, where there is no localStorage. Without one, zustand
// skips the persist middleware entirely and there would be nothing to assert
// against. Hoisted so it exists before the store module is imported.
const memory = vi.hoisted(() => {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
  // zustand reaches for window.localStorage specifically, so the shim has to
  // sit there and not only on globalThis.
  const g = globalThis as unknown as { window?: { localStorage: typeof storage }; localStorage?: typeof storage }
  g.localStorage = storage
  g.window = { ...(g.window ?? {}), localStorage: storage }
  return storage
})

import {
  EXPLORER_DEFAULT_WIDTH,
  EXPLORER_MIN_WIDTH,
  clampExplorerWidth,
  useUIStore,
} from '../uiStore'

describe('what the ui store writes to disk', () => {
  it('persistiert genau die fuenf Geometriefelder der drei Flaechen', () => {
    // 2.6.8: das Agenten-Panel bringt seine zwei mit. Die Liste bleibt
    // ausgeschrieben und wird nicht aus dem Zustand abgeleitet — sie ist eine
    // ERLAUBNIS, keine Beschreibung. Jedes weitere Feld hier muss jemand
    // hinschreiben und dabei begruenden, warum es einen Neustart ueberleben
    // soll; das ist der ganze Zweck dieser Zeile.
    //
    // Was ausdruecklich NICHT dazugehoert: die Aufgaben selbst. Die liegen in
    // agentTaskStore und werden gar nicht persistiert, weil eine
    // wiederhergestellte Zeile mit "laeuft" ueber den Zustand der Maschine
    // luegen wuerde — samt einem Abbrechen-Knopf, der nichts mehr abbricht.
    //
    // 02.09.2026, das fuenfte Feld — und hier steht die Begruendung, die diese
    // Liste verlangt: `sidebarWidth` ist die gezogene Breite der Chatspalte
    // links (D1, David: "bzw dynamisch mit vergroesserung anpassend"). Sie
    // gehoert in dieselbe Klasse wie die anderen vier: eine VORLIEBE ueber die
    // Geometrie, die niemand nach jedem Start neu einstellen will. Sie steuert
    // keinen Startzustand — die Spalte kommt so breit zurueck, wie der Mensch
    // sie gezogen hat, und das ist das ganze Versprechen.
    //
    // `sidebarOpen` steht dagegen weiter im Gegentest unten: OB die Spalte
    // offen ist, entscheidet der Start, nicht das Gedaechtnis.
    const partialize = useUIStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const written = partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual([
      'agentPanelCollapsed', 'agentPanelWidth', 'explorerCollapsed', 'explorerWidth',
      'sidebarWidth',
    ])
  })

  it('counter-test: nothing that steers the app start comes along', () => {
    const partialize = useUIStore.persist.getOptions().partialize!
    const written = partialize(useUIStore.getState()) as Record<string, unknown>
    for (const forbidden of ['currentView', 'cloudGateOpen', 'cloudTeaser', 'sidebarOpen']) {
      expect(written).not.toHaveProperty(forbidden)
    }
    // Actions must not ride along either, they would be dead weight in storage.
    expect(Object.values(written).every((v) => typeof v !== 'function')).toBe(true)
  })

  it('schreibt auch nach einer Zustandsaenderung nur diese fuenf', () => {
    useUIStore.setState({
      currentView: 'settings', cloudGateOpen: true,
      explorerCollapsed: true, explorerWidth: 333,
      agentPanelCollapsed: false, agentPanelWidth: 222,
      sidebarWidth: 310,
    })
    const written = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(written).toEqual({
      explorerWidth: 333, explorerCollapsed: true,
      agentPanelWidth: 222, agentPanelCollapsed: false,
      sidebarWidth: 310,
    })
  })

  it('und genau das landet auch wirklich im Speicher', () => {
    useUIStore.setState({ currentView: 'benchmark', cloudGateOpen: true })
    useUIStore.getState().setExplorerWidth(420, 1600)
    useUIStore.getState().setExplorerCollapsed(true)
    useUIStore.getState().setAgentPanelWidth(260, 1600)
    useUIStore.getState().setAgentPanelCollapsed(false)
    useUIStore.getState().setSidebarWidth(310, 1600)
    const raw = memory.getItem('locally-uncensored-ui')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state).toEqual({
      explorerWidth: 420, explorerCollapsed: true,
      agentPanelWidth: 260, agentPanelCollapsed: false,
      sidebarWidth: 310,
    })
  })
})

describe('the drag stays inside the panel limits', () => {
  it('keeps a sane width untouched', () => {
    expect(clampExplorerWidth(320, 1600)).toBe(320)
  })

  it('floors at the minimum', () => {
    expect(clampExplorerWidth(40, 1600)).toBe(EXPLORER_MIN_WIDTH)
    expect(clampExplorerWidth(-500, 1600)).toBe(EXPLORER_MIN_WIDTH)
  })

  it('ceilings at half the window', () => {
    expect(clampExplorerWidth(5000, 1600)).toBe(800)
    expect(clampExplorerWidth(900, 1000)).toBe(500)
  })

  it('counter-test: on a narrow window the minimum wins over the half', () => {
    // Half of 300 is 150, which is below the floor: the panel stays readable.
    expect(clampExplorerWidth(280, 300)).toBe(EXPLORER_MIN_WIDTH)
  })

  it('falls back to the default when the number is not one', () => {
    expect(clampExplorerWidth(Number.NaN, 1600)).toBe(EXPLORER_DEFAULT_WIDTH)
  })
})

describe('the store actions', () => {
  beforeEach(() => {
    useUIStore.setState({ explorerWidth: EXPLORER_DEFAULT_WIDTH, explorerCollapsed: false })
  })

  it('starts at 280 and open', () => {
    expect(useUIStore.getState().explorerWidth).toBe(280)
    expect(useUIStore.getState().explorerCollapsed).toBe(false)
  })

  it('clamps through the setter, not only in the component', () => {
    useUIStore.getState().setExplorerWidth(10_000, 1200)
    expect(useUIStore.getState().explorerWidth).toBe(600)
    useUIStore.getState().setExplorerWidth(10, 1200)
    expect(useUIStore.getState().explorerWidth).toBe(EXPLORER_MIN_WIDTH)
  })

  it('collapses and comes back', () => {
    useUIStore.getState().setExplorerCollapsed(true)
    expect(useUIStore.getState().explorerCollapsed).toBe(true)
    useUIStore.getState().setExplorerCollapsed(false)
    expect(useUIStore.getState().explorerCollapsed).toBe(false)
  })
})
