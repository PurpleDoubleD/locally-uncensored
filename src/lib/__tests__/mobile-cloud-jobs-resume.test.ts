/**
 * Point 7 of the mobile groundwork: a booked cloud render survives the app.
 *
 * The id of a running job lived in a module variable. A phone that killed the
 * app during a video render lost the only handle on a result the customer had
 * paid for. Now the id is written down (lib/pending-cloud-jobs.ts) and asked
 * again after a start and after every return (lib/cloud-job-resume.ts).
 *
 * The desktop writes nothing down and asks nobody.
 *
 * Run: npx vitest run src/lib/__tests__/mobile-cloud-jobs-resume.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOPS, HANDHELDS, standOn } from '../../test-support/devices'

const backing = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() { return backing.size },
} as Storage
vi.stubGlobal('localStorage', localStorageShim)

const cloud = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    FakeCloudJobError,
    getJob: vi.fn(),
    pollJob: vi.fn(),
  }
})
vi.mock('../../api/cloud/jobs', () => ({
  getJob: cloud.getJob,
  pollJob: cloud.pollJob,
  CloudJobError: cloud.FakeCloudJobError,
}))
// Fall E7: the shelf is read again once the trained character is on it.
const shelf = vi.hoisted(() => ({ waitForTrainedLora: vi.fn(async () => null as unknown) }))
vi.mock('../../api/cloud/loras', () => ({ waitForTrainedLora: shelf.waitForTrainedLora }))

import { useCreateStore } from '../../stores/createStore'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import {
  PENDING_CLOUD_JOBS_KEY, PENDING_CLOUD_JOBS_CAP, __resetPendingCloudJobsForTests, forgetPendingCloudJob,
  isWatchedCloudJob, notePendingCloudJob, pendingCloudJobs, unwatchCloudJob,
} from '../pending-cloud-jobs'
import type { PendingCloudJob } from '../pending-cloud-jobs'
import {
  PENDING_MAX_AGE_MS, RESUME_MIN_WINDOW_MS, __resetCloudJobResumeForTests, onCloudJobsResumed,
  resumePendingCloudJobs,
} from '../cloud-job-resume'

function entry(id: string, extra: Partial<PendingCloudJob> = {}): PendingCloudJob {
  return {
    id, kind: 'image', op: 'generate', model: 'z-image-turbo', prompt: 'a lighthouse at dusk',
    startedAt: Date.now() - 60_000, deadlineAt: Date.now() + 14 * 60_000, landing: 'gallery',
    item: { seed: 4711, intent: 'image', width: 1024, height: 1024, prompt: 'a lighthouse at dusk' },
    ...extra,
  }
}
function finished(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'image', model: 'z-image-turbo', status: 'succeeded', error: null,
    result_url: `https://storage.example/${id}.png`, attestation: null, ...extra,
  }
}
/** What a kill leaves behind: the entries on disk, nobody watching. */
function afterAKill(...entries: PendingCloudJob[]) {
  for (const e of entries) {
    notePendingCloudJob(e)
    unwatchCloudJob(e.id)
  }
}

beforeEach(() => {
  backing.clear()
  vi.stubGlobal('localStorage', localStorageShim)
  cloud.getJob.mockReset()
  cloud.pollJob.mockReset()
  __resetPendingCloudJobsForTests()
  __resetCloudJobResumeForTests()
  useCreateStore.setState({ gallery: [], voiceFromJob: null, isGenerating: false, error: null, cloudImageModel: '' })
})
afterEach(() => {
  __resetCloudJobResumeForTests()
  vi.unstubAllGlobals()
})

describe('the ledger', () => {
  for (const device of HANDHELDS) {
    it(`${device}: a booked job is on disk with kind, model, prompt and start time`, () => {
      standOn(device)
      const e = entry('job-1')
      notePendingCloudJob(e)
      const stored = JSON.parse(backing.get(PENDING_CLOUD_JOBS_KEY)!)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ id: 'job-1', kind: 'image', model: 'z-image-turbo', prompt: 'a lighthouse at dusk', startedAt: e.startedAt })
      expect(pendingCloudJobs()).toHaveLength(1)
      // The run that booked it is its first watcher.
      expect(isWatchedCloudJob('job-1')).toBe(true)
    })
  }

  for (const device of DESKTOPS) {
    it(`DESKTOP UNCHANGED ${device}: nothing is written down`, () => {
      standOn(device)
      notePendingCloudJob(entry('job-1'))
      expect(backing.has(PENDING_CLOUD_JOBS_KEY)).toBe(false)
      expect(pendingCloudJobs()).toEqual([])
      expect(isWatchedCloudJob('job-1')).toBe(false)
    })
  }

  it('a job that ended leaves the ledger, and an empty ledger is written down as empty', () => {
    standOn('android')
    notePendingCloudJob(entry('job-1'))
    notePendingCloudJob(entry('job-2'))
    forgetPendingCloudJob('job-1')
    expect(pendingCloudJobs().map((e) => e.id)).toEqual(['job-2'])
    forgetPendingCloudJob('job-2')
    // `[]`, not a removed key: the backup must learn that the list is empty.
    expect(backing.get(PENDING_CLOUD_JOBS_KEY)).toBe('[]')
  })

  it('the same job noted twice is one entry, and the ledger has a cap', () => {
    standOn('iphone')
    notePendingCloudJob(entry('job-1'))
    notePendingCloudJob(entry('job-1'))
    expect(pendingCloudJobs()).toHaveLength(1)
    for (let i = 0; i < PENDING_CLOUD_JOBS_CAP + 5; i++) notePendingCloudJob(entry(`many-${i}`))
    expect(pendingCloudJobs()).toHaveLength(PENDING_CLOUD_JOBS_CAP)
    // The newest stay.
    expect(pendingCloudJobs().at(-1)!.id).toBe(`many-${PENDING_CLOUD_JOBS_CAP + 4}`)
  })

  it('a broken blob reads as an empty ledger', () => {
    standOn('iphone')
    backing.set(PENDING_CLOUD_JOBS_KEY, '{not json')
    expect(pendingCloudJobs()).toEqual([])
    backing.set(PENDING_CLOUD_JOBS_KEY, JSON.stringify([{ id: 7 }, null, 'x']))
    expect(pendingCloudJobs()).toEqual([])
  })
})

describe('after a kill, the result still lands', () => {
  it('a job that finished meanwhile is in the gallery with what the run knew', async () => {
    standOn('iphone')
    afterAKill(entry('job-1'))
    cloud.pollJob.mockResolvedValue(finished('job-1'))

    const summary = await resumePendingCloudJobs()

    expect(summary.landed).toEqual(['job-1'])
    const item = useCreateStore.getState().gallery.find((g) => g.jobId === 'job-1')!
    expect(item).toBeTruthy()
    expect(item.remoteUrl).toBe('https://storage.example/job-1.png')
    expect(item.prompt).toBe('a lighthouse at dusk')
    expect(item.seed).toBe(4711)
    expect(item.intent).toBe('image')
    expect(item.type).toBe('image')
    // Struck from the ledger: the next start asks nobody.
    expect(pendingCloudJobs()).toEqual([])
    // `[]`, not a removed key: the backup must learn that the list is empty.
    expect(backing.get(PENDING_CLOUD_JOBS_KEY)).toBe('[]')
  })

  it('a job that is still rendering is polled on, with what is left of its deadline', async () => {
    standOn('android')
    const e = entry('job-1', { deadlineAt: Date.now() + 10 * 60_000 })
    afterAKill(e)
    cloud.pollJob.mockResolvedValue(finished('job-1'))
    await resumePendingCloudJobs()
    const opts = cloud.pollJob.mock.calls[0][1] as { timeoutMs: number }
    expect(cloud.pollJob.mock.calls[0][0]).toBe('job-1')
    expect(opts.timeoutMs).toBeGreaterThan(9 * 60_000)
    expect(opts.timeoutMs).toBeLessThanOrEqual(10 * 60_000)
  })

  it('a deadline that already passed still gets a real window', async () => {
    standOn('android')
    afterAKill(entry('job-1', { deadlineAt: Date.now() - 5 * 60_000 }))
    cloud.pollJob.mockResolvedValue(finished('job-1'))
    await resumePendingCloudJobs()
    expect((cloud.pollJob.mock.calls[0][1] as { timeoutMs: number }).timeoutMs).toBe(RESUME_MIN_WINDOW_MS)
  })

  it('a result from the last session does not move the model picker', async () => {
    standOn('iphone')
    useCreateStore.setState({ backend: 'cloud', cloudImageModel: 'flux-dev' })
    afterAKill(entry('job-1', { item: { model: 'flux-schnell' } }))
    cloud.pollJob.mockResolvedValue(finished('job-1', { model: 'flux-schnell' }))
    await resumePendingCloudJobs()
    expect(useCreateStore.getState().gallery).toHaveLength(1)
    expect(useCreateStore.getState().cloudImageModel).toBe('flux-dev')
  })

  it('landing twice is one gallery item', async () => {
    standOn('iphone')
    afterAKill(entry('job-1'))
    cloud.pollJob.mockResolvedValue(finished('job-1'))
    await resumePendingCloudJobs()
    afterAKill(entry('job-1'))
    await resumePendingCloudJobs()
    expect(useCreateStore.getState().gallery.filter((g) => g.jobId === 'job-1')).toHaveLength(1)
  })

  it('a trained character refreshes the shelf instead of the gallery', async () => {
    standOn('iphone')
    const before = useCreateStore.getState().charactersVersion
    afterAKill(entry('train-1', { op: 'lora-train', landing: 'character' }))
    cloud.pollJob.mockResolvedValue(finished('train-1', { result_url: null }))
    const summary = await resumePendingCloudJobs()
    expect(summary.landed).toEqual(['train-1'])
    expect(useCreateStore.getState().charactersVersion).toBe(before + 1)
    expect(useCreateStore.getState().gallery).toEqual([])
  })

  it('a trained character that reaches the shelf late refreshes it once more (Fall E7)', async () => {
    standOn('iphone')
    shelf.waitForTrainedLora.mockResolvedValueOnce([{ id: 'c1' }])
    const before = useCreateStore.getState().charactersVersion
    afterAKill(entry('train-2', { op: 'lora-train', landing: 'character' }))
    cloud.pollJob.mockResolvedValue(finished('train-2', { result_url: null, completed_at: '2026-11-07T23:48:21.651Z' }))
    await resumePendingCloudJobs()
    await vi.waitFor(() => expect(useCreateStore.getState().charactersVersion).toBe(before + 2))
    expect(shelf.waitForTrainedLora).toHaveBeenCalledWith(expect.objectContaining({ id: 'train-2' }))
  })

  it('a finished voice is in the gallery and picked for the talking character', async () => {
    standOn('iphone')
    afterAKill(entry('voice-1', { kind: 'audio', op: 'tts', landing: 'voice', prompt: 'Hello there', item: { prompt: 'Hello there', intent: 'lipsync' } }))
    cloud.pollJob.mockResolvedValue(finished('voice-1', { kind: 'audio' }))
    await resumePendingCloudJobs()
    expect(useCreateStore.getState().gallery[0]).toMatchObject({ jobId: 'voice-1', type: 'audio', intent: 'lipsync' })
    expect(useCreateStore.getState().voiceFromJob).toEqual({ jobId: 'voice-1', label: 'Hello there' })
  })
})

describe('what does not land', () => {
  it('a job the server failed is reported with its sentence and struck', async () => {
    standOn('iphone')
    afterAKill(entry('job-1'))
    cloud.pollJob.mockResolvedValue(finished('job-1', { status: 'failed', result_url: null, error: 'The provider refused this prompt.' }))
    const heard = vi.fn()
    onCloudJobsResumed(heard)
    const summary = await resumePendingCloudJobs()
    expect(summary.failed).toEqual([{ id: 'job-1', error: 'The provider refused this prompt.' }])
    expect(heard).toHaveBeenCalledTimes(1)
    expect(pendingCloudJobs()).toEqual([])
    expect(useCreateStore.getState().gallery).toEqual([])
  })

  it('a cancelled job and a job the server does not know are dropped', async () => {
    standOn('iphone')
    afterAKill(entry('gone-1'), entry('cancelled-1'))
    cloud.pollJob.mockImplementation(async (id: string) => {
      if (id === 'gone-1') throw new cloud.FakeCloudJobError('job not found', 404)
      return finished(id, { status: 'canceled', result_url: null })
    })
    const summary = await resumePendingCloudJobs()
    expect(summary.dropped.sort()).toEqual(['cancelled-1', 'gone-1'])
    expect(pendingCloudJobs()).toEqual([])
  })

  it('a dead line keeps the job for the next look', async () => {
    standOn('iphone')
    afterAKill(entry('job-1'))
    cloud.pollJob.mockRejectedValue(new cloud.FakeCloudJobError('Could not reach the LU Cloud server.', 0))
    const heard = vi.fn()
    onCloudJobsResumed(heard)
    const summary = await resumePendingCloudJobs()
    expect(summary.waiting).toEqual(['job-1'])
    expect(pendingCloudJobs().map((e) => e.id)).toEqual(['job-1'])
    expect(isWatchedCloudJob('job-1')).toBe(false)
    // Nothing changed, so nobody is told.
    expect(heard).not.toHaveBeenCalled()
  })

  it('a signed-out phone (401) keeps the job too', async () => {
    standOn('iphone')
    afterAKill(entry('job-1'))
    cloud.pollJob.mockRejectedValue(new cloud.FakeCloudJobError('not signed in', 401))
    expect((await resumePendingCloudJobs()).waiting).toEqual(['job-1'])
    expect(pendingCloudJobs()).toHaveLength(1)
  })

  it('an entry older than two days is asked once and then let go', async () => {
    standOn('iphone')
    afterAKill(
      entry('old-done', { startedAt: Date.now() - PENDING_MAX_AGE_MS - 1 }),
      entry('old-stuck', { startedAt: Date.now() - PENDING_MAX_AGE_MS - 1 }),
    )
    cloud.getJob.mockImplementation(async (id: string) =>
      id === 'old-done' ? finished(id) : finished(id, { status: 'running', result_url: null }))
    const summary = await resumePendingCloudJobs()
    expect(cloud.pollJob).not.toHaveBeenCalled()
    expect(cloud.getJob).toHaveBeenCalledTimes(2)
    expect(summary.landed).toEqual(['old-done'])
    expect(summary.dropped).toEqual(['old-stuck'])
    expect(pendingCloudJobs()).toEqual([])
  })
})

// Review N8: signed out or offline the loop asked for up to two days.
describe('nobody to ask', () => {
  function withWindow(onLine: boolean) {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    vi.stubGlobal('navigator', { ...navigator, onLine })
    return {
      setOnline(next: boolean) {
        vi.stubGlobal('navigator', { ...navigator, onLine: next })
        if (next) target.dispatchEvent(new Event('online'))
      },
    }
  }
  beforeEach(() => { useCloudAuthStore.setState({ status: 'probing', user: null }) })
  afterEach(() => { vi.useRealTimers(); useCloudAuthStore.setState({ status: 'probing', user: null }) })

  it('a 401 stops the minute timer: nothing is asked again until somebody signs in', async () => {
    standOn('iphone')
    vi.useFakeTimers()
    afterAKill(entry('job-1'))
    cloud.pollJob.mockRejectedValueOnce(new cloud.FakeCloudJobError('not signed in', 401))
    cloud.pollJob.mockResolvedValueOnce(finished('job-1'))
    expect((await resumePendingCloudJobs()).waiting).toEqual(['job-1'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)
    expect(pendingCloudJobs()).toHaveLength(1)

    // Another change of the account that is not a sign-in asks nobody.
    useCloudAuthStore.setState({ status: 'signed-out' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)

    useCloudAuthStore.setState({ status: 'signed-in' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(2)
    expect(useCreateStore.getState().gallery).toHaveLength(1)
    expect(pendingCloudJobs()).toEqual([])
  })

  it('a phone that is known to be signed out asks nobody at all, and keeps the job', async () => {
    standOn('android')
    vi.useFakeTimers()
    useCloudAuthStore.setState({ status: 'signed-out' })
    afterAKill(entry('job-1'))
    cloud.pollJob.mockResolvedValue(finished('job-1'))
    expect((await resumePendingCloudJobs()).waiting).toEqual(['job-1'])
    expect((await resumePendingCloudJobs()).waiting).toEqual(['job-1'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(cloud.pollJob).not.toHaveBeenCalled()
    expect(cloud.getJob).not.toHaveBeenCalled()
    expect(isWatchedCloudJob('job-1')).toBe(false)

    useCloudAuthStore.setState({ status: 'signed-in' })
    await vi.advanceTimersByTimeAsync(1_000)
    // One listener, although it was asked for twice: one pass.
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)
    expect(useCreateStore.getState().gallery).toHaveLength(1)
  })

  it('without a network nobody is asked, and the network coming back starts the look', async () => {
    standOn('iphone')
    vi.useFakeTimers()
    const net = withWindow(false)
    afterAKill(entry('job-1'))
    cloud.pollJob.mockResolvedValue(finished('job-1'))
    expect((await resumePendingCloudJobs()).waiting).toEqual(['job-1'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(cloud.pollJob).not.toHaveBeenCalled()

    net.setOnline(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)
    expect(useCreateStore.getState().gallery).toHaveLength(1)
    // The listener is gone: a second event starts nothing (and there is nothing left to ask for).
    net.setOnline(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)
  })

  it('a line that dropped during the pass waits for the network instead of the timer', async () => {
    standOn('iphone')
    vi.useFakeTimers()
    const net = withWindow(true)
    afterAKill(entry('job-1'))
    cloud.pollJob.mockImplementationOnce(async () => {
      net.setOnline(false)
      throw new cloud.FakeCloudJobError('Could not reach the LU Cloud server.', 0)
    })
    cloud.pollJob.mockResolvedValueOnce(finished('job-1'))
    expect((await resumePendingCloudJobs()).waiting).toEqual(['job-1'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)
    net.setOnline(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(2)
  })

  it('a job that is merely still rendering keeps the minute timer', async () => {
    standOn('iphone')
    vi.useFakeTimers()
    withWindow(true)
    useCloudAuthStore.setState({ status: 'signed-in' })
    afterAKill(entry('job-1'))
    cloud.pollJob.mockRejectedValueOnce(new cloud.FakeCloudJobError('render timed out', 0))
    cloud.pollJob.mockResolvedValueOnce(finished('job-1'))
    await resumePendingCloudJobs()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cloud.pollJob).toHaveBeenCalledTimes(2)
  })
})

describe('one watcher per job', () => {
  it('a job the live run is still polling is left to it', async () => {
    standOn('iphone')
    notePendingCloudJob(entry('live-1')) // noted by the run, which watches it
    const summary = await resumePendingCloudJobs()
    expect(cloud.pollJob).not.toHaveBeenCalled()
    expect(summary).toEqual({ landed: [], failed: [], waiting: [], dropped: [] })
    expect(pendingCloudJobs()).toHaveLength(1)
  })

  it('two calls at once are one pass', async () => {
    standOn('iphone')
    afterAKill(entry('job-1'))
    let release: (job: unknown) => void = () => {}
    cloud.pollJob.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const first = resumePendingCloudJobs()
    const second = resumePendingCloudJobs()
    expect(second).toBe(first)
    release(finished('job-1'))
    await first
    expect(cloud.pollJob).toHaveBeenCalledTimes(1)
    expect(useCreateStore.getState().gallery).toHaveLength(1)
  })

  it('a pass that left a job waiting looks again by itself', async () => {
    standOn('iphone')
    vi.useFakeTimers()
    try {
      afterAKill(entry('job-1'))
      cloud.pollJob.mockRejectedValueOnce(new cloud.FakeCloudJobError('render timed out', 0))
      cloud.pollJob.mockResolvedValueOnce(finished('job-1'))
      await resumePendingCloudJobs()
      expect(useCreateStore.getState().gallery).toEqual([])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(cloud.pollJob).toHaveBeenCalledTimes(2)
      expect(useCreateStore.getState().gallery).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  for (const device of DESKTOPS) {
    it(`DESKTOP UNCHANGED ${device}: a resume asks nobody and changes nothing`, async () => {
      standOn(device)
      notePendingCloudJob(entry('job-1'))
      const summary = await resumePendingCloudJobs()
      expect(cloud.pollJob).not.toHaveBeenCalled()
      expect(cloud.getJob).not.toHaveBeenCalled()
      expect(summary).toEqual({ landed: [], failed: [], waiting: [], dropped: [] })
      expect(useCreateStore.getState().gallery).toEqual([])
    })
  }
})
