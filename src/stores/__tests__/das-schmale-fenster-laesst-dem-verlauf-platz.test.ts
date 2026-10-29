/**
 * Das schmale Fenster laesst dem Verlauf Platz (Issue 309, T1).
 *
 * Gemessen am 29.10.2026 im Release-Bau auf macOS, Hauptfenster 375x812:
 *   - Chat, Liste offen: die Spalte behielt ihre gespeicherten ~290 px, der
 *     Verlauf daneben war ein 30-px-Streifen.
 *   - Code, Liste zu: der Explorer blieb offen, sein Kopf lag ueber dem Kopf
 *     des Coding Agent, der Composer stapelte seine Knoepfe in ~25 px.
 * Die Klemmen liefen nur beim Ziehen, nie beim Start oder beim Verkleinern.
 *
 * Geprueft wird hier die Regel (uiStore), nicht die Pixel: unter
 * NARROW_VIEWPORT_WIDTH klappen beide Panels zu, die gespeicherte Wahl fuer
 * breite Fenster bleibt auf der Platte und kommt beim Breiterwerden zurueck,
 * und ein im schmalen Fenster ausdruecklich geoeffnetes Panel bleibt offen.
 *
 * Run: npx vitest run src/stores/__tests__/das-schmale-fenster-laesst-dem-verlauf-platz.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Dieselbe Speicher-Attrappe wie in uiStore-explorer.test.ts: ohne
// window.localStorage laesst zustand die persist-Schicht ganz weg.
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
  const g = globalThis as unknown as { window?: { localStorage: typeof storage }; localStorage?: typeof storage }
  g.localStorage = storage
  g.window = { ...(g.window ?? {}), localStorage: storage }
  return storage
})

import * as ui from '../uiStore'

const { useUIStore, clampSidebarWidth, clampExplorerWidth } = ui

function persisted(): Record<string, unknown> {
  return JSON.parse(memory.getItem('locally-uncensored-ui')!).state
}

beforeEach(() => {
  memory.clear()
  useUIStore.setState({
    viewportWidth: 1280,
    narrowStash: null,
    sidebarOpen: true,
    sidebarWidth: 290,
    explorerCollapsed: false,
    explorerWidth: 280,
  } as Partial<ReturnType<typeof useUIStore.getState>>)
})

describe('a 375 px window', () => {
  it('starts with the conversation list and the explorer collapsed', () => {
    useUIStore.getState().fitToViewport(375)
    const s = useUIStore.getState()
    expect(s.sidebarOpen).toBe(false)
    expect(s.explorerCollapsed).toBe(true)
  })

  it('keeps the wide-window choice on disk, not the forced narrow one', () => {
    useUIStore.getState().fitToViewport(375)
    // Irgendein Schreibvorgang, damit persist schreibt.
    useUIStore.getState().setSidebarWidth(300, 1280)
    expect(persisted()).toMatchObject({ sidebarOpen: true, explorerCollapsed: false })
  })

  it('gives the list back when the window grows past the breakpoint', () => {
    useUIStore.getState().fitToViewport(375)
    useUIStore.getState().fitToViewport(1280)
    const s = useUIStore.getState()
    expect(s.sidebarOpen).toBe(true)
    expect(s.explorerCollapsed).toBe(false)
    expect(s.viewportWidth).toBe(1280)
  })

  it('lets the user open a panel explicitly, and a further resize does not shut it', () => {
    useUIStore.getState().fitToViewport(375)
    useUIStore.getState().setSidebarOpen(true)
    useUIStore.getState().setExplorerCollapsed(false)
    useUIStore.getState().fitToViewport(380)
    const s = useUIStore.getState()
    expect(s.sidebarOpen).toBe(true)
    expect(s.explorerCollapsed).toBe(false)
  })

  it('never leaves the stored ~290 px column next to a 30 px transcript', () => {
    useUIStore.getState().fitToViewport(375)
    const s = useUIStore.getState()
    // Was Sidebar.tsx und ExplorerPanel.tsx rendern: die gespeicherte Breite
    // gegen das aktuelle Fenster, nicht die gespeicherte Breite selbst.
    expect(clampSidebarWidth(s.sidebarWidth, s.viewportWidth)).toBeLessThanOrEqual(200)
    expect(clampExplorerWidth(s.explorerWidth, s.viewportWidth)).toBeLessThanOrEqual(200)
    // Und im schmalen Fenster liegen sie ueber dem Verlauf, nicht daneben.
    expect(ui.isNarrowViewport(s.viewportWidth)).toBe(true)
  })
})

describe('a 1280 px window', () => {
  it('changes nothing for a wide window', () => {
    useUIStore.getState().fitToViewport(1280)
    const s = useUIStore.getState()
    expect(s.sidebarOpen).toBe(true)
    expect(s.explorerCollapsed).toBe(false)
    expect(s.narrowStash).toBeNull()
    expect(clampSidebarWidth(s.sidebarWidth, 1280)).toBe(290)
    expect(clampExplorerWidth(s.explorerWidth, 1280)).toBe(280)
    expect(ui.isNarrowViewport(1280)).toBe(false)
  })

  it('pure rule: collapses only on crossing the breakpoint', () => {
    const wide = { viewportWidth: 1280, sidebarOpen: true, explorerCollapsed: false, narrowStash: null }
    const narrow = ui.fitPanelsToViewport(wide, 375)
    expect(narrow).toEqual({
      viewportWidth: 375, sidebarOpen: false, explorerCollapsed: true,
      narrowStash: { sidebarOpen: true, explorerCollapsed: false },
    })
    expect(ui.fitPanelsToViewport(wide, 900)).toEqual({ ...wide, viewportWidth: 900 })
  })
})
