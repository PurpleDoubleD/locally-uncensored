// The settle takes the frames already there from the clip it settled last
// time (P5 box run, 30 s): ComfyUI's copy of them came out brighter with
// every section. The base only goes along when it lies next to the item,
// since the command looks for it in the item's own folder.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: Array<Record<string, unknown>> = []
vi.mock('../backend', () => ({
  isTauri: () => true,
  backendCall: async (_cmd: string, args: Record<string, unknown>) => {
    calls.push(args)
    return { filename: 'clip_settled.mp4', subfolder: String(args.subfolder ?? '') }
  },
}))

import { settleSeams } from '../video-settle'

describe('settleSeams and its base', () => {
  beforeEach(() => { calls.length = 0 })

  it('sends the base file name with the call', async () => {
    await settleSeams({ filename: 'vid_00008_.mp4', subfolder: '' }, [157], 81, { filename: 'vid_00007__settled.mp4', subfolder: '' })
    expect(calls[0]).toMatchObject({ filename: 'vid_00008_.mp4', boundaries: [157], anchorEnd: 81, baseFilename: 'vid_00007__settled.mp4' })
  })

  it('leaves the base out when it lies in another subfolder', async () => {
    await settleSeams({ filename: 'a.mp4', subfolder: 'video' }, [157], 81, { filename: 'b.mp4', subfolder: '' })
    expect(calls[0]).not.toHaveProperty('baseFilename')
  })

  it('works as before without a base', async () => {
    await settleSeams({ filename: 'a.mp4' }, [81], 81)
    expect(calls[0]).not.toHaveProperty('baseFilename')
  })
})
