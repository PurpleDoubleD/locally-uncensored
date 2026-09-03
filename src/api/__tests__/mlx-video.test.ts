import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ backendCall: vi.fn() }))

vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => mocks.backendCall(...args),
}))

import { generateVideo } from '../mlx-video'

describe('generateVideo', () => {
  beforeEach(() => {
    mocks.backendCall.mockReset()
    mocks.backendCall.mockResolvedValue({ ok: true, jobId: 'job', pid: 1, output: '/tmp/out.mp4' })
  })

  it('forwards the Apple video quality and size selected in Create', async () => {
    await generateVideo({
      id: 'wan21-t2v-1.3b',
      prompt: 'ocean waves',
      steps: 4,
      width: 544,
      height: 320,
      seconds: 0.6,
      fps: 16,
      seed: 7,
    })

    expect(mocks.backendCall).toHaveBeenCalledWith('video_generate', {
      args: {
        id: 'wan21-t2v-1.3b',
        prompt: 'ocean waves',
        steps: 4,
        width: 544,
        height: 320,
        seconds: 0.6,
        fps: 16,
        init_image: undefined,
        seed: 7,
      },
    })
  })
})
