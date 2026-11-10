// Local Enhance Image (3.0.7): the pure rules the Composer, the submit and the
// graph builder share.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_UPSCALE_FACTOR, STARTER_UPSCALE_MODEL, UPSCALE_MAX_SIDE,
  localUpscaleReady, nativeUpscaleScale, normalizeUpscaleFactor, pickUpscaleModel,
  upscaleTarget, upscaleToolLabel, upscaleTooLargeLine,
} from '../local-upscale'
import { phaseForExecutingNode, phaseForProgressStep } from '../render-phase-labels'

describe('the scale an upscale model is trained for, from its name', () => {
  it.each([
    ['RealESRGAN_x4plus.safetensors', 4],
    ['RealESRGAN_x2plus.pth', 2],
    ['4x-UltraSharp.pth', 4],
    ['4x_NMKD-Siax_200k.pth', 4],
    ['ESRGAN_4x.pth', 4],
    ['realesr-general-x4v3.pth', 4],
    ['1x-ITF-SkinDiffDetail.pth', 1],
    ['2x-AnimeSharpV4_RCAN.safetensors', 2],
    ['sub/dir/8x_NMKD-Superscale.pt', 8],
  ])('%s is %ix', (name, scale) => {
    expect(nativeUpscaleScale(name)).toBe(scale)
  })

  it.each(['SwinIR.pth', 'my-upscaler.safetensors', 'model_v4.pth', 'xenon.pth'])('%s says nothing', (name) => {
    expect(nativeUpscaleScale(name)).toBeNull()
  })
})

describe('the factor', () => {
  it('defaults to 2x and takes 1x to 8x on a grid of 0.05 (Discord 08.11.)', () => {
    expect(DEFAULT_UPSCALE_FACTOR).toBe(2)
    expect([4, 3, 8, 1.5, 1.23, 0.5, 12].map(normalizeUpscaleFactor)).toEqual([4, 3, 8, 1.5, 1.25, 1, 8])
    for (const v of ['4', null, undefined, NaN]) expect(normalizeUpscaleFactor(v)).toBe(2)
  })

  it('the result is the source times the factor, per side', () => {
    expect(upscaleTarget(640, 480, 2)).toEqual({ width: 1280, height: 960 })
    expect(upscaleTarget(640, 480, 4)).toEqual({ width: 2560, height: 1920 })
  })

  it('a result past the longest side is refused with a sentence that names a way out', () => {
    expect(upscaleTooLargeLine(2048, 1536, 4)).toBeNull()
    expect(upscaleTooLargeLine(UPSCALE_MAX_SIDE / 2, 100, 2)).toBeNull()
    expect(upscaleTooLargeLine(3000, 2000, 4)).toMatch(/^At 4x .*12000×8000.*Pick a smaller size or a smaller image\.$/)
    expect(upscaleTooLargeLine(5000, 3000, 2)).toMatch(/10000×6000.*Pick a smaller size/)
  })
})

describe('which model a run takes', () => {
  it('the starter file when it is listed, else the first', () => {
    expect(pickUpscaleModel(['4x-UltraSharp.pth', STARTER_UPSCALE_MODEL])).toBe(STARTER_UPSCALE_MODEL)
    expect(pickUpscaleModel(['4x-UltraSharp.pth', 'other.pth'])).toBe('4x-UltraSharp.pth')
    expect(pickUpscaleModel([`sub${'/'}${STARTER_UPSCALE_MODEL}`, 'a.pth'])).toBe(`sub/${STARTER_UPSCALE_MODEL}`)
    expect(pickUpscaleModel([])).toBeNull()
  })

  it('the result line names the file without its extension', () => {
    expect(upscaleToolLabel('RealESRGAN_x4plus.safetensors')).toBe('RealESRGAN_x4plus')
    expect(upscaleToolLabel('sub\\4x-UltraSharp.pth')).toBe('4x-UltraSharp')
  })
})

describe('Composer readiness', () => {
  it('local Enhance waits for an upscale model', () => {
    expect(localUpscaleReady({ backend: 'local', intent: 'upscale', upscaleModelCount: 0 })).toBe(false)
    expect(localUpscaleReady({ backend: 'local', intent: 'upscale', upscaleModelCount: 1 })).toBe(true)
  })

  it('the cloud and every other tab never wait on it', () => {
    expect(localUpscaleReady({ backend: 'cloud', intent: 'upscale', upscaleModelCount: 0 })).toBe(true)
    expect(localUpscaleReady({ backend: 'local', intent: 'removebg', upscaleModelCount: 0 })).toBe(true)
    expect(localUpscaleReady({ backend: 'local', intent: 'image', upscaleModelCount: 0 })).toBe(true)
  })
})

describe('the waiting line of an Enhance run', () => {
  it('names the step, and counts parts instead of sampler steps', () => {
    expect(phaseForExecutingNode('UpscaleModelLoader', 'image')?.label).toBe('Loading model...')
    expect(phaseForExecutingNode('ImageUpscaleWithModel', 'image')).toEqual({ phase: 'sampling', pct: 40, label: 'Enhancing the image...' })
    expect(phaseForProgressStep(3, 12, 'sampling', true)?.label).toBe('Enhancing part 3 of 12...')
    expect(phaseForProgressStep(3, 12, 'sampling')?.label).toBe('Sampling step 3/12...')
  })
})
