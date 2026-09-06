/**
 * The download tray's window into the Rust MLX install slots (2026-07-31)
 *
 * David: a 2.6 GB model pull showed only a spinning "Installing…" button; the
 * titlebar download tray never listed it. This store is the tray's view of the
 * four Rust install slots. These tests pin the lifecycle: watch() follows a
 * slot to its terminal state and stops polling, 'idle' means the app restarted
 * under us (entry dismissed), a failed poll is transient and must not kill the
 * watch, and adopt() picks up exactly the installs nobody is watching.
 *
 * Run: npx vitest run src/stores/__tests__/mlxInstallStore.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getMlxImageEngineStatus = vi.fn()
const getMlxImageInstallStatus = vi.fn()
const getMlxInstallStatus = vi.fn()
const getModelInstallStatus = vi.fn()

vi.mock('../../api/mlx-image', () => ({
  getMlxImageEngineStatus: (...a: unknown[]) => getMlxImageEngineStatus(...(a as [])),
  getMlxImageInstallStatus: (...a: unknown[]) => getMlxImageInstallStatus(...(a as [])),
}))
vi.mock('../../api/mlx-video', () => ({
  getMlxInstallStatus: (...a: unknown[]) => getMlxInstallStatus(...(a as [])),
  getModelInstallStatus: (...a: unknown[]) => getModelInstallStatus(...(a as [])),
}))

import { useMlxInstallStore } from '../mlxInstallStore'

function slot(over: Record<string, unknown> = {}) {
  return {
    status: 'installing',
    logs: [] as string[],
    error: null,
    download_progress: 0,
    download_total: 0,
    download_speed: 0,
    ...over,
  }
}

// The immediate tick in watch() is pure microtasks, no timer advance needed.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const entries = () => useMlxInstallStore.getState().entries

describe('mlxInstallStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useMlxInstallStore.setState({ entries: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows an install to complete and stops polling', async () => {
    getMlxImageInstallStatus
      .mockResolvedValueOnce(
        slot({ download_progress: 500, download_total: 1000, download_speed: 42, logs: ['pulling weights'] }),
      )
      .mockResolvedValueOnce(slot({ status: 'complete', download_progress: 1000, download_total: 1000 }))

    useMlxInstallStore.getState().watch('image-model', 'SD Turbo')
    expect(entries()['image-model']).toMatchObject({ status: 'installing', label: 'SD Turbo' })

    await flush()
    expect(entries()['image-model']).toMatchObject({
      progress: 500,
      total: 1000,
      speed: 42,
      lastLog: 'pulling weights',
    })

    await vi.advanceTimersByTimeAsync(1200)
    expect(entries()['image-model']).toMatchObject({ status: 'complete', progress: 1000 })

    const calls = getMlxImageInstallStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(getMlxImageInstallStatus.mock.calls.length).toBe(calls)
  })

  it('keeps an errored install visible with its cause and stops polling', async () => {
    getModelInstallStatus.mockResolvedValueOnce(slot({ status: 'error', error: 'disk full' }))

    useMlxInstallStore.getState().watch('video-model', 'Wan 2.1')
    await flush()

    expect(entries()['video-model']).toMatchObject({ status: 'error', error: 'disk full' })

    const calls = getModelInstallStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(getModelInstallStatus.mock.calls.length).toBe(calls)
  })

  it('dismisses the entry when the slot reads idle (app restarted under us)', async () => {
    getMlxInstallStatus.mockResolvedValueOnce(slot({ status: 'idle' }))

    useMlxInstallStore.getState().watch('video-engine', 'MLX video engine')
    expect(entries()['video-engine']).toBeDefined()

    await flush()
    expect(entries()['video-engine']).toBeUndefined()

    const calls = getMlxInstallStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(getMlxInstallStatus.mock.calls.length).toBe(calls)
  })

  it('treats a failed poll as transient and keeps watching', async () => {
    getMlxImageEngineStatus
      .mockRejectedValueOnce(new Error('slot busy'))
      .mockResolvedValueOnce(slot({ status: 'complete' }))

    useMlxInstallStore.getState().watch('image-engine', 'MLX image engine')
    await flush()

    // The failed read left the seeded entry alone…
    expect(entries()['image-engine']).toMatchObject({ status: 'installing', progress: 0 })

    // …and the next interval tick still ran and saw the terminal state.
    await vi.advanceTimersByTimeAsync(1200)
    expect(entries()['image-engine']).toMatchObject({ status: 'complete' })
  })

  it('adopt() watches only slots that are mid-install', async () => {
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    getMlxImageInstallStatus
      .mockResolvedValueOnce(slot()) // adopt's probe
      .mockResolvedValueOnce(slot({ download_progress: 1, download_total: 2 })) // watch's immediate tick
      .mockResolvedValueOnce(slot({ status: 'complete' }))
    getMlxInstallStatus.mockRejectedValue(new Error('400 not this platform'))
    getModelInstallStatus.mockResolvedValue(slot({ status: 'complete' }))

    await useMlxInstallStore.getState().adopt()
    await flush()

    expect(Object.keys(entries())).toEqual(['image-model'])
    expect(entries()['image-model']).toMatchObject({ label: 'Image model', progress: 1, total: 2 })

    await vi.advanceTimersByTimeAsync(1200)
    expect(entries()['image-model']).toMatchObject({ status: 'complete' })
  })

  it('dismiss() removes an entry', async () => {
    getModelInstallStatus.mockResolvedValueOnce(slot({ status: 'complete' }))
    useMlxInstallStore.getState().watch('video-model', 'Wan 2.1')
    await flush()

    useMlxInstallStore.getState().dismiss('video-model')
    expect(entries()['video-model']).toBeUndefined()
  })
})
