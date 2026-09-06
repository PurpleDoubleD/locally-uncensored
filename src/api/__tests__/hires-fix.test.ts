import { describe, expect, it } from 'vitest'
import {
  applyNativeHiresFix,
  nativeHiresFinalSize,
  NativeHiresFixError,
} from '../hires-fix'
// The graph is read back through the SAME accessor production uses. A fixture
// held as `Record<string, any>` answers `undefined` for a renamed field and the
// assertion goes green against nothing; `nodeInput` answers `undefined` only
// when the input really is absent, and the comparison below is against a
// concrete pair, so absence fails.
import { nodeInput, type ComfyApiGraph } from '../../types/comfy-graph'

const baseWorkflow = (): ComfyApiGraph => ({
  '1': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'model.safetensors' },
  },
  '4': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['8', 0],
      seed: 123,
      steps: 25,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
    },
  },
  '5': {
    class_type: 'VAEDecode',
    inputs: { samples: ['4', 0], vae: ['1', 2] },
  },
  '6': {
    class_type: 'SaveImage',
    inputs: { images: ['5', 0], filename_prefix: 'LU' },
  },
  '8': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 1216, height: 832, batch_size: 1 },
  },
})

describe('nativeHiresFinalSize', () => {
  it('produces the 1.5× 1216×832 target on the latent grid', () => {
    expect(nativeHiresFinalSize(1216, 832, 1.5)).toEqual({
      width: 1824,
      height: 1248,
    })
  })

  it('rejects output dimensions above the app limit', () => {
    expect(() => nativeHiresFinalSize(4096, 4096, 1.5)).toThrow(/4096 px/)
  })
})

describe('applyNativeHiresFix', () => {
  it('inserts a latent upscale and native refinement sampler', () => {
    const source = baseWorkflow()
    const result = applyNativeHiresFix(source, {
      baseWidth: 1216,
      baseHeight: 832,
      scale: 1.5,
      denoise: 0.35,
      steps: 12,
      upscaleMethod: 'bislerp',
    })

    expect(result.width).toBe(1824)
    expect(result.height).toBe(1248)
    expect(result.workflow[result.upscaleNodeId]).toEqual(expect.objectContaining({
      class_type: 'LatentUpscale',
      inputs: {
        samples: ['4', 0],
        upscale_method: 'bislerp',
        width: 1824,
        height: 1248,
        crop: 'disabled',
      },
    }))
    expect(result.workflow[result.samplerNodeId]).toEqual(expect.objectContaining({
      class_type: 'KSampler',
      inputs: expect.objectContaining({
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: [result.upscaleNodeId, 0],
        seed: 123,
        steps: 12,
        cfg: 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 0.35,
      }),
    }))
    expect(nodeInput(result.workflow['5'], 'samples')).toEqual([result.samplerNodeId, 0])

    // The caller's freshly built graph remains untouched.
    expect(nodeInput(source['5'], 'samples')).toEqual(['4', 0])
  })

  it('supports a tiled final image decode', () => {
    const workflow: ComfyApiGraph = baseWorkflow()
    workflow['5'].class_type = 'VAEDecodeTiled'

    const result = applyNativeHiresFix(workflow, {
      baseWidth: 1024,
      baseHeight: 1024,
      scale: 1.25,
      denoise: 0.3,
      steps: 10,
      upscaleMethod: 'bicubic',
    })

    expect(nodeInput(result.workflow['5'], 'samples')).toEqual([result.samplerNodeId, 0])
    expect(result).toEqual(expect.objectContaining({ width: 1280, height: 1280 }))
  })

  it('rejects workflows whose final decode is not fed by a core KSampler', () => {
    const workflow: ComfyApiGraph = baseWorkflow()
    workflow['4'].class_type = 'SamplerCustom'

    expect(() => applyNativeHiresFix(workflow, {
      baseWidth: 1024,
      baseHeight: 1024,
      scale: 1.5,
      denoise: 0.35,
      steps: 12,
      upscaleMethod: 'bislerp',
    })).toThrow(NativeHiresFixError)
  })

  it('rejects ambiguous multi-output image workflows', () => {
    const workflow: ComfyApiGraph = baseWorkflow()
    workflow['9'] = {
      class_type: 'VAEDecode',
      inputs: { samples: ['4', 0], vae: ['1', 2] },
    }
    workflow['10'] = {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: 'second' },
    }

    expect(() => applyNativeHiresFix(workflow, {
      baseWidth: 1024,
      baseHeight: 1024,
      scale: 1.5,
      denoise: 0.35,
      steps: 12,
      upscaleMethod: 'bislerp',
    })).toThrow(/multiple final image decode paths/)
  })
})
