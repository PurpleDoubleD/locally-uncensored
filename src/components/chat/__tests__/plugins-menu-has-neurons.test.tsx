/**
 * @vitest-environment jsdom
 *
 * The Neurons row under Plugins (3.1.0, David 08.11.2026): Neurons on and off
 * like the other plugins, its window opening as it turns on, and Rust's
 * switch following the row (useNeuronPluginSync) without restarting the
 * engine at a start of LU when nothing changed.
 *
 * Run: npx vitest run src/components/chat/__tests__/plugins-menu-has-neurons.test.tsx
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor, act } from '@testing-library/react'

const pluginSet = vi.fn(async (enabled: boolean, _tuning?: unknown) => ({ enabled, restarted: false }))
const pluginStatus = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../api/neuron', () => ({
  neuronPluginSet: (e: boolean, t?: unknown) => pluginSet(e, t),
  neuronPluginStatus: async () => ({ ...pluginStatus }),
}))
vi.mock('../../../api/engine', () => ({ bundledEngineStatus: async () => ({ running: true, ctx: 8192 }) }))
vi.mock('../../../api/backend', async (orig) => ({ ...(await orig<object>()), isTauri: () => true }))

import { NeuronPluginRow, NEURONS_CLOUD_REASON, NEURONS_ON_LINE } from '../NeuronPluginRow'
import { PluginsDropdown } from '../PluginsDropdown'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useNeuronWindow } from '../../../stores/neuronWindowStore'
import { useNeuronPluginSync } from '../../../hooks/useNeuronPlugin'

beforeEach(() => {
  pluginSet.mockClear()
  pluginStatus.enabled = false
  useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: false, appMode: 'local' })
  useNeuronWindow.setState({ open: false, collapsed: false, pos: null })
})
afterEach(() => cleanup())

describe('the Neurons row', () => {
  it('starts off; on opens the window, off closes it', () => {
    render(<NeuronPluginRow />)
    const sw = screen.getByTestId('plugins-neurons-switch')
    expect(sw.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('plugins-neurons-open')).toBeNull()
    fireEvent.click(sw)
    expect(useSettingsStore.getState().settings.neuronsPluginEnabled).toBe(true)
    expect(useNeuronWindow.getState().open).toBe(true)
    expect(screen.getByTestId('plugins-neurons-line').textContent).toBe(NEURONS_ON_LINE)
    fireEvent.click(sw)
    expect(useSettingsStore.getState().settings.neuronsPluginEnabled).toBe(false)
    expect(useNeuronWindow.getState().open).toBe(false)
  })

  it('brings a closed window back with Open', () => {
    useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: true })
    const onOpen = vi.fn()
    render(<NeuronPluginRow onOpenWindow={onOpen} />)
    fireEvent.click(screen.getByTestId('plugins-neurons-open'))
    expect(useNeuronWindow.getState().open).toBe(true)
    expect(onOpen).toHaveBeenCalled()
  })

  it('is grey in Cloud mode, with the reason', () => {
    useSettingsStore.getState().updateSettings({ appMode: 'cloud', neuronsPluginEnabled: true })
    render(<NeuronPluginRow />)
    const sw = screen.getByTestId('plugins-neurons-switch') as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    expect(sw.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('plugins-neurons-reason').textContent).toBe(NEURONS_CLOUD_REASON)
  })

  it('is in the Plugins menu of plain Chat, of Agent and of Code, with its dot while on', () => {
    for (const props of [{}, { agentTools: true }, { iconOnly: true, agentTools: true }]) {
      const { unmount } = render(<PluginsDropdown {...props} />)
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByTestId('plugins-neurons')).toBeTruthy()
      unmount()
    }
    useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: true })
    render(<PluginsDropdown />)
    expect(screen.getByTestId('plugins-dot-neurons')).toBeTruthy()
  })
})

describe('Rust follows the row', () => {
  it('stays quiet at start when Rust already agrees, and speaks on a change', async () => {
    renderHook(() => useNeuronPluginSync())
    await new Promise((r) => setTimeout(r, 0))
    expect(pluginSet).not.toHaveBeenCalled()
    act(() => useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: true }))
    await waitFor(() => expect(pluginSet).toHaveBeenCalledTimes(1))
    expect(pluginSet.mock.calls[0][0]).toBe(true)
    act(() => useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: false }))
    await waitFor(() => expect(pluginSet).toHaveBeenCalledTimes(2))
    expect(pluginSet.mock.calls[1][0]).toBe(false)
  })

  it('turns Rust off at start when a 3.0.9 pre-release left it on', async () => {
    pluginStatus.enabled = true
    renderHook(() => useNeuronPluginSync())
    await waitFor(() => expect(pluginSet).toHaveBeenCalledWith(false, expect.anything()))
  })

  it('closes the window when the plugin goes off', async () => {
    useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: true })
    useNeuronWindow.setState({ open: true })
    renderHook(() => useNeuronPluginSync())
    act(() => useSettingsStore.getState().updateSettings({ neuronsPluginEnabled: false }))
    expect(useNeuronWindow.getState().open).toBe(false)
  })
})
