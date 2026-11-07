import { describe, it, expect } from 'vitest'
import { intentToJob, galleryItemFromJob } from '../cloud-jobs'
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
      // Swap Character runs studio models (op 'studio' at submit); the op here
      // says which inputs are gathered, a video as for Motion.
      swap_character: { kind: 'video', op: 'motion' },
    }
    for (const [intent, expected] of Object.entries(cases)) {
      expect(intentToJob(intent as CreateIntent)).toEqual(expected)
    }
  })
})

// P9: galleryItemFromJob was built twice independently (PresetWorkshop.tsx,
// P6; inline in useCloudCreate.ts, P7) because P5 did not port the web's
// version, folded here into the one place the portplan names for it, so
// both PresetWorkshop and useCloudCreate now build a gallery entry the same
// way (studio-p5.md/studio-p6.md, "Offen fuer P9").
describe('galleryItemFromJob', () => {
  it('carries the job identity through, with every local render field neutral', () => {
    const item = galleryItemFromJob({
      id: 'job-1',
      kind: 'video',
      model: 'flashvsr',
      result_url: 'https://lu-labs.ai/e2e/result.mp4',
      attestation: { quote: 'q', verify_url: 'https://lu-labs.ai/verify' },
    })
    expect(item.id).toBe('job-1')
    expect(item.jobId).toBe('job-1')
    expect(item.type).toBe('video')
    expect(item.model).toBe('flashvsr')
    expect(item.remoteUrl).toBe('https://lu-labs.ai/e2e/result.mp4')
    expect(item.attestation).toEqual({ quote: 'q', verify_url: 'https://lu-labs.ai/verify' })
    // Neutral: a Studio/preset job never carries ComfyUI sampler state.
    expect(item.sampler).toBe('')
    expect(item.scheduler).toBe('')
    expect(item.seed).toBe(0)
    expect(item.steps).toBe(0)
    expect(item.cfgScale).toBe(0)
    expect(item.width).toBe(0)
    expect(item.height).toBe(0)
    expect(item.filename).toBe('')
    expect(item.subfolder).toBe('')
    expect(item.negativePrompt).toBe('')
    expect(item.batchSize).toBe(1)
    expect(item.modelType).toBe('unknown')
  })

  it('turns a missing result_url into an undefined remoteUrl, not a null one', () => {
    const item = galleryItemFromJob({ id: 'job-2', kind: 'audio', model: 'minimax-music', result_url: null, attestation: null })
    expect(item.remoteUrl).toBeUndefined()
    expect(item.attestation).toBeNull()
  })

  it('leaves prompt and label out entirely, the caller supplies both', () => {
    const item = galleryItemFromJob({ id: 'job-3', kind: 'image', model: 'preset-chroma', result_url: null, attestation: null })
    expect('prompt' in item).toBe(false)
    expect('label' in item).toBe(false)
  })
})
