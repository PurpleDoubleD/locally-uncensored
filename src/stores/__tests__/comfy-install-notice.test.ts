/**
 * A15, Windows Nachlauf 02.09., Befund 5b: a ComfyUI requirements.txt with an
 * invented package on line 1 made `pip install -r` fail, the repair carried on
 * with the packages LU knows about, and the run ended after 377 seconds on a green
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
  'installable version for a package it names), so LU checked the packages it knows ' +
  'about and installed the ones that were missing. Anything that file asks for on top ' +
  'of that list is not installed.'

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

  it('carries only what the backend sent, and nothing of its own', async () => {
    // Negative control on the wiring: the store does not invent a line, it
    // relays one. A backend that sends an empty notice leaves the panel bare.
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

describe('the ComfyUI section opens itself while a run is on screen', () => {
  it('opens for every phase that is not idle, and stays shut for an empty idle', async () => {
    const { comfySectionShouldOpen } = await import('../comfyInstallStore')
    for (const phase of ['checking', 'python', 'comfyui', 'repair', 'error'] as const) {
      expect(comfySectionShouldOpen({ phase, notice: '' })).toBe(true)
    }
    // Negative control: a settings page with nothing running and nothing to
    // report must not force the section open, or the accordion would be no
    // accordion at all.
    expect(comfySectionShouldOpen({ phase: 'idle', notice: '' })).toBe(false)
  })

  it('opens for the closing line a finished run left behind', async () => {
    // Review 03.09.: the panel renders the closing line only while the phase is
    // idle, so asking about the phase alone folded the section shut in exactly
    // the one state the line exists in. An eight minute repair then reported
    // its result to nobody.
    const { comfySectionShouldOpen } = await import('../comfyInstallStore')
    expect(comfySectionShouldOpen({ phase: 'idle', notice: 'Repair finished. ComfyUI is ready.' }))
      .toBe(true)
    expect(comfySectionShouldOpen({ phase: 'idle', notice: SKIPPED })).toBe(true)
  })
})

describe('a run that simply worked still says so', () => {
  it('keeps the closing line of a clean repair, and does not dress it as a warning', async () => {
    await repairThatEndsWith({
      status: 'complete',
      logs: ['All packages import cleanly.'],
      notice: 'Repair finished. ComfyUI is ready.',
      notice_kind: 'ok',
    })
    expect(store().phase).toBe('idle')
    expect(store().notice).toBe('Repair finished. ComfyUI is ready.')
    expect(store().noticeKind).toBe('ok')
    const { comfySectionShouldOpen } = await import('../comfyInstallStore')
    expect(comfySectionShouldOpen(store())).toBe(true)
  })

  it('marks the line as a warning when the run had to skip the file', async () => {
    // Negative control for the test above: the colour is not a constant.
    await repairThatEndsWith({ status: 'complete', logs: ['x'], notice: SKIPPED, notice_kind: 'warn' })
    expect(store().noticeKind).toBe('warn')
  })

  it('treats a cancelled run as a warning, whoever asked for it', async () => {
    // A half rebuilt venv is not good news, and the backend sends no kind for
    // a cancel: the store decides that one.
    await repairThatEndsWith({ status: 'cancelled', logs: ['stopped'] })
    expect(store().phase).toBe('idle')
    expect(store().noticeKind).toBe('warn')
    expect(store().notice).toContain('Repair cancelled')
  })

  it('falls back to ok for a backend that names no kind', async () => {
    await repairThatEndsWith({ status: 'complete', logs: ['x'], notice: 'Repair finished.' })
    expect(store().noticeKind).toBe('ok')
  })
})

describe('the closing line can be put away', () => {
  it('clears the line and lets the section fold up again', async () => {
    const { comfySectionShouldOpen } = await import('../comfyInstallStore')
    await repairThatEndsWith({
      status: 'complete',
      logs: ['x'],
      notice: 'Repair finished. ComfyUI is ready.',
      notice_kind: 'ok',
    })
    expect(comfySectionShouldOpen(store())).toBe(true)

    store().clearNotice()
    expect(store().notice).toBe('')
    expect(store().noticeKind).toBe('ok')
    // The point of the dismiss: without it one finished run kept the section
    // unfolding itself on every visit for the rest of the session.
    expect(comfySectionShouldOpen(store())).toBe(false)
  })

  it('leaves everything else alone', async () => {
    // Negative control: dismissing a message is not a reset.
    await repairThatEndsWith({ status: 'complete', logs: ['a', 'b'], notice: SKIPPED, notice_kind: 'warn' })
    store().clearNotice()
    expect(store().logs).toEqual(['a', 'b'])
    expect(store().phase).toBe('idle')
  })
})
