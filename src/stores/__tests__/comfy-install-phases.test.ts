/**
 * Review 2026-09-02, two findings on the run itself.
 *
 * 1. `runInstall` set the phase to `python` before `python_check` had
 *    answered, so a box that already has Python showed "Installing Python 3.12
 *    (~30 MB)" for an install that never happened.
 * 2. The status poll swallowed every failure and retried forever. If
 *    `install_comfyui_status` stopped answering for good, the panel spun on a
 *    spinner with no end and no word.
 *
 * Run: npx vitest run src/stores/__tests__/comfy-install-phases.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
}))

const { useComfyInstallStore, comfyInstallPolling, LOST_CONTACT, LOST_CONTACT_PYTHON } =
  await import('../comfyInstallStore')

const store = () => useComfyInstallStore.getState()

beforeEach(() => {
  store().reset()
  backendCall.mockReset()
})
afterEach(() => { store().reset(); vi.useRealTimers() })

describe('the Python probe is not a Python install', () => {
  it('says it is checking while the probe runs, and never claims an install', async () => {
    let answerProbe: (v: unknown) => void = () => {}
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'python_check') return new Promise((resolve) => { answerProbe = resolve })
      return {}
    })
    const running = store().runInstall('')
    await Promise.resolve()
    expect(store().phase).toBe('checking')
    expect(store().logs.join(' ')).not.toContain('Installing Python')

    // Python is there, so the winget step is skipped entirely.
    answerProbe({ available: true })
    await running
    expect(store().phase).toBe('comfyui')
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'install_python')).toBe(false)
  })

  it('still goes through the python phase on a box without one', async () => {
    const seen: string[] = []
    const unsub = useComfyInstallStore.subscribe((s) => { if (seen[seen.length - 1] !== s.phase) seen.push(s.phase) })
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'python_check') return { available: false }
      if (cmd === 'install_python_status') return { status: 'complete', logs: ['done'] }
      return {}
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const running = store().runInstall('')
    await vi.advanceTimersByTimeAsync(2000)
    await running
    unsub()
    expect(seen).toContain('checking')
    expect(seen).toContain('python')
    expect(store().phase).toBe('comfyui')
  })
})

describe('a poll that never gets an answer gives up and says so', () => {
  async function repairWithBrokenStatus(ticks: number) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'repair_comfyui_env') return { status: 'installing' }
      if (cmd === 'install_comfyui_status') throw new Error('IPC is gone')
      return {}
    })
    await store().runRepair()
    await vi.advanceTimersByTimeAsync(2000 * ticks)
  }

  it('keeps trying through a long run of failures', async () => {
    await repairWithBrokenStatus(29)
    expect(comfyInstallPolling()).toBe(true)
    expect(store().phase).toBe('repair')
  })

  it('stops after the cap and names what happened', async () => {
    await repairWithBrokenStatus(30)
    expect(comfyInstallPolling()).toBe(false)
    expect(store().phase).toBe('error')
    expect(store().error).toBe(LOST_CONTACT)
  })

  it('forgets the failures as soon as one answer arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let broken = true
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'repair_comfyui_env') return { status: 'installing' }
      if (cmd === 'install_comfyui_status') {
        if (broken) throw new Error('IPC is gone')
        return { status: 'installing', logs: ['pip install torch'] }
      }
      return {}
    })
    await store().runRepair()
    await vi.advanceTimersByTimeAsync(2000 * 29)
    broken = false
    await vi.advanceTimersByTimeAsync(2000)
    broken = true
    // 29 more failures must not trip the cap, the counter started over.
    await vi.advanceTimersByTimeAsync(2000 * 29)
    expect(comfyInstallPolling()).toBe(true)
    expect(store().phase).toBe('repair')
  })
})

/**
 * Review 2026-09-02, second round: the Python status loop had no cap of its
 * own. Its catch only returned, so the promise `runInstall` awaits never
 * settled: the run hung in phase `python` for ever, with no Cancel, no
 * Dismiss and no buttons, because every one of those hangs on a phase that
 * never came.
 */
describe('the Python status loop gives up too', () => {
  async function installWithBrokenPythonStatus(ticks: number) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'python_check') return { available: false }
      if (cmd === 'install_python') return {}
      if (cmd === 'install_python_status') throw new Error('IPC is gone')
      return {}
    })
    // Wrapped, so `await` on this helper cannot chain onto a run that is
    // meant to still be in flight.
    const running = store().runInstall('')
    await vi.advanceTimersByTimeAsync(2000 * ticks)
    return { running }
  }

  it('keeps waiting through a long run of failures', async () => {
    await installWithBrokenPythonStatus(29)
    expect(store().phase).toBe('python')
    expect(comfyInstallPolling()).toBe(true)
  })

  it('settles the run instead of hanging in phase python for ever', async () => {
    const { running } = await installWithBrokenPythonStatus(30)
    // The promise really resolves: without the cap this await never returns.
    await running
    expect(store().phase).toBe('error')
    expect(store().error).toBe(LOST_CONTACT_PYTHON)
    expect(comfyInstallPolling()).toBe(false)
    // And it never went on to install ComfyUI on a box with no Python.
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'install_comfyui')).toBe(false)
  })

  it('forgets the failures as soon as one answer arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let broken = true
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'python_check') return { available: false }
      if (cmd === 'install_python') return {}
      if (cmd === 'install_python_status') {
        if (broken) throw new Error('IPC is gone')
        return { status: 'installing', logs: ['winget is working'] }
      }
      return {}
    })
    const running = store().runInstall('')
    await vi.advanceTimersByTimeAsync(2000 * 29)
    broken = false
    await vi.advanceTimersByTimeAsync(2000)
    broken = true
    await vi.advanceTimersByTimeAsync(2000 * 29)
    expect(store().phase).toBe('python')
    expect(comfyInstallPolling()).toBe(true)
    // Let the run finish so no timer outlives the test.
    broken = false
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_python_status') return { status: 'complete', logs: ['done'] }
      return {}
    })
    await vi.advanceTimersByTimeAsync(2000)
    await running
  })
})

/**
 * A status read that was already on the wire when the run ended still resolves
 * afterwards. Without a generation on each tick it wrote its answer into a run
 * that is over: a dismissed failure coming back on its own, or a fresh run
 * wearing the previous one's log lines.
 */
describe('a late answer from a finished run is ignored', () => {
  it('does not resurrect a dismissed failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let answer: (v: unknown) => void = () => {}
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'repair_comfyui_env') return { status: 'installing' }
      if (cmd === 'install_comfyui_status') return new Promise((resolve) => { answer = resolve })
      return {}
    })
    await store().runRepair()
    await vi.advanceTimersByTimeAsync(2000)

    // The user presses Dismiss while that read is still on the wire.
    store().reset()
    answer({ status: 'error', logs: ['ERROR: pip could not build wheels'] })
    await vi.advanceTimersByTimeAsync(10)

    expect(store().phase).toBe('idle')
    expect(store().error).toBe('')
    expect(store().logs).toEqual([])
    expect(comfyInstallPolling()).toBe(false)
  })
})
