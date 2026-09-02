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

const { useComfyInstallStore, comfyInstallPolling, LOST_CONTACT } = await import('../comfyInstallStore')

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
