// D13 (David, 04.11.2026): Neurons is hidden in 3.0.9, not removed. One
// switch (lib/features) closes every way in; these tests hold the switch and
// each entry it closes, so 3.1.0 turns it back on in one place.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NEURONS_ENABLED, visibleView } from '../features'
import { useUIStore } from '../../stores/uiStore'
import { buildCommands } from '../../components/ui/command-actions'
import { SHORTCUT_ACTIONS, shortcutKeys } from '../../hooks/useKeyboardShortcuts'
import { RELEASE_NOTES } from '../release-notes'
import { HOWTO } from '../howto'

const SRC = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf-8')

describe('Neurons is hidden in 3.0.9', () => {
  beforeEach(() => useUIStore.setState({ currentView: 'chat' }))

  it('the switch is off', () => {
    expect(NEURONS_ENABLED).toBe(false)
  })

  it('a hidden view falls back to Chat, the others stay', () => {
    expect(visibleView('neuron')).toBe('chat')
    for (const v of ['chat', 'models', 'settings', 'create', 'benchmark', 'voice'] as const) expect(visibleView(v)).toBe(v)
  })

  it('a button or link that still asks for Neurons lands on Chat', () => {
    useUIStore.getState().setView('models')
    useUIStore.getState().setView('neuron')
    expect(useUIStore.getState().currentView).toBe('chat')
  })

  it('a saved UI state with "neuron" comes back as Chat', () => {
    const merge = useUIStore.persist.getOptions().merge!
    const merged = merge({ currentView: 'neuron', sidebarOpen: false }, useUIStore.getState()) as ReturnType<typeof useUIStore.getState>
    expect(merged.currentView).toBe('chat')
    expect(merged.sidebarOpen).toBe(false)
  })

  it('the header has no Neurons tab', () => {
    const header = read('components/layout/Header.tsx')
    expect(header).toMatch(/\.filter\(\(t\) => t\.view === null \|\| visibleView\(t\.view\) === t\.view\)/)
  })

  it('the command palette has neither the view nor the introduction', () => {
    const actions = buildCommands({ shortcuts: SHORTCUT_ACTIONS, keysFor: shortcutKeys, localViewsAvailable: true, setView: vi.fn(), openCompare: vi.fn(), toggleSidebar: vi.fn(), setActiveModel: vi.fn(), models: [], activeModel: null, quit: null })
    expect(actions.filter((a) => /neuron/i.test(a.id + a.label))).toEqual([])
    expect(actions.find((a) => a.id === 'view-models')).toBeDefined()
  })

  it('the app never mounts the Neurons view', () => {
    expect(read('components/layout/AppShell.tsx')).toContain("currentView === 'neuron' && NEURONS_ENABLED && <LazyView")
  })

  it('the 3.0.9 release notes and the how-to lines do not name Neurons', () => {
    const note = RELEASE_NOTES.find((n) => n.version === '3.0.9')!
    expect(JSON.stringify(note)).not.toMatch(/neuron/i)
    expect(JSON.stringify(HOWTO['gguf-file'])).not.toMatch(/neuron/i)
  })

  it('Models and Discover name no Neuron tweaker while it is off', () => {
    const discover = read('components/models/DiscoverModels.tsx')
    for (const m of discover.matchAll(/Neuron (tweaker|sliders)/g)) {
      const line = discover.slice(discover.lastIndexOf('\n', m.index!), discover.indexOf('\n', m.index!))
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
      expect(line).toContain('NEURONS_ENABLED')
    }
  })
})
