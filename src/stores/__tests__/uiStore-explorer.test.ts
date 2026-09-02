/**
 * uiStore persist (2.6.6 C3 / R1).
 *
 * This store was NOT persisted before. It carries currentView and
 * cloudGateOpen, so a naive persist would change what the app does on start:
 * it would reopen on whatever tab was left behind, or come up with the cloud
 * gate on screen. partialize therefore has to hold EXACTLY the fields that
 * are a stated preference, and this test is the guard on that word "exactly".
 *
 * Widened in the web-parity round (2.6.8): sidebarOpen joined the written set.
 * It is the user saying "rail" or "list", the same class of choice as
 * explorerCollapsed, and forgetting it on every restart is the bug David
 * reported. currentView / cloudGateOpen / cloudTeaser stay forbidden, because
 * those steer where the app STARTS rather than how it looks.
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
  it('persists exactly explorerWidth, explorerCollapsed and sidebarOpen', () => {
    const partialize = useUIStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const written = partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual(['explorerCollapsed', 'explorerWidth', 'sidebarOpen'])
  })

  it('counter-test: nothing that steers the app start comes along', () => {
    const partialize = useUIStore.persist.getOptions().partialize!
    const written = partialize(useUIStore.getState()) as Record<string, unknown>
    // sidebarOpen left this list in the web-parity round, see the file header.
    for (const forbidden of ['currentView', 'cloudGateOpen', 'cloudTeaser', 'settingsFocus']) {
      expect(written).not.toHaveProperty(forbidden)
    }
    // Actions must not ride along either, they would be dead weight in storage.
    expect(Object.values(written).every((v) => typeof v !== 'function')).toBe(true)
  })

  it('keeps writing only those three after the state moved', () => {
    useUIStore.setState({ currentView: 'settings', cloudGateOpen: true, explorerCollapsed: true, explorerWidth: 333, sidebarOpen: true })
    const written = useUIStore.persist.getOptions().partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(written).toEqual({ explorerWidth: 333, explorerCollapsed: true, sidebarOpen: true })
  })

  it('and that is what actually lands in storage', () => {
    useUIStore.setState({ currentView: 'benchmark', cloudGateOpen: true, sidebarOpen: false })
    useUIStore.getState().setExplorerWidth(420, 1600)
    useUIStore.getState().setExplorerCollapsed(true)
    const raw = memory.getItem('locally-uncensored-ui')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state).toEqual({ explorerWidth: 420, explorerCollapsed: true, sidebarOpen: false })
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
