// Scene to Video on the local lane (3.1.3): the graph buildSceneWorkflow
// hands to ComfyUI. A depth video of the scene drives Wan 2.1 VACE; an own
// first frame opens the control video with a keep mask.

import { describe, it, expect, vi } from 'vitest'
import { buildSceneWorkflow, SCENE_DEPTH_CKPT, WorkflowUnavailableError, type LocalOpParams } from '../dynamic-workflow'
import type { ComfyApiGraph, ComfyApiNode } from '../../types/comfy-graph'

vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return {
    ...actual,
    findMatchingCLIP: vi.fn(async () => 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
    findMatchingVAE: vi.fn(async () => 'wan_2.1_vae.safetensors'),
  }
})

const nodes = (...names: string[]): Record<string, object> => Object.fromEntries(names.map((n) => [n, {}]))
const BASE = [
  'UNETLoader', 'UnetLoaderGGUF', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'WanVaceToVideo', 'TrimVideoLatent',
  'ModelSamplingSD3', 'KSampler', 'VAEDecode', 'CreateVideo', 'SaveVideo', 'DepthAnythingV2Preprocessor',
  'LoadImage', 'ImageScale', 'ImageFromBatch', 'ImageBatch', 'EmptyImage', 'ImageToMask', 'LoadVideo', 'GetVideoComponents',
]
const WITH_VHS = nodes(...BASE, 'VHS_LoadVideo')
const CORE_ONLY = nodes(...BASE)

const PARAMS: LocalOpParams = {
  op: 'scene', model: 'wan2.1_vace_1.3B_fp16.safetensors', prompt: 'a cozy living room, soft window light',
  negativePrompt: '', seed: 7, steps: 25, cfgScale: 5, sampler: 'euler', scheduler: 'simple',
  width: 832, height: 480, frames: 77, fps: 16, drivingVideo: 'scene.mp4',
}

function one(wf: ComfyApiGraph, type: string): ComfyApiNode {
  const hits = Object.values(wf).filter((n) => n.class_type === type)
  if (hits.length !== 1) throw new Error(`${type}: ${hits.length} nodes`)
  return hits[0]
}
const idOf = (wf: ComfyApiGraph, node: ComfyApiNode) => Object.entries(wf).find(([, n]) => n === node)![0]

describe('buildSceneWorkflow', () => {
  it('resamples the scene to 16 fps with VHS, draws depth with Depth Anything V2 Small and drives VACE with it', async () => {
    const wf = await buildSceneWorkflow(PARAMS, 7, WITH_VHS)
    const load = one(wf, 'VHS_LoadVideo')
    expect(load.inputs).toMatchObject({ video: 'scene.mp4', force_rate: 16, frame_load_cap: 77, skip_first_frames: 0, select_every_nth: 1 })
    const depth = one(wf, 'DepthAnythingV2Preprocessor')
    expect(depth.inputs?.ckpt_name).toBe(SCENE_DEPTH_CKPT)
    expect(SCENE_DEPTH_CKPT).toBe('depth_anything_v2_vits.pth')
    expect(depth.inputs?.image).toEqual([idOf(wf, load), 0])
    const vace = one(wf, 'WanVaceToVideo')
    expect(vace.inputs).toMatchObject({ width: 832, height: 480, length: 77, strength: 1 })
    expect(vace.inputs?.control_video).toEqual([idOf(wf, depth), 0])
    expect(vace.inputs?.control_masks).toBeUndefined()
    expect(vace.inputs?.reference_image).toBeUndefined()
    // No pose, no reference, and no core LoadVideo when VHS is there.
    expect(Object.values(wf).some((n) => n.class_type === 'LoadVideo' || n.class_type === 'DWPreprocessor')).toBe(false)
    expect(one(wf, 'CreateVideo').inputs).toMatchObject({ fps: 16 })
    expect(one(wf, 'CreateVideo').inputs?.audio).toBeUndefined()
    expect(one(wf, 'KSampler').inputs).toMatchObject({ seed: 7, steps: 25, cfg: 5 })
    const pos = Object.values(wf).find((n) => n.class_type === 'CLIPTextEncode' && n.inputs?.text === PARAMS.prompt)
    expect(pos).toBeTruthy()
  })

  it('without VideoHelperSuite takes the clip at its own rate and plays the result at that rate', async () => {
    const wf = await buildSceneWorkflow(PARAMS, 7, CORE_ONLY)
    const comps = one(wf, 'GetVideoComponents')
    const cap = one(wf, 'ImageFromBatch')
    expect(cap.inputs).toMatchObject({ batch_index: 0, length: 77 })
    expect(cap.inputs?.image).toEqual([idOf(wf, comps), 0])
    expect(one(wf, 'CreateVideo').inputs?.fps).toEqual([idOf(wf, comps), 2])
  })

  it('opens the control video with an own first frame and keeps it by a mask of 0', async () => {
    const wf = await buildSceneWorkflow({ ...PARAMS, firstFrame: 'scene-first-frame.png' }, 7, WITH_VHS)
    expect(one(wf, 'LoadImage').inputs?.image).toBe('scene-first-frame.png')
    const vace = one(wf, 'WanVaceToVideo')
    const batches = Object.values(wf).filter((n) => n.class_type === 'ImageBatch')
    expect(batches).toHaveLength(2)
    const control = wf[(vace.inputs?.control_video as [string, number])[0]]
    expect(control.class_type).toBe('ImageBatch')
    const rest = wf[(control.inputs?.image2 as [string, number])[0]]
    expect(rest.class_type).toBe('ImageFromBatch')
    expect(rest.inputs).toMatchObject({ batch_index: 1, length: 76 })
    const mask = wf[(vace.inputs?.control_masks as [string, number])[0]]
    expect(mask.class_type).toBe('ImageToMask')
    const empties = Object.values(wf).filter((n) => n.class_type === 'EmptyImage').map((n) => n.inputs)
    expect(empties).toEqual([
      { width: 832, height: 480, batch_size: 1, color: 0 },
      { width: 832, height: 480, batch_size: 76, color: 0xffffff },
    ])
  })

  it('asks for the depth extractor when the pack is missing, before anything else', async () => {
    const without = nodes(...BASE.filter((n) => n !== 'DepthAnythingV2Preprocessor'), 'VHS_LoadVideo')
    await expect(buildSceneWorkflow(PARAMS, 7, without)).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(buildSceneWorkflow(PARAMS, 7, without)).rejects.toThrow(/depth extractor/)
  })

  it('runs on VACE only and needs the scene video', async () => {
    await expect(buildSceneWorkflow({ ...PARAMS, model: 'Wan2.2-Animate-14B-Q4_K_M.gguf' }, 7, WITH_VHS)).rejects.toThrow(/Wan 2.1 VACE/)
    await expect(buildSceneWorkflow({ ...PARAMS, drivingVideo: undefined }, 7, WITH_VHS)).rejects.toThrow('Add your scene video first.')
  })

  it('snaps size to 16 and length to the Wan grid', async () => {
    const wf = await buildSceneWorkflow({ ...PARAMS, width: 830, height: 470, frames: 80 }, 7, WITH_VHS)
    expect(one(wf, 'WanVaceToVideo').inputs).toMatchObject({ width: 832, height: 464, length: 81 })
  })
})
