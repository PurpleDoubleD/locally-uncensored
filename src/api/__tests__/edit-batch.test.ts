/**
 * B35 (3.0.9, Discord 29.10.2026): "Edit gives only 1 image despite batch 8".
 * A local ComfyUI edit starts from the encoded source, a latent of one, so
 * batchSize changed nothing. applyEditBatch repeats that latent; the graphs
 * here are the ones the local Edit lane really builds.
 *
 * Run: npx vitest run src/api/__tests__/edit-batch.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow } from '../dynamic-workflow'
import { applyEditBatch } from '../edit-batch'
import { applyNativeHiresFix, NativeHiresFixError } from '../hires-fix'
import { getAllNodeInfo } from '../comfyui-nodes'
import { nodeInput, type ComfyApiGraph } from '../../types/comfy-graph'
import { nodeOf, nodesOf } from './graph-test-support'

const CHECKPOINT_NODES: Record<string, unknown> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
  CLIPTextEncode: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  LoadImage: { input: { required: { image: [[]] } } },
  LoadImageMask: { input: { required: { image: [[]] } } },
  VAEEncode: { input: { required: {} } },
  VAEEncodeForInpaint: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}
const sdxl = {
  model: 'sdxl.safetensors', prompt: 'a red jacket', negativePrompt: 'blurry',
  sampler: 'euler', scheduler: 'normal', width: 1024, height: 1024, steps: 20, cfgScale: 7, seed: 1, batchSize: 4,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAllNodeInfo).mockResolvedValue(CHECKPOINT_NODES as never)
})

const samplerLatentSource = (wf: ComfyApiGraph) => {
  const sampler = nodeOf(wf, 'KSampler')?.[1]
  const ref = nodeInput(sampler, 'latent_image') as [string, number]
  return wf[ref[0]]
}

describe('B35: a local edit makes as many pictures as the batch size says', () => {
  it('the edit graph alone starts from a latent of one (the bug)', async () => {
    const wf = await buildDynamicWorkflow({ ...sdxl, inputImage: 'photo.png', denoise: 0.6 } as never)
    expect(samplerLatentSource(wf).class_type).toBe('VAEEncode')
    expect(nodesOf(wf, 'EmptyLatentImage')).toHaveLength(0)
  })

  it('SDXL edit, batch 4: the sampler starts from the source latent repeated four times', async () => {
    const wf = applyEditBatch(await buildDynamicWorkflow({ ...sdxl, inputImage: 'photo.png', denoise: 0.6 } as never), 4)
    const repeat = samplerLatentSource(wf)
    expect(repeat.class_type).toBe('RepeatLatentBatch')
    expect(repeat.inputs?.amount).toBe(4)
    const from = repeat.inputs?.samples as [string, number]
    expect(wf[from[0]].class_type).toBe('VAEEncode')
  })

  it('a masked edit is repeated too, and Native HiRes still sees the mask', async () => {
    const wf = applyEditBatch(await buildDynamicWorkflow({ ...sdxl, inputImage: 'photo.png', maskImage: 'mask.png', denoise: 0.6 } as never), 3)
    const repeat = samplerLatentSource(wf)
    expect(repeat.class_type).toBe('RepeatLatentBatch')
    expect(() => applyNativeHiresFix(wf, { baseWidth: 1024, baseHeight: 1024, scale: 1.5, denoise: 0.5, steps: 12, upscaleMethod: 'nearest-exact' }))
      .toThrow(NativeHiresFixError)
  })

  it('batch 1 leaves the graph as it is; more than 8 is capped at 8', async () => {
    const wf = await buildDynamicWorkflow({ ...sdxl, inputImage: 'photo.png', denoise: 0.6 } as never)
    expect(applyEditBatch(wf, 1)).toBe(wf)
    expect(samplerLatentSource(applyEditBatch(wf, 20)).inputs?.amount).toBe(8)
  })

  it('a text-to-image graph (empty latent) and a second stage are left alone', () => {
    const wf: ComfyApiGraph = {
      '1': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 2 } },
      '2': { class_type: 'KSampler', inputs: { latent_image: ['1', 0] } },
      '3': { class_type: 'KSampler', inputs: { latent_image: ['2', 0] } },
    }
    const out = applyEditBatch(wf, 4)
    expect(nodesOf(out, 'RepeatLatentBatch')).toHaveLength(0)
  })
})
