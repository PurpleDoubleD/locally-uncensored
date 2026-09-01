import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the backend transport so getAllNodeInfo()'s localFetch returns a synthetic
// /object_info payload — ComfyUI is not live in CI.
const localFetch = vi.fn()
vi.mock('../backend', () => ({
  comfyuiUrl: (p: string) => `http://127.0.0.1:8188${p}`,
  localFetch: (...a: unknown[]) => localFetch(...a),
}))

import { getModelCapabilities, clearNodeCache, type ModelCapabilities, type NodeMetadata } from '../comfyui-nodes'
import { clampOrReject, enumReject, videoFrameReject } from '../vram-handoff'

// Tuple shape mirrors real ComfyUI /object_info: [enumList, {}] for enums,
// ['INT'|'FLOAT', {default,min,max,step}] for numeric inputs.
// Nur der Teil von NodeMetadata, den diese Tests fuettern — `output` &co. liest
// getModelCapabilities nicht. Als Pick deklariert statt als `any`: benennt
// ComfyUI (oder unser Parser) `input.required` um, faellt das hier auf, statt
// still leere Capabilities zu erzeugen.
const OBJECT_INFO: Record<string, Pick<NodeMetadata, 'input'>> = {
  KSampler: { input: { required: {
    sampler_name: [['euler', 'dpmpp_2m', 'uni_pc'], {}],
    scheduler: [['normal', 'karras'], {}],
    steps: ['INT', { default: 20, min: 1, max: 100 }],
    cfg: ['FLOAT', { default: 7, min: 0, max: 30 }],
  } } },
  SVD_img2vid_Conditioning: { input: { required: {
    video_frames: ['INT', { default: 14, min: 1, max: 25 }],
  } } },
  CogVideoXSampler: { input: { required: {
    steps: ['INT', { default: 50, min: 1, max: 200 }],
    cfg: ['FLOAT', { default: 6, min: 0, max: 30 }],
  } } },
  FramePackSampler: { input: { required: {
    steps: ['INT', { default: 25, min: 1, max: 100 }],
    cfg: ['FLOAT', { default: 1, min: 0, max: 30 }],
    total_second_length: ['FLOAT', { default: 5, min: 0.1, max: 120 }],
  } } },
}

const okJson = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })

beforeEach(() => {
  clearNodeCache() // also clears the capability cache (hooked)
  localFetch.mockReset()
  localFetch.mockResolvedValue(okJson(OBJECT_INFO))
})

describe('getModelCapabilities — real limits from /object_info', () => {
  it('SDXL → KSampler enums + numeric ranges, no frameRange', async () => {
    const c = await getModelCapabilities('my_sdxl_model.safetensors')
    expect(c).toBeTruthy()
    expect(c!.usesKSampler).toBe(true)
    expect(c!.stepsRange).toEqual({ min: 1, max: 100, default: 20 })
    expect(c!.cfgRange).toEqual({ min: 0, max: 30, default: 7 })
    expect(c!.availableSamplers).toEqual(['euler', 'dpmpp_2m', 'uni_pc'])
    expect(c!.availableSchedulers).toEqual(['normal', 'karras'])
    expect(c!.frameRange).toBeUndefined()
  })

  it('SVD → frameRange from SVD_img2vid_Conditioning.video_frames, KSampler for the rest', async () => {
    const c = await getModelCapabilities('svd_xt_1_1.safetensors')
    expect(c!.frameRange).toEqual({ min: 1, max: 25 })
    expect(c!.usesKSampler).toBe(true)
    expect(c!.availableSamplers).toEqual(['euler', 'dpmpp_2m', 'uni_pc'])
  })

  it('FramePack → maxSeconds + frame ceiling from total_second_length, usesKSampler false', async () => {
    const c = await getModelCapabilities('FramePackI2V_HY_fp8.safetensors')
    expect(c!.maxSeconds).toBe(120)
    expect(c!.frameRange).toEqual({ min: 1, max: 1920 }) // 120s × 16fps
    expect(c!.usesKSampler).toBe(false)
    expect(c!.availableSamplers).toBeUndefined() // FramePackSampler exposes no sampler_name enum
  })

  it('CogVideoX → generic KSampler caps now that its lane is gone', async () => {
    // Until 2026-07-24 this asserted caps read off CogVideoXSampler and
    // CogVideoXEmptyLatents, neither of which kijai's wrapper has ever
    // registered. The lane was removed, so a CogVideoX file left on disk still
    // classifies and still shows caps, it just gets the generic KSampler view
    // and is stopped at generate time with an honest message.
    const c = await getModelCapabilities('CogVideoX_5b.safetensors')
    expect(c!.modelType).toBe('cogvideo')
    expect(c!.usesKSampler).toBe(true)
    expect(c!.frameRange).toBeUndefined()
  })

  it('unknown model → PARTIAL caps (KSampler enums), NOT null', async () => {
    const c = await getModelCapabilities('totally_mystery_xyz.safetensors')
    expect(c).toBeTruthy()
    expect(c!.modelType).toBe('unknown')
    expect(c!.usesKSampler).toBe(true)
    expect(c!.availableSamplers).toEqual(['euler', 'dpmpp_2m', 'uni_pc'])
    expect(c!.frameRange).toBeUndefined()
  })

  it('missing SVD node → frameRange soft-falls back to {1,25}', async () => {
    localFetch.mockResolvedValue(okJson({ KSampler: OBJECT_INFO.KSampler }))
    const c = await getModelCapabilities('svd_xt_1_1.safetensors')
    expect(c!.frameRange).toEqual({ min: 1, max: 25 })
  })

  it('caches per model — repeat + new model do not refetch /object_info', async () => {
    await getModelCapabilities('my_sdxl_model.safetensors')
    await getModelCapabilities('my_sdxl_model.safetensors')
    await getModelCapabilities('svd_xt_1_1.safetensors')
    expect(localFetch).toHaveBeenCalledTimes(1)
  })

  it('/object_info unreachable → null (caller proceeds with defaults, no validation)', async () => {
    localFetch.mockReset()
    localFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const c = await getModelCapabilities('my_sdxl_model.safetensors')
    expect(c).toBeNull()
  })
})

describe('clampOrReject / enumReject — reject-and-report (decision 2)', () => {
  it('within range → null', () => {
    expect(clampOrReject('steps', 30, { min: 1, max: 100 })).toBeNull()
  })
  it('over the max → message naming the actual limit', () => {
    const m = clampOrReject('steps', 500, { min: 1, max: 100 })
    expect(m).toContain('exceeds')
    expect(m).toContain('100')
  })
  it('below the min → message naming the minimum', () => {
    const m = clampOrReject('cfg', -3, { min: 0, max: 30 })
    expect(m).toContain('below')
    expect(m).toContain('0')
  })
  it('undefined value OR undefined range → null (only explicit user values are checked)', () => {
    expect(clampOrReject('steps', undefined, { min: 1, max: 100 })).toBeNull()
    expect(clampOrReject('steps', 9999, undefined)).toBeNull()
  })
  it('enumReject: supported → null; unsupported → lists the available options', () => {
    expect(enumReject('sampler', 'euler', ['euler', 'dpmpp_2m'])).toBeNull()
    const m = enumReject('sampler', 'made_up', ['euler', 'dpmpp_2m'])
    expect(m).toContain('not available')
    expect(m).toContain('euler')
  })
  it('enumReject: no value / empty options → null (skip the check)', () => {
    expect(enumReject('sampler', undefined, ['euler'])).toBeNull()
    expect(enumReject('sampler', 'euler', undefined)).toBeNull()
    expect(enumReject('sampler', 'euler', [])).toBeNull()
  })
})

describe('videoFrameReject — only reject the genuinely-impossible (C1 regression guard)', () => {
  const svd: ModelCapabilities = { modelType: 'svd', usesKSampler: true, frameRange: { min: 1, max: 25 } }
  const framepack: ModelCapabilities = { modelType: 'framepack', usesKSampler: false, frameRange: { min: 1, max: 1920 }, maxSeconds: 120 }

  it('caps null → never reject', () => {
    expect(videoFrameReject('m', { seconds: 999 }, null)).toBeNull()
  })

  // The C1 bug: SVD seconds=4 was wrongly rejected even though resolveClip delivers
  // 25f@6fps≈4.2s. Duration requests within maxFrames/4 must NOT reject.
  it('SVD seconds=4 → NULL (resolveClip slows fps to deliver ~4s; do NOT reject)', () => {
    expect(videoFrameReject('svd', { seconds: 4 }, svd)).toBeNull()
  })
  it('SVD seconds=6 → NULL (6 ≤ 25/4 ≈ 6.25s deliverable)', () => {
    expect(videoFrameReject('svd', { seconds: 6 }, svd)).toBeNull()
  })
  it('SVD seconds=60 → reject (beyond ~6s deliverable), names the real limit', () => {
    const m = videoFrameReject('svd', { seconds: 60 }, svd)
    expect(m).toContain('at most')
    expect(m).toContain('25 frames')
  })
  it('SVD explicit frames=99 → reject (exact count over the 25 cap)', () => {
    const m = videoFrameReject('svd', { frames: 99 }, svd)
    expect(m).toContain('99')
    expect(m).toContain('25')
  })
  it('SVD frames=25 (== cap) → null', () => {
    expect(videoFrameReject('svd', { frames: 25 }, svd)).toBeNull()
  })
  it('no frames/seconds → null', () => {
    expect(videoFrameReject('svd', { prompt: 'x' }, svd)).toBeNull()
  })

  // FramePack must honor the original ask (long clips). 7s @ 40fps = 280 frames ≤ 600.
  it('FramePack seconds=7 fps=40 → NULL (the original David ask is deliverable)', () => {
    expect(videoFrameReject('framepack', { seconds: 7, fps: 40 }, framepack)).toBeNull()
  })
  it('FramePack seconds=100 → NULL (within the real 120s total_second_length limit)', () => {
    expect(videoFrameReject('framepack', { seconds: 100 }, framepack)).toBeNull()
  })
  it('FramePack seconds=200 → reject via maxSeconds (real 120s limit)', () => {
    const m = videoFrameReject('framepack', { seconds: 200 }, framepack)
    expect(m).toContain('at most 120s')
  })
  it('FramePack explicit frames=2500 → reject (over the 1920 frame ceiling)', () => {
    const m = videoFrameReject('framepack', { frames: 2500 }, framepack)
    expect(m).toContain('2500')
    expect(m).toContain('1920')
  })
})
