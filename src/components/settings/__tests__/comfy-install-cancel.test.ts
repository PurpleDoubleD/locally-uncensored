/**
 * @vitest-environment jsdom
 *
 * A13, Windows counter-check 2026-09-02: "waehrend des Repairs gibt es keinen
 * Abbruchknopf". Rust has had one the whole time (`cancel_comfyui_install`
 * sets the flag, and every step of the installer and of `repair_comfyui_env`
 * reads it), Onboarding offered it, and Settings did not. A repair pulls two
 * gigabytes of PyTorch and runs for twenty minutes, so the only way out was
 * killing the app.
 *
 * This mounts the real panel, presses Repair environment, presses Cancel and
 * reads back what the backend was told and what the panel says afterwards.
 *
 * Run: npx vitest run src/components/settings/__tests__/comfy-install-cancel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  setComfyPort: vi.fn(),
  setComfyHost: vi.fn(),
}))

const { ComfyUISettings } = await import('../SettingsPage')
const { COMFY_CANCEL_NOTICE, useComfyInstallStore } = await import('../../../stores/comfyInstallStore')

/** What `install_comfyui_status` answers next. */
let installStatus: { status: string; logs: string[] } = { status: 'installing', logs: ['pip install torch'] }

beforeEach(() => {
  // The run outlives the mount now, so it also outlives a test.
  useComfyInstallStore.getState().reset()
  installStatus = { status: 'installing', logs: ['pip install torch'] }
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfyui_status') return { running: false, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true }
    if (cmd === 'install_comfyui_status') return installStatus
    if (cmd === 'repair_comfyui_env') return { status: 'installing' }
    if (cmd === 'cancel_comfyui_install') return { status: 'cancelling' }
    return {}
  })
})
afterEach(() => { cleanup(); useComfyInstallStore.getState().reset(); vi.useRealTimers() })

/** Mount the panel and get past the "Checking..." first status read. */
async function mountPanel() {
  render(createElement(ComfyUISettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

/** Let the 2 s status poll fire `times` times. */
async function poll(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  }
}

describe('cancelling a repair from Settings', () => {
  it('offers Cancel while the repair runs, and not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    expect(screen.queryByText('Cancel')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    expect(screen.getByText(/Rebuilding the ComfyUI environment/)).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('tells Rust to cancel, locks the button and says it is cancelling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    await act(async () => { fireEvent.click(screen.getByText('Cancel')) })

    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'cancel_comfyui_install')).toBe(true)
    const button = screen.getByRole('button', { name: 'Cancelling…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    // The line above the button says the same thing, so the state is readable
    // without hunting for a greyed-out button.
    expect(screen.getAllByText('Cancelling…').length).toBe(2)

    // A second click must not fire a second cancel.
    const before = backendCall.mock.calls.filter(([cmd]) => cmd === 'cancel_comfyui_install').length
    await act(async () => { fireEvent.click(button) })
    expect(backendCall.mock.calls.filter(([cmd]) => cmd === 'cancel_comfyui_install').length).toBe(before)
  })

  it('leaves a sentence behind once the run really stopped, not an error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    await act(async () => { fireEvent.click(screen.getByText('Cancel')) })

    installStatus = { status: 'cancelled', logs: ['Repair cancelled during the PyTorch download.'] }
    await poll(1)

    expect(screen.getByText(COMFY_CANCEL_NOTICE.repair)).toBeTruthy()
    // Cancelled is not a failure: the panel goes back to idle and offers the
    // repair again instead of showing "did not finish".
    expect(screen.queryByText(/did not finish/)).toBeNull()
    expect(screen.getByText('Repair environment')).toBeTruthy()
    expect(screen.queryAllByText('Cancelling…').length).toBe(0)
  })
})
