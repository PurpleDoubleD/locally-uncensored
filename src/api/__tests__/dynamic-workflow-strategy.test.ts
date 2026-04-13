import { describe, it, expect } from 'vitest'
import { determineStrategy } from '../dynamic-workflow'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'
import type { ModelType } from '../comfyui'

// Helpers to build minimal node/model fixtures

function makeNodes(overrides: Partial<CategorizedNodes> = {}): CategorizedNodes {
  return {
    loaders: ['CheckpointLoaderSimple', 'UNETLoader', 'VAELoader', 'CLIPLoader', 'ImageOnlyCheckpointLoader'],
    samplers: ['KSampler', 'KSamplerAdvanced', 'CogVideoXSampler', 'FramePackSampler', 'PyramidFlowSampler', 'AllegroSampler'],
    latentInit: ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage', 'EmptyHunyuanLatentVideo'],
    textEncoders: ['CLIPTextEncode'],
    decoders: ['VAEDecode'],
    savers: ['SaveImage'],
    videoSavers: ['SaveAnimatedWEBP'],
    motion: ['ADE_LoadAnimateDiffModel'],
    ...overrides,
  }
}

function makeModels(overrides: Partial<AvailableModels> = {}): AvailableModels {
  return {
    checkpoints: ['model.safetensors'],
    unets: ['flux1-schnell.safetensors'],
    vaes: ['ae.safetensors'],
    clips: ['clip_l.safetensors'],
    motionModels: ['v3_sd15_mm.ckpt'],
    ...overrides,
  }
}

describe('dynamic-workflow — determineStrategy', () => {
  // ─── FLUX variants ───

  describe('FLUX strategies', () => {
    it('flux model -> unet_flux strategy', () => {
      const result = determineStrategy('flux', false, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_flux')
    })

    it('flux2 model -> unet_flux2 strategy', () => {
      const result = determineStrategy('flux2', false, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_flux2')
    })

    it('zimage model -> unet_zimage strategy', () => {
      const result = determineStrategy('zimage', false, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_zimage')
    })
  })

  // ─── Checkpoint variants ───

  describe('checkpoint strategies', () => {
    it('sdxl model -> checkpoint strategy', () => {
      const result = determineStrategy('sdxl', false, makeNodes(), makeModels())
      expect(result.strategy).toBe('checkpoint')
    })

    it('sd15 model -> checkpoint strategy', () => {
      const result = determineStrategy('sd15', false, makeNodes(), makeModels())
      expect(result.strategy).toBe('checkpoint')
    })
  })

  // ─── Video strategies ───

  describe('video strategies', () => {
    it('wan model -> unet_video strategy', () => {
      const result = determineStrategy('wan', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_video')
    })

    it('hunyuan model -> unet_video strategy', () => {
      const result = determineStrategy('hunyuan', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_video')
    })

    it('ltx model -> unet_ltx strategy', () => {
      const result = determineStrategy('ltx', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_ltx')
    })

    it('mochi model -> unet_mochi (native) with UNET nodes', () => {
      const result = determineStrategy('mochi', true, makeNodes(), makeModels())
      // mochi maps to unet_mochi when UNETLoader + CLIPLoader + VAELoader present
      // but the function first checks for specific model types
      expect(result.strategy).toMatch(/unet_mochi/)
    })

    it('cosmos model -> unet_cosmos strategy', () => {
      const result = determineStrategy('cosmos', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('unet_cosmos')
    })

    it('svd model -> svd strategy', () => {
      const result = determineStrategy('svd', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('svd')
    })

    it('cogvideo model -> cogvideo strategy', () => {
      const result = determineStrategy('cogvideo', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('cogvideo')
    })

    it('framepack model -> framepack strategy', () => {
      const result = determineStrategy('framepack', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('framepack')
    })

    it('pyramidflow model -> pyramidflow strategy', () => {
      const result = determineStrategy('pyramidflow', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('pyramidflow')
    })

    it('allegro model -> allegro strategy', () => {
      const result = determineStrategy('allegro', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('allegro')
    })

    it('animatediff: sdxl + video + motion models -> animatediff', () => {
      const result = determineStrategy('sdxl', true, makeNodes(), makeModels())
      expect(result.strategy).toBe('animatediff')
    })
  })

  // ─── Fallback / unavailable ───

  describe('fallback and unavailable', () => {
    it('unknown model type with checkpoint -> checkpoint strategy', () => {
      const result = determineStrategy('unknown' as ModelType, false, makeNodes(), makeModels())
      expect(result.strategy).toBe('checkpoint')
    })

    it('unknown video without animatediff nodes -> checkpoint fallback', () => {
      const nodes = makeNodes({ motion: [] })
      const models = makeModels({ motionModels: [] })
      const result = determineStrategy('unknown' as ModelType, true, nodes, models)
      expect(result.strategy).toBe('checkpoint')
    })

    it('flux without UNETLoader -> unavailable', () => {
      const nodes = makeNodes({ loaders: ['CheckpointLoaderSimple'] })
      const result = determineStrategy('flux', false, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('zimage without CLIPLoader -> unavailable', () => {
      const nodes = makeNodes({ loaders: ['UNETLoader', 'VAELoader'] })
      const result = determineStrategy('zimage', false, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('cogvideo without CogVideoXSampler -> unavailable', () => {
      const nodes = makeNodes({ samplers: ['KSampler'] })
      const result = determineStrategy('cogvideo', true, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('framepack without FramePackSampler -> unavailable', () => {
      const nodes = makeNodes({ samplers: ['KSampler'] })
      const result = determineStrategy('framepack', true, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('pyramidflow without PyramidFlowSampler -> unavailable', () => {
      const nodes = makeNodes({ samplers: ['KSampler'] })
      const result = determineStrategy('pyramidflow', true, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('allegro without AllegroSampler -> unavailable', () => {
      const nodes = makeNodes({ samplers: ['KSampler'] })
      const result = determineStrategy('allegro', true, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('svd without ImageOnlyCheckpointLoader -> unavailable', () => {
      const nodes = makeNodes({ loaders: ['CheckpointLoaderSimple', 'UNETLoader'] })
      const result = determineStrategy('svd', true, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('no loaders at all -> unavailable', () => {
      const nodes = makeNodes({ loaders: [], motion: [] })
      const models = makeModels({ motionModels: [] })
      const result = determineStrategy('unknown' as ModelType, false, nodes, models)
      expect(result.strategy).toBe('unavailable')
    })

    it('wan without VAELoader -> unavailable', () => {
      const nodes = makeNodes({ loaders: ['UNETLoader', 'CLIPLoader'] })
      const result = determineStrategy('wan', true, nodes, makeModels())
      expect(result.strategy).toBe('unavailable')
    })

    it('ltx needs only UNETLoader + CLIPLoader (no VAE required)', () => {
      const nodes = makeNodes({ loaders: ['UNETLoader', 'CLIPLoader'] })
      const result = determineStrategy('ltx', true, nodes, makeModels())
      expect(result.strategy).toBe('unet_ltx')
    })
  })

  // ─── Reason strings ───

  describe('reason strings', () => {
    it('includes a reason string for every result', () => {
      const types: ModelType[] = ['flux', 'flux2', 'zimage', 'sdxl', 'sd15', 'wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'svd', 'cogvideo', 'framepack', 'pyramidflow', 'allegro', 'unknown']
      for (const t of types) {
        const result = determineStrategy(t, false, makeNodes(), makeModels())
        expect(typeof result.reason).toBe('string')
        expect(result.reason.length).toBeGreaterThan(0)
      }
    })

    it('unavailable result has a descriptive reason', () => {
      const nodes = makeNodes({ loaders: [], motion: [] })
      const models = makeModels({ motionModels: [] })
      const result = determineStrategy('unknown' as ModelType, false, nodes, models)
      expect(result.reason.toLowerCase()).toContain('no compatible')
    })
  })
})
