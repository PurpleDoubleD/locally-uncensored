// @vitest-environment jsdom
/**
 * One click swap (14.11.2026, only with the account switch; port of the web's
 * swap-chain.test.ts, 4395e8d1): the chain of frame, video and sound. Every
 * way to the server is a fake; counted is what is sent and what is not.
 * Desktop difference: a character from the list is its picture as a photo
 * (hubPortrait), so every person goes up as an upload, nothing is adopted
 * except the own results of the chain.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { CloudJob, CloudJobSubmit } from '../../../api/cloud/jobs'
import { CloudJobError } from '../../../api/cloud/client'
import {
  approveSwapFrame, cancelSwapChain, clearSwapChain, loadSwapChain, resumeSwapChain, retrySwapFrame, retrySwapOpen,
  startSwapChain, swapChainProblem, swapChainStore, swapChainTotal, swapFrameRefused, SWAP_CHAIN_STORAGE_KEY,
  SWAP_REFUSED_TEXT, type SwapChainDeps, type SwapChainStart,
} from '../swap-chain'
import { swapFrameCredits } from '../swap-frame'
import {
  swapFrameEditors, swapFrameFiltered, swapFrameMaxPeople, swapFrameModelFor, swapFrameOptionsFor,
  SWAP_CONSENT_MISSING, SWAP_FRAME_MODEL, SWAP_FRAME_OPEN_MODEL,
} from '../../render/swap'
import {
  swapFrameChoices, swapIsChain, swapModelName, swapOpenModelsLine, swapVideoBlocked, swapVideoModelFor, useSwapOneClick,
} from '../swap-one-click'

const PIXEL = 'data:image/jpeg;base64,/9j/4AAQ'

type Outcome = Partial<CloudJob> & { status: CloudJob['status'] }

function fakeDeps(outcomes: (submit: CloudJobSubmit, n: number) => Outcome) {
  const submits: CloudJobSubmit[] = []
  const adopted: unknown[] = []
  const uploads: string[] = []
  const canceled: string[] = []
  const results: string[] = []
  let quota = 0
  const byId = new Map<string, Outcome>()
  const deps: SwapChainDeps = {
    uploadInput: async (_b, role) => { uploads.push(role); return `u/${uploads.length}-${role}` },
    adoptInput: async (jobId, role) => { adopted.push([jobId, role]); return `a/${adopted.length}-${role}` },
    submitCloudJob: async (submit) => {
      submits.push(submit)
      const id = `job-${submits.length}`
      byId.set(id, outcomes(submit, submits.length))
      return { id }
    },
    pollJob: async (id) => ({
      id, kind: 'image', model: 'x', provider: 'p', result_url: null, attestation: null, cost_units: 0,
      created_at: '', completed_at: '', error: null, ...byId.get(id)!,
    } as CloudJob),
    cancelJob: async (id) => { canceled.push(id) },
    onResult: (job) => { results.push(job.id) },
    onQuota: () => { quota++ },
  }
  return { deps, submits, adopted, uploads, canceled, results, quota: () => quota }
}

const ok = (url: string): Outcome => ({ status: 'succeeded', result_url: url })
const params = (s: CloudJobSubmit) => s.params as unknown as Record<string, unknown>

function start(over: Partial<SwapChainStart> = {}): SwapChainStart {
  return {
    frame: { url: PIXEL, width: 1280, height: 720 },
    figures: [
      { image: { url: PIXEL }, role: '', mark: { x: 0.4, y: 0.3 } },
      { image: { url: PIXEL }, role: '', mark: { x: 0.7, y: 0.3 } },
    ],
    frameModel: SWAP_FRAME_MODEL,
    check: false,
    consent: true,
    who: 'Bean and Photo',
    videoSubmit: {
      kind: 'video', model: 'scail-2', prompt: '',
      params: { op: 'studio', video_path: 'u/video', swap_step: 'video', swap_consent: true, sound: 'original', max_credits: 48000 },
    },
    videoCredits: 48000,
    lipsync: null,
    ...over,
  }
}

beforeEach(() => { clearSwapChain(); localStorage.clear() })

describe('one click: frame, then video, then done', () => {
  it('sends the frame step, then the video with the new frame as source_path', async () => {
    const f = fakeDeps((s) => ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4'))
    await startSwapChain(start(), f.deps)
    expect(f.submits.map((s) => [s.model, params(s).swap_step])).toEqual([
      ['nano-banana-pro-edit', 'frame'], ['scail-2', 'video'],
    ])
    // The video frame first, then one photo per person, all uploaded before
    // the first job.
    const frame = params(f.submits[0])
    expect(frame.image_paths).toEqual(['u/1-source', 'u/2-source', 'u/3-source'])
    expect(frame.swap_consent).toBe(true)
    expect(frame.studio_options).toEqual({ aspect_ratio: '16:9', resolution: '2k', output_format: 'jpeg' })
    expect(frame.max_credits).toBe(swapFrameCredits(1280, 720, 2))
    // The video runs on the result of the frame step (adopt job-1).
    expect(f.adopted).toEqual([['job-1', 'image']])
    const video = params(f.submits[1])
    expect(video.source_path).toBe('a/1-image')
    expect(video.max_credits).toBe(48000)
    expect(video.swap_consent).toBe(true)
    expect(video.sound).toBe('original')
    const chain = swapChainStore.getState().chain!
    expect(chain.stage).toBe('done')
    expect(chain.resultUrl).toBe('https://r/video.mp4')
    expect(f.results).toEqual(['job-2'])
    expect(f.quota()).toBeGreaterThan(0)
  })

  it('the new voice runs after the video as swap_step lipsync, on the own video', async () => {
    const f = fakeDeps((s) => ok(`https://r/${s.kind}`))
    await startSwapChain(start({
      figures: [start().figures[0]],
      lipsync: { model: 'latentsync', audio: { type: 'blob', blob: new Blob(['a']) }, credits: 900 },
    }), f.deps)
    expect(f.submits.map((s) => params(s).swap_step)).toEqual(['frame', 'video', 'lipsync'])
    expect(f.uploads).toContain('audio')
    const lip = params(f.submits[2])
    expect(lip.swap_consent).toBe(true)
    expect(lip.max_credits).toBe(900)
    expect(f.adopted.at(-1)).toEqual(['job-2', 'video'])
    expect(swapChainStore.getState().chain!.stage).toBe('done')
    expect(f.results).toEqual(['job-2', 'job-3'])
  })

  it('a voice from an earlier job is adopted, not uploaded', async () => {
    const f = fakeDeps((s) => ok(`https://r/${s.kind}`))
    await startSwapChain(start({
      figures: [start().figures[0]],
      lipsync: { model: 'latentsync', audio: { type: 'job', jobId: 'voice-1' }, credits: 900 },
    }), f.deps)
    expect(f.adopted[0]).toEqual(['voice-1', 'audio'])
    expect(f.uploads).not.toContain('audio')
  })

  it('a failed lip sync keeps the video and says so', async () => {
    const f = fakeDeps((s, n) => (n === 3 ? { status: 'failed', error: 'Lip sync broke.' } : ok(`https://r/${s.kind}`)))
    await startSwapChain(start({
      figures: [start().figures[0]],
      lipsync: { model: 'latentsync', audio: { type: 'blob', blob: new Blob(['a']) }, credits: 900 },
    }), f.deps)
    const chain = swapChainStore.getState().chain!
    expect(chain.stage).toBe('done')
    expect(chain.resultUrl).toBe('https://r/video')
    expect(chain.error).toMatch(/lip sync failed: Lip sync broke\./)
  })
})

describe('head crop of the photos (14.11.2026)', () => {
  it('the frame step gets the cut photos, the video step does not', async () => {
    const f = fakeDeps((s) => ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4'))
    const blobs: Blob[] = []
    const cropped: Blob[] = []
    f.deps.uploadInput = async (b, role) => { blobs.push(b); f.uploads.push(role); return `u/${f.uploads.length}-${role}` }
    f.deps.cropFace = async (b) => { const out = new Blob(['head'], { type: b.type }); cropped.push(out); return out }
    const s = start()
    const video = structuredClone(s.videoSubmit)
    await startSwapChain(s, f.deps)
    // Uploaded: the first frame (whole), then the two heads.
    expect(blobs).toHaveLength(3)
    expect(cropped).toHaveLength(2)
    expect(cropped).not.toContain(blobs[0])
    expect(blobs.slice(1)).toEqual(cropped)
    expect(params(f.submits[0]).image_paths).toEqual(['u/1-source', 'u/2-source', 'u/3-source'])
    // The video: the job from outside, unchanged, plus the result of the
    // frame step as source_path. None of the heads is in it.
    const { source_path, ...rest } = params(f.submits[1])
    expect(rest).toEqual(video.params)
    expect(source_path).toBe('a/1-image')
    expect(JSON.stringify(f.submits[1])).not.toMatch(/u\/[23]-source/)
  })

  it('without a face (crop gives the photo back) the whole photo goes up', async () => {
    const f = fakeDeps((s) => ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4'))
    const blobs: Blob[] = []
    const given: Blob[] = []
    f.deps.uploadInput = async (b, role) => { blobs.push(b); f.uploads.push(role); return `u/${f.uploads.length}-${role}` }
    f.deps.cropFace = async (b) => { given.push(b); return b }
    await startSwapChain(start(), f.deps)
    expect(blobs.slice(1)).toEqual(given)
    expect(swapChainStore.getState().chain!.stage).toBe('done')
  })
})

describe('Check first frame before video', () => {
  it('stops after the frame; the video starts only on Continue', async () => {
    const f = fakeDeps((s) => ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4'))
    await startSwapChain(start({ check: true }), f.deps)
    expect(swapChainStore.getState().chain!.stage).toBe('review')
    expect(swapChainStore.getState().chain!.frameUrl).toBe('https://r/frame.jpg')
    expect(f.submits).toHaveLength(1)
    await approveSwapFrame(f.deps)
    expect(f.submits).toHaveLength(2)
    expect(swapChainStore.getState().chain!.stage).toBe('done')
  })

  it('Try again runs only the frame step, with "What\'s wrong?" in the sentence', async () => {
    const f = fakeDeps((s) => ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4'))
    await startSwapChain(start({ check: true }), f.deps)
    await retrySwapFrame(f.deps, { extra: 'Keep the glasses.' })
    expect(f.submits.map((s) => s.kind)).toEqual(['image', 'image'])
    expect(f.submits[1].prompt).toContain('Keep the glasses.')
    expect(swapChainStore.getState().chain!.stage).toBe('review')
  })
})

describe('Uncensored and own picks', () => {
  it('with Uncensored Qwen Image 2.1 Edit builds the frame, at 1k', async () => {
    expect(swapFrameModelFor(true)).toBe(SWAP_FRAME_OPEN_MODEL)
    expect(swapFrameModelFor(false)).toBe(SWAP_FRAME_MODEL)
    const f = fakeDeps((s) => ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4'))
    await startSwapChain(start({ frameModel: swapFrameModelFor(true) }), f.deps)
    expect(f.submits[0].model).toBe('qwen-image-2.1-edit')
    expect(params(f.submits[0]).studio_options).toMatchObject({ resolution: '1k', aspect_ratio: '16:9' })
    expect(params(f.submits[0]).swap_step).toBe('frame')
    expect(swapFrameFiltered('qwen-image-2.1-edit')).toBe(false)
    expect(swapFrameFiltered('nano-banana-pro-edit')).toBe(true)
  })

  it('every editor that reads two images can be picked, nothing else', () => {
    const editors = swapFrameEditors()
    expect(editors).toContain('nano-banana-pro-edit')
    expect(editors).toContain('qwen-image-2.1-edit')
    for (const id of editors) expect(swapFrameMaxPeople(id)).toBeGreaterThanOrEqual(1)
    for (const id of editors) expect(typeof swapFrameOptionsFor(id, 720, 1280)).toBe('object')
    const other = editors.find((id) => id !== SWAP_FRAME_MODEL && id !== SWAP_FRAME_OPEN_MODEL)
    if (other) expect(swapFrameModelFor(false, other)).toBe(other)
    expect(swapFrameModelFor(true, 'flux-schnell')).toBe(SWAP_FRAME_OPEN_MODEL)
    expect(swapFrameChoices(false)[0]).toEqual({ value: '', label: 'Auto (Nano Banana Pro)' })
    expect(swapFrameChoices(true)[0].label).toBe(`Auto (${swapModelName(SWAP_FRAME_OPEN_MODEL)})`)
  })

  it('video: SCAIL-2 until the customer picks another, never switched by the number of people', () => {
    expect(swapVideoModelFor(1, null)).toBe('scail-2')
    expect(swapVideoModelFor(3, null)).toBe('scail-2')
    expect(swapVideoModelFor(4, null)).toBe('scail-2')
    expect(swapVideoModelFor(1, 'kling-v3-pro-motion-control')).toBe('kling-v3-pro-motion-control')
    expect(swapVideoModelFor(2, 'kling-v3-pro-motion-control')).toBe('kling-v3-pro-motion-control')
    expect(swapVideoModelFor(1, 'not-a-swap-model')).toBe('scail-2')
    expect(swapVideoBlocked('kling-v3-pro-motion-control', 2)).toBe('one person only')
    expect(swapVideoBlocked('scail-2', 4)).toBe('up to 3 people')
    expect(swapIsChain('scail-2')).toBe(true)
    expect(swapIsChain('kling-v3-pro-motion-control')).toBe(true)
    expect(swapIsChain('openjutsu-character-swap')).toBe(false)
    expect(swapOpenModelsLine('scail-2')).toBe('Off: Nano Banana Pro + SCAIL-2. On: open-weight models, less strict.')
  })

  it('Check first frame follows Uncensored (on with it, off without), until set by hand', () => {
    useSwapOneClick.setState({ openModels: false, check: false, checkTouched: false })
    const p = () => useSwapOneClick.getState()
    p().setOpenModels(true)
    expect(p().check).toBe(true)
    p().setOpenModels(false)
    expect(p().check).toBe(false)
    p().setOpenModels(true)
    // The customer turns it off by hand: it stays off from now on.
    p().setCheck(false)
    p().setOpenModels(false)
    p().setOpenModels(true)
    expect(p().check).toBe(false)
    expect(p().checkTouched).toBe(true)
    useSwapOneClick.setState({ openModels: false, check: false, checkTouched: false })
    // Turned on by hand without Uncensored: stays on when Uncensored goes off again.
    p().setCheck(true)
    p().setOpenModels(true)
    p().setOpenModels(false)
    expect(p().check).toBe(true)
    useSwapOneClick.setState({ openModels: false, check: false, checkTouched: false })
  })

  it('both switches start off', () => {
    const p = useSwapOneClick.getState()
    expect(p.openModels).toBe(false)
    expect(p.check).toBe(false)
    expect(p.frameOverride).toBe('')
    expect(p.videoOverride).toBe('')
  })
})

describe('the filtered editor refuses', () => {
  it('no video, nothing booked; Turn on Uncensored and retry builds the frame on the open editor', async () => {
    let refuse = true
    const f = fakeDeps((s) => (s.kind === 'image' && refuse
      ? { status: 'failed', error: 'Nano Banana Pro declined this prompt. No credits were charged.', fallback_model: 'qwen-image-2.1-edit' }
      : ok(s.kind === 'image' ? 'https://r/frame.jpg' : 'https://r/video.mp4')))
    await startSwapChain(start(), f.deps)
    const chain = swapChainStore.getState().chain!
    expect(chain.stage).toBe('refused')
    expect(chain.error).toBe(SWAP_REFUSED_TEXT)
    expect(f.submits.filter((s) => s.kind === 'video')).toHaveLength(0)
    refuse = false
    await retrySwapOpen(f.deps)
    expect(f.submits[1].model).toBe('qwen-image-2.1-edit')
    expect(params(f.submits[1]).max_credits).toBe(swapFrameCredits(1280, 720, 2, 'qwen-image-2.1-edit'))
    // The open editor gets its own sentence: the photos are only face references.
    expect(f.submits[0].prompt).toMatch(/^In the first image, replace/)
    expect(f.submits[1].prompt).toMatch(/^The first image is a frame from a video and is the base image\./)
    expect(swapChainStore.getState().chain!.stage).toBe('done')
  })

  it('an open editor that fails is a failure, not a refusal', async () => {
    const f = fakeDeps(() => ({ status: 'failed', error: 'This request could not be rendered.', fallback_model: null }))
    await startSwapChain(start({ frameModel: SWAP_FRAME_OPEN_MODEL }), f.deps)
    const chain = swapChainStore.getState().chain!
    expect(chain.stage).toBe('failed')
    expect(chain.error).toMatch(/^The first frame failed: .*The video was not started\.$/)
    expect(f.submits).toHaveLength(1)
  })

  it('another error is no refusal', () => {
    expect(swapFrameRefused({ status: 'failed', error: 'The render took too long and was stopped.', fallback_model: null })).toBe(false)
    expect(swapFrameRefused({ status: 'failed', error: 'This request could not be rendered. No credits were charged.', fallback_model: null })).toBe(true)
    expect(swapFrameRefused({ status: 'succeeded', error: null, fallback_model: null })).toBe(false)
  })
})

describe('leaving and coming back', () => {
  it('the state stands in localStorage; after a restart the running job is followed on, not sent again', async () => {
    let frameDone = false
    const f = fakeDeps(() => ({ status: 'running' }))
    // The frame step still runs when the app closes.
    f.deps.pollJob = async (id) => {
      if (!frameDone) throw new CloudJobError('render timed out', 0)
      return {
        id, kind: id === 'job-1' ? 'image' : 'video', model: 'x', provider: 'p', status: 'succeeded',
        result_url: `https://r/${id}`, attestation: null, cost_units: 0, created_at: '', completed_at: '', error: null,
      } as CloudJob
    }
    await startSwapChain(start(), f.deps)
    expect(JSON.parse(localStorage.getItem(SWAP_CHAIN_STORAGE_KEY)!).frameJobId).toBe('job-1')
    expect(swapChainStore.getState().note).toMatch(/Still rendering/)
    // Restart: the store is empty, localStorage is not.
    swapChainStore.setState({ chain: null, busy: false, note: null })
    frameDone = true
    expect(loadSwapChain()!.stage).toBe('frame')
    await resumeSwapChain(f.deps)
    expect(f.submits.map((s) => s.kind)).toEqual(['image', 'video'])
    expect(swapChainStore.getState().chain!.stage).toBe('done')
  })

  it('Cancel stops the running step', async () => {
    const f = fakeDeps(() => ({ status: 'running' }))
    f.deps.pollJob = async () => { throw new CloudJobError('render timed out', 0) }
    await startSwapChain(start(), f.deps)
    expect(await cancelSwapChain(f.deps)).toBe('canceled')
    expect(f.canceled).toEqual(['job-1'])
    expect(swapChainStore.getState().chain!.stage).toBe('canceled')
  })

  it('Cancel on a step a GPU already has: it finishes, nothing after it is sent', async () => {
    const f = fakeDeps(() => ({ status: 'running' }))
    f.deps.pollJob = async () => { throw new CloudJobError('render timed out', 0) }
    f.deps.cancelJob = async () => { throw new CloudJobError('already running', 409) }
    await startSwapChain(start(), f.deps)
    expect(await cancelSwapChain(f.deps)).toBe('running')
    const chain = swapChainStore.getState().chain!
    expect(chain.check).toBe(true)
    expect(swapChainStore.getState().note).toMatch(/cannot be stopped/)
  })

  it('a second start while one runs is refused', async () => {
    const f = fakeDeps(() => ({ status: 'running' }))
    f.deps.pollJob = async () => { throw new CloudJobError('render timed out', 0) }
    await startSwapChain(start(), f.deps)
    await expect(startSwapChain(start(), f.deps)).rejects.toThrow('A swap is already running.')
    expect(f.submits).toHaveLength(1)
  })
})

describe('total price and the check before the start', () => {
  it('button = frame + video + lip sync', () => {
    const frame = swapFrameCredits(1280, 720, 2)!
    expect(frame).toBe(14000)
    expect(swapChainTotal({ frame, video: 48000 })).toBe(62000)
    expect(swapChainTotal({ frame, video: 48000, lipsync: 900 })).toBe(62900)
    expect(swapChainTotal({ frame, video: null })).toBeNull()
  })

  it('without a character, a video or the consent nothing starts and nothing is uploaded', async () => {
    const s = start()
    expect(swapChainProblem({ ...s, frame: null })).toMatch(/video/)
    expect(swapChainProblem({ ...s, figures: [{ image: null, role: '' }] })).toMatch(/character or a photo/)
    expect(swapChainProblem({ ...s, consent: false })).toBe(SWAP_CONSENT_MISSING)
    expect(swapChainProblem({ ...s, figures: [...s.figures, ...s.figures], frameModel: SWAP_FRAME_MODEL })).toBeNull()
    expect(swapChainProblem(s)).toBeNull()
    const f = fakeDeps(() => ok('x'))
    await expect(startSwapChain({ ...s, consent: false }, f.deps)).rejects.toThrow(SWAP_CONSENT_MISSING)
    expect(f.uploads).toHaveLength(0)
    expect(f.submits).toHaveLength(0)
  })
})
