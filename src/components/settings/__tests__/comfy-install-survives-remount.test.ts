/**
 * @vitest-environment jsdom
 *
 * A13, Windows counter-check 2026-09-02, side finding on the repair run:
 * "wer waehrend des Repairs den Einstellungsbereich wechselt, verliert den
 * Fortschrittstext; beim Zurueckkommen steht dort nichts mehr, obwohl pip
 * weiterlaeuft".
 *
 * The run was never in the component. What was in the component was the phase,
 * the log lines and the byte counters, so leaving the section threw away every
 * word about a twenty minute, two gigabyte rebuild that kept going in Rust.
 *
 * This mounts the panel, starts a repair, unmounts it the way the settings
 * navigation does, lets the poll tick while nothing is on screen, and mounts it
 * again.
 *
 * Run: npx vitest run src/components/settings/__tests__/comfy-install-survives-remount.test.ts
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
const { useComfyInstallStore, comfyInstallPolling } = await import('../../../stores/comfyInstallStore')

let installStatus: { status: string; logs: string[]; download_progress?: number; download_total?: number } =
  { status: 'installing', logs: ['Step 1/4: Creating a fresh isolated venv...'] }

beforeEach(() => {
  useComfyInstallStore.getState().reset()
  installStatus = { status: 'installing', logs: ['Step 1/4: Creating a fresh isolated venv...'] }
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfyui_status') return { running: false, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true }
    if (cmd === 'install_comfyui_status') return installStatus
    if (cmd === 'repair_comfyui_env') return { status: 'installing' }
    return {}
  })
})
afterEach(() => { cleanup(); useComfyInstallStore.getState().reset(); vi.useRealTimers() })

async function mountPanel() {
  const view = render(createElement(ComfyUISettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return view
}

describe('a repair started in Settings survives leaving the section', () => {
  it('shows the same phase and the newest log line after a remount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const first = await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    expect(screen.getByText(/Rebuilding the ComfyUI environment/)).toBeTruthy()

    // The user opens Providers: this panel goes away entirely.
    first.unmount()

    // pip does not care. Two more ticks arrive with nothing on screen.
    installStatus = {
      status: 'installing',
      logs: ['Step 2/4: Downloading PyTorch into the fresh venv (~2 GB).'],
      download_progress: 500_000_000,
      download_total: 2_000_000_000,
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(comfyInstallPolling()).toBe(true)

    // Back to AI Backends.
    await mountPanel()
    expect(screen.getByText(/Rebuilding the ComfyUI environment/)).toBeTruthy()
    expect(screen.getByText('Step 2/4: Downloading PyTorch into the fresh venv (~2 GB).')).toBeTruthy()
    // The download counters came along too, they are part of that line.
    expect(screen.getByText(/of 1.9 GB/)).toBeTruthy()
  })

  it('lets the remounted panel finish the run and stop the poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const first = await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    first.unmount()

    installStatus = { status: 'complete', logs: ['Environment repaired.'] }
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(comfyInstallPolling()).toBe(false)

    await mountPanel()
    expect(screen.getByText('Repair environment')).toBeTruthy()
    expect(screen.queryByText(/Rebuilding the ComfyUI environment/)).toBeNull()
  })

  it('starts no second poll when the panel is mounted twice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const first = await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    const before = backendCall.mock.calls.filter(([cmd]) => cmd === 'install_comfyui_status').length
    first.unmount()
    await mountPanel()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    // One tick, one status read. A poll per mount would double this.
    expect(backendCall.mock.calls.filter(([cmd]) => cmd === 'install_comfyui_status').length).toBe(before + 1)
  })
})

/**
 * Review 2026-09-02 (blocker): with the state outliving the mount, `error`
 * outlives it too. The three start buttons hung on `phase === 'idle'` and
 * nothing but a fresh run cleared the phase, so a failed install or repair was
 * a dead end until the app was restarted. Before the store, leaving the
 * section threw the failure away and the buttons came back.
 */
describe('a failed run stays escapable', () => {
  it('offers Repair environment again after a failure, across a remount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const first = await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })

    installStatus = { status: 'error', logs: ['ERROR: pip could not build wheels'] }
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText('Install failed')).toBeTruthy()

    // The user leaves for Providers and comes back, the old escape hatch.
    first.unmount()
    await mountPanel()

    expect(screen.getByText('Install failed')).toBeTruthy()
    const again = screen.getByText('Repair environment')
    expect((again as HTMLButtonElement).disabled).toBe(false)
    // And pressing it really starts a second run instead of doing nothing.
    await act(async () => { fireEvent.click(again) })
    expect(backendCall.mock.calls.filter(([cmd]) => cmd === 'repair_comfyui_env').length).toBe(2)
    expect(screen.queryByText('Install failed')).toBeNull()
  })

  it('clears the card on Dismiss without starting anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Repair environment')) })
    installStatus = { status: 'error', logs: ['ERROR: pip could not build wheels'] }
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    await act(async () => { fireEvent.click(screen.getByText('Dismiss')) })
    expect(screen.queryByText('Install failed')).toBeNull()
    expect(screen.queryByText(/pip could not build wheels/)).toBeNull()
    expect(backendCall.mock.calls.filter(([cmd]) => cmd === 'repair_comfyui_env').length).toBe(1)
    expect(comfyInstallPolling()).toBe(false)
  })
})
