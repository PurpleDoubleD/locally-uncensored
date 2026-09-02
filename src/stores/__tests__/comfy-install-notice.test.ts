/**
 * A15, Windows Nachlauf 02.09., Befund 5b: a ComfyUI requirements.txt with an
 * invented package on line 1 made `pip install -r` fail, the repair carried on
 * with LU's own package list, and the run ended after 377 seconds on a green
 * panel. No error card, no hint, nothing in the log about the file that had
 * been passed over, so the user is left with a ComfyUI that is quietly short of
 * whatever that file asked for.
 *
 * Rust now sends one closing line with the finished run. The panel already had
 * a place for such a line (the cancel notice); this proves the line survives
 * the moment the run goes idle, and that a clean run still leaves none.
 *
 * Run: npx vitest run src/stores/__tests__/comfy-install-notice.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
}))

const { useComfyInstallStore } = await import('../comfyInstallStore')

const store = () => useComfyInstallStore.getState()

const SKIPPED =
  "The requirements.txt in C:\\Users\\ddrob\\ComfyUI could not be used (pip found no " +
  'installable version for a package it names), so LU installed its own package list ' +
  'instead. Anything that file asks for on top of that list is not installed.'

beforeEach(() => {
  store().reset()
  backendCall.mockReset()
})
afterEach(() => { store().reset(); vi.useRealTimers() })

async function repairThatEndsWith(payload: Record<string, unknown>) {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'repair_comfyui_env') return { status: 'installing' }
    if (cmd === 'install_comfyui_status') return payload
    return {}
  })
  await store().runRepair()
  await vi.advanceTimersByTimeAsync(2100)
}

describe('a repair that had to skip the requirements.txt says so at the end', () => {
  it('keeps the closing line after the panel goes idle', async () => {
    await repairThatEndsWith({
      status: 'complete',
      logs: ['Environment repaired. ComfyUI now runs from its own venv; start it again.'],
      notice: SKIPPED,
    })
    expect(store().phase).toBe('idle')
    // The panel renders `notice` exactly while the phase is idle, so this is
    // the line the user is left looking at.
    expect(store().notice).toBe(SKIPPED)
    expect(store().notice).toContain('C:\\Users\\ddrob\\ComfyUI')
    expect(store().notice).toContain('is not installed')
  })

  it('leaves no line behind when the run used the file it found', async () => {
    await repairThatEndsWith({
      status: 'complete',
      logs: ['Dependencies installed.', 'All packages import cleanly.'],
      notice: '',
    })
    expect(store().phase).toBe('idle')
    expect(store().notice).toBe('')
  })

  it('leaves no line behind when the backend sends none at all', async () => {
    // An older backend, or any run that simply has nothing to add.
    await repairThatEndsWith({ status: 'complete', logs: ['done'] })
    expect(store().phase).toBe('idle')
    expect(store().notice).toBe('')
  })

  it('does not let a stale notice outlive the run it belonged to', async () => {
    await repairThatEndsWith({ status: 'complete', logs: ['x'], notice: SKIPPED })
    expect(store().notice).toBe(SKIPPED)
    vi.useRealTimers()
    backendCall.mockReset()
    await repairThatEndsWith({ status: 'complete', logs: ['y'], notice: '' })
    expect(store().notice).toBe('')
  })
})
