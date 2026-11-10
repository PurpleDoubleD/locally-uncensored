// 3.1.0 (David, 08.11.2026): Neurons is a plugin. It left the header and has
// no page; switched on under Plugins it opens one window over Chat, Code and
// Agent. Off, no slider steers the engine (Rust's switch, kept in step by
// useNeuronPluginSync). These tests hold each piece of that.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NEURONS_ENABLED, visibleView } from '../features'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { buildCommands } from '../../components/ui/command-actions'
import { SHORTCUT_ACTIONS, shortcutKeys } from '../../hooks/useKeyboardShortcuts'
import { RELEASE_NOTES } from '../release-notes'
import { DEFAULT_SETTINGS } from '../constants'
import { clampWindowPos, defaultWindowPos, NEURON_WINDOW_W, useNeuronWindow } from '../../stores/neuronWindowStore'

const SRC = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf-8')
const CTX = { shortcuts: SHORTCUT_ACTIONS, keysFor: shortcutKeys, localViewsAvailable: true, setView: vi.fn(), openCompare: vi.fn(), toggleSidebar: vi.fn(), setActiveModel: vi.fn(), models: [], activeModel: null, quit: null }

describe('Neurons is a plugin in 3.1.0', () => {
  beforeEach(() => {
    useUIStore.setState({ currentView: 'chat' })
    useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: false })
    useNeuronWindow.setState({ open: false, collapsed: false, pos: null })
  })

  it('exists, and is off until the user turns it on', () => {
    expect(NEURONS_ENABLED).toBe(true)
    expect(DEFAULT_SETTINGS.neuronsPluginEnabled).toBe(false)
  })

  it('has no page: a button, link or saved state that asks for it lands on Chat', () => {
    expect(visibleView('neuron')).toBe('chat')
    for (const v of ['chat', 'models', 'settings', 'create', 'benchmark', 'voice'] as const) expect(visibleView(v)).toBe(v)
    useUIStore.getState().setView('models')
    useUIStore.getState().setView('neuron')
    expect(useUIStore.getState().currentView).toBe('chat')
    const merge = useUIStore.persist.getOptions().merge!
    const merged = merge({ currentView: 'neuron', sidebarOpen: false }, useUIStore.getState()) as ReturnType<typeof useUIStore.getState>
    expect(merged.currentView).toBe('chat')
  })

  it('has no header tab', () => {
    expect(read('components/layout/Header.tsx')).not.toMatch(/id: 'neuron'/)
  })

  it('sits in the Plugins menu of Chat, Agent and Code, in the desktop app', () => {
    const menu = read('components/chat/PluginsDropdown.tsx')
    expect(menu).toMatch(/const neuronsShown = isTauri\(\)/)
    expect(menu).toMatch(/\{neuronsShown && <NeuronPluginRow /)
    // The same menu is the composer's (Chat, Agent) and the Code header's.
    expect(read('components/chat/ChatView.tsx')).toMatch(/<PluginsDropdown openUpward/)
    expect(read('components/chat/CodexView.tsx')).toMatch(/<PluginsDropdown iconOnly/)
  })

  it('mounts its window only while the plugin is on, over the chat surfaces', () => {
    const shell = read('components/layout/AppShell.tsx')
    expect(shell).toMatch(/const neuronsOn = settings\.neuronsPluginEnabled === true && settings\.appMode !== 'cloud' && isTauri\(\)/)
    expect(shell).toContain("{neuronsOn && currentView === 'chat' && <NeuronWindowHost />}")
    // The window itself comes in a chunk of its own.
    expect(read('components/neuron/NeuronWindowHost.tsx')).toContain("lazy(() => import('./NeuronWindow')")
    expect(shell).toContain('useNeuronPluginSync()')
    expect(shell).not.toMatch(/NeuronView/)
  })

  it('is in the command palette only while it is on, as its window', () => {
    expect(buildCommands(CTX).filter((a) => /neuron/i.test(a.id + a.label))).toEqual([])
    useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: true })
    const actions = buildCommands(CTX)
    const open = actions.find((a) => a.id === 'neuron-window')!
    expect(open.label).toBe('Neurons: open window')
    open.run()
    expect(useNeuronWindow.getState().open).toBe(true)
    expect(actions.find((a) => a.id === 'view-neuron')).toBeUndefined()
  })

  it('keeps a persona switch from steering while it is off', () => {
    const src = read('hooks/useNeuronFollowsPersona.ts')
    expect(src).toMatch(/if \(!neuronsPluginOn\(\)\) return/)
  })

  it('keeps the 3.0.9 release notes free of Neurons', () => {
    const note = RELEASE_NOTES.find((n) => n.version === '3.0.9')!
    expect(JSON.stringify(note)).not.toMatch(/neuron/i)
  })
})

describe('the Neurons window stays on screen', () => {
  it('starts on the right, under the header', () => {
    expect(defaultWindowPos(1440)).toEqual({ x: 1440 - NEURON_WINDOW_W - 16, y: 64 })
  })

  it('keeps its title bar reachable after a drag or a smaller window', () => {
    expect(clampWindowPos({ x: -200, y: -50 }, 1200, 800)).toEqual({ x: 12, y: 12 })
    expect(clampWindowPos({ x: 5000, y: 5000 }, 1200, 800)).toEqual({ x: 1200 - NEURON_WINDOW_W - 12, y: 800 - 48 - 12 })
    // Narrower than the window: it sits at the gap, never off the left edge.
    expect(clampWindowPos({ x: 300, y: 100 }, 360, 700).x).toBe(12)
  })

  it('remembers where it stood and whether it was folded, not whether it was open', () => {
    const part = useNeuronWindow.persist.getOptions().partialize!({ ...useNeuronWindow.getState(), open: true, collapsed: true, pos: { x: 10, y: 20 } })
    expect(part).toEqual({ collapsed: true, pos: { x: 10, y: 20 } })
  })
})
