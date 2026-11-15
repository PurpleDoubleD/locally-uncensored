// The second step of "New voice, lips in sync" (14.11.2026): the own video by
// adopt, the voice by upload or adopt, one job, Cancel and expiry.
import { describe, it, expect, vi } from 'vitest'
import { lipsyncFailedText, runLipsyncStep, type LipsyncStepDeps } from '../lipsync-chain'

function deps(over: Partial<LipsyncStepDeps> = {}) {
  const calls: string[] = []
  const d: LipsyncStepDeps = {
    uploadInput: vi.fn(async (_b: Blob, role) => { calls.push(`upload ${role}`); return `up-${role}` }),
    adoptInput: vi.fn(async (jobId: string, role) => { calls.push(`adopt ${jobId} ${role}`); return `ad-${jobId}` }),
    submitCloudJob: vi.fn(async () => { calls.push('submit'); return { id: 'lip-1' } }),
    pollJob: vi.fn(async (id: string) => ({ id, status: 'succeeded', result_url: 'https://x/lip.mp4' }) as never),
    cancelJob: vi.fn(async () => ({})),
    ...over,
  }
  return { d, calls }
}

describe('runLipsyncStep', () => {
  it('adopts the video, uploads the voice, starts one lip sync job and waits for it', async () => {
    const { d, calls } = deps()
    const seen: string[] = []
    const job = await runLipsyncStep(
      { videoJobId: 'swap-1', audio: { type: 'blob', blob: new Blob(['a']) }, model: 'latentsync', credits: 9000, swap: true },
      { ...d, onSubmitted: (id) => seen.push(id) },
    )
    expect(job.status).toBe('succeeded')
    expect(calls).toEqual(['adopt swap-1 video', 'upload audio', 'submit'])
    expect(seen).toEqual(['lip-1'])
    const body = (d.submitCloudJob as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(body.params).toMatchObject({ op: 'lipsync', video_path: 'ad-swap-1', audio_path: 'up-audio', swap_step: 'lipsync', fit_audio: true, max_credits: 9000 })
  })

  it('an earlier voice is adopted as audio', async () => {
    const { d, calls } = deps()
    await runLipsyncStep({ videoJobId: 'm-1', audio: { type: 'job', jobId: 'tts-1' }, model: 'latentsync', credits: null, swap: false }, d)
    expect(calls).toEqual(['adopt m-1 video', 'adopt tts-1 audio', 'submit'])
  })

  it('an expired video reads as a sentence, nothing is started', async () => {
    const { d } = deps({ adoptInput: vi.fn(async () => { throw Object.assign(new Error('gone'), { status: 404 }) }) })
    await expect(runLipsyncStep({ videoJobId: 'x', audio: { type: 'job', jobId: 't' }, model: 'latentsync', credits: 1, swap: false }, d))
      .rejects.toThrow('That video has expired, so the lip sync could not start.')
    expect(d.submitCloudJob).not.toHaveBeenCalled()
  })

  it('a Cancel during the submit cancels the job just taken', async () => {
    const ac = new AbortController()
    const { d } = deps({ submitCloudJob: vi.fn(async () => { ac.abort(); return { id: 'lip-2' } }) })
    await expect(runLipsyncStep({ videoJobId: 'x', audio: { type: 'blob', blob: new Blob(['a']) }, model: 'latentsync', credits: 1, swap: false }, { ...d, signal: ac.signal }))
      .rejects.toThrow('polling aborted')
    expect(d.cancelJob).toHaveBeenCalledWith('lip-2')
    expect(d.pollJob).not.toHaveBeenCalled()
  })
})

describe('lipsyncFailedText', () => {
  it('says the video is there and the step was not charged', () => {
    expect(lipsyncFailedText('no face')).toBe('Your video is in the gallery, but the lip sync failed: no face. The lip sync was not charged.')
    expect(lipsyncFailedText(null)).toBe('Your video is in the gallery, but the lip sync failed. The lip sync was not charged.')
  })
})
