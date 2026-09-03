import { describe, it, expect } from 'vitest'
import { intentToJob } from '../cloud-jobs'
import type { CreateIntent } from '../../../stores/createStore'

describe('intentToJob', () => {
  it('maps every Create intent onto its queue kind + op', () => {
    const cases: Record<CreateIntent, { kind: string; op: string }> = {
      image: { kind: 'image', op: 'generate' },
      edit: { kind: 'image', op: 'edit' },
      removebg: { kind: 'image', op: 'removebg' },
      upscale: { kind: 'image', op: 'upscale' },
      eraser: { kind: 'image', op: 'eraser' },
      video: { kind: 'video', op: 'generate' },
      animate: { kind: 'video', op: 'animate' },
      // The five 2.5.8 cloud categories. The Record<CreateIntent, ...> type
      // says "every intent", but these were missing, so the only coverage
      // intentToJob had for them was the switch falling through to
      // image/generate — which is what the map now pins down.
      character: { kind: 'image', op: 'lora-train' },
      lipsync: { kind: 'video', op: 'lipsync' },
      music: { kind: 'audio', op: 'music' },
      extend: { kind: 'video', op: 'extend' },
      motion: { kind: 'video', op: 'motion' },
    }
    for (const [intent, expected] of Object.entries(cases)) {
      expect(intentToJob(intent as CreateIntent)).toEqual(expected)
    }
  })
})
