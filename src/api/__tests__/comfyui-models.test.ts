import {
  classifyModel,
  isVideoModelType,
  isImageModelType,
  MODEL_TYPE_DEFAULTS,
  COMPONENT_REGISTRY,
} from '../comfyui'
import { determineStrategy, type WorkflowStrategy } from '../dynamic-workflow'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'

// ─── classifyModel ───

describe('classifyModel', () => {
  // Existing model types
  it('classifies Wan models', () => {
    expect(classifyModel('wan2.1_t2v_1.3B_bf16.safetensors')).toBe('wan')
    expect(classifyModel('wan2.1_t2v_14B_fp8.safetensors')).toBe('wan')
  })

  it('classifies HunyuanVideo models', () => {
    expect(classifyModel('hunyuanvideo1.5_480p_t2v_fp8.safetensors')).toBe('hunyuan')
  })

  it('classifies LTX models', () => {
    expect(classifyModel('ltx-2.3-22b-distilled-fp8.safetensors')).toBe('ltx')
  })

  it('classifies FLUX models', () => {
    expect(classifyModel('flux1-dev-fp8.safetensors')).toBe('flux')
    expect(classifyModel('flux2-schnell.safetensors')).toBe('flux2')
    expect(classifyModel('flux-2-dev.safetensors')).toBe('flux2')
  })

  it('classifies SDXL models', () => {
    expect(classifyModel('juggernautXL_v9.safetensors')).toBe('sdxl')
    expect(classifyModel('realvisxl_v5.safetensors')).toBe('sdxl')
    expect(classifyModel('sd_xl_base_1.0.safetensors')).toBe('sdxl')
  })

  it('classifies SD 1.5 models', () => {
    expect(classifyModel('realisticVisionV60_v51.safetensors')).toBe('sd15')
    expect(classifyModel('v1-5-pruned.safetensors')).toBe('sd15')
  })

  // New model types
  it('classifies Mochi models', () => {
    expect(classifyModel('mochi_preview_bf16.safetensors')).toBe('mochi')
    expect(classifyModel('mochi_preview_fp8_scaled.safetensors')).toBe('mochi')
  })

  it('classifies Cosmos models', () => {
    expect(classifyModel('Cosmos-1_0-Diffusion-7B-Text2World.safetensors')).toBe('cosmos')
  })

  it('classifies CogVideoX models', () => {
    expect(classifyModel('CogVideoX_2b_bf16.safetensors')).toBe('cogvideo')
    expect(classifyModel('CogVideoX1.5_5b_bf16.safetensors')).toBe('cogvideo')
  })

  it('classifies SVD models', () => {
    expect(classifyModel('svd_xt_1_1.safetensors')).toBe('svd')
    expect(classifyModel('stable-video-diffusion-img2vid-xt.safetensors')).toBe('svd')
  })

  it('classifies FramePack models', () => {
    expect(classifyModel('FramePackI2V_HY_fp8_e4m3fn.safetensors')).toBe('framepack')
  })

  it('classifies Pyramid Flow models', () => {
    expect(classifyModel('pyramid_flow_model.safetensors')).toBe('pyramidflow')
    expect(classifyModel('pyramid-dit-sd3.safetensors')).toBe('pyramidflow')
  })

  it('classifies Allegro models', () => {
    expect(classifyModel('allegro_model.safetensors')).toBe('allegro')
  })

  it('classifies Z-Image models', () => {
    expect(classifyModel('z_image_turbo_bf16.safetensors')).toBe('zimage')
    expect(classifyModel('z_image_bf16.safetensors')).toBe('zimage')
    expect(classifyModel('z-image-turbo.safetensors')).toBe('zimage')
    expect(classifyModel('zimage_base.safetensors')).toBe('zimage')
  })

  it('classifies ERNIE-Image models', () => {
    expect(classifyModel('ernie-image-turbo.safetensors')).toBe('ernie_image')
    expect(classifyModel('ernie_image_turbo_bf16.safetensors')).toBe('ernie_image')
  })

  it('returns unknown for unrecognized models', () => {
    expect(classifyModel('totally_custom_model.safetensors')).toBe('unknown')
  })
})

// ─── isVideoModelType / isImageModelType ───

describe('isVideoModelType', () => {
  const videoTypes = ['wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'svd', 'framepack', 'pyramidflow', 'allegro'] as const
  const imageTypes = ['flux', 'flux2', 'zimage', 'ernie_image', 'sdxl', 'sd15', 'unknown'] as const

  for (const t of videoTypes) {
    it(`${t} is a video model type`, () => {
      expect(isVideoModelType(t)).toBe(true)
      expect(isImageModelType(t)).toBe(false)
    })
  }

  for (const t of imageTypes) {
    it(`${t} is an image model type`, () => {
      expect(isImageModelType(t)).toBe(true)
      expect(isVideoModelType(t)).toBe(false)
    })
  }
})

// ─── MODEL_TYPE_DEFAULTS ───

describe('MODEL_TYPE_DEFAULTS', () => {
  const videoTypes = ['wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'svd', 'framepack', 'pyramidflow', 'allegro', 'animatediff']

  for (const t of videoTypes) {
    it(`${t} has valid defaults`, () => {
      const d = MODEL_TYPE_DEFAULTS[t]
      expect(d).toBeDefined()
      expect(d.steps).toBeGreaterThan(0)
      expect(d.cfg).toBeGreaterThan(0)
      expect(d.sampler).toBeTruthy()
      expect(d.scheduler).toBeTruthy()
      expect(d.width).toBeGreaterThan(0)
      expect(d.height).toBeGreaterThan(0)
      expect(d.frames).toBeGreaterThan(0)
      expect(d.fps).toBeGreaterThan(0)
    })
  }

  it('AnimateDiff Lightning has 4 steps and low CFG', () => {
    const d = MODEL_TYPE_DEFAULTS.animatediff_lightning
    expect(d.steps).toBe(4)
    expect(d.cfg).toBe(1.0)
    expect(d.scheduler).toBe('sgm_uniform')
  })
})

// ─── COMPONENT_REGISTRY ───

describe('COMPONENT_REGISTRY', () => {
  const allTypes = ['sd15', 'sdxl', 'flux', 'flux2', 'zimage', 'ernie_image', 'wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'svd', 'framepack', 'pyramidflow', 'allegro', 'unknown']

  for (const t of allTypes) {
    it(`${t} has a registry entry`, () => {
      const entry = COMPONENT_REGISTRY[t]
      expect(entry).toBeDefined()
      expect(['UNETLoader', 'CheckpointLoaderSimple', 'ImageOnlyCheckpointLoader']).toContain(entry.loader)
      expect(typeof entry.needsSeparateVAE).toBe('boolean')
      expect(typeof entry.needsSeparateCLIP).toBe('boolean')
    })
  }

  it('SVD uses ImageOnlyCheckpointLoader', () => {
    expect(COMPONENT_REGISTRY.svd.loader).toBe('ImageOnlyCheckpointLoader')
  })

  it('types needing separate VAE have vae spec', () => {
    for (const [type, entry] of Object.entries(COMPONENT_REGISTRY)) {
      if (entry.needsSeparateVAE) {
        expect(entry.vae).toBeDefined()
        expect(entry.vae!.matchPatterns.length).toBeGreaterThan(0)
        expect(entry.vae!.downloadFilename).toBeTruthy()
      }
    }
  })

  it('types needing separate CLIP have clip spec', () => {
    for (const [type, entry] of Object.entries(COMPONENT_REGISTRY)) {
      if (entry.needsSeparateCLIP) {
        expect(entry.clip).toBeDefined()
        expect(entry.clip!.matchPatterns.length).toBeGreaterThan(0)
        expect(entry.clip!.downloadFilename).toBeTruthy()
      }
    }
  })

  it('Cosmos clip matches oldt5 not t5xxl', () => {
    const cosmosClip = COMPONENT_REGISTRY.cosmos.clip!
    expect(cosmosClip.matchPatterns).toContain('oldt5')
    expect(cosmosClip.downloadFilename).toContain('oldt5')
  })

  it('Mochi VAE matches mochi', () => {
    const mochiVae = COMPONENT_REGISTRY.mochi.vae!
    expect(mochiVae.matchPatterns).toContain('mochi')
  })

  it('CogVideo VAE matches cogvideox', () => {
    const cogVae = COMPONENT_REGISTRY.cogvideo.vae!
    expect(cogVae.matchPatterns).toContain('cogvideox')
  })
})

// ─── determineStrategy ───

describe('determineStrategy', () => {
  function makeNodes(extras: Partial<CategorizedNodes> = {}): CategorizedNodes {
    return {
      loaders: ['UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader'],
      samplers: ['KSampler'],
      latentInit: ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyHunyuanLatentVideo', 'EmptyLTXVLatentVideo'],
      textEncoders: ['CLIPTextEncode'],
      decoders: ['VAEDecode'],
      savers: ['SaveImage'],
      videoSavers: ['VHS_VideoCombine'],
      motion: [],
      ...extras,
    }
  }

  const emptyModels: AvailableModels = {
    checkpoints: [], unets: ['test_model.safetensors'], vaes: ['test_vae.safetensors'],
    clips: ['test_clip.safetensors'], motionModels: [],
  }

  it('wan → unet_video', () => {
    const r = determineStrategy('wan', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_video')
  })

  it('hunyuan → unet_video', () => {
    const r = determineStrategy('hunyuan', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_video')
  })

  it('ltx → unet_ltx', () => {
    const r = determineStrategy('ltx', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_ltx')
  })

  it('mochi → unet_mochi', () => {
    const r = determineStrategy('mochi', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_mochi')
  })

  it('cosmos → unet_cosmos', () => {
    const r = determineStrategy('cosmos', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_cosmos')
  })

  it('svd → svd (with ImageOnlyCheckpointLoader)', () => {
    const nodes = makeNodes({ loaders: ['UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader', 'ImageOnlyCheckpointLoader'] })
    const r = determineStrategy('svd', true, nodes, emptyModels)
    expect(r.strategy).toBe('svd')
  })

  it('svd → unavailable without ImageOnlyCheckpointLoader', () => {
    const r = determineStrategy('svd', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unavailable')
  })

  it('cogvideo → cogvideo (with wrapper nodes)', () => {
    const nodes = makeNodes({ samplers: ['KSampler', 'CogVideoXSampler'] })
    const r = determineStrategy('cogvideo', true, nodes, emptyModels)
    expect(r.strategy).toBe('cogvideo')
  })

  it('cogvideo → unavailable without wrapper nodes', () => {
    const r = determineStrategy('cogvideo', true, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('CogVideoXWrapper')
  })

  it('framepack → framepack (with wrapper nodes)', () => {
    const nodes = makeNodes({ samplers: ['KSampler', 'FramePackSampler'] })
    const r = determineStrategy('framepack', true, nodes, emptyModels)
    expect(r.strategy).toBe('framepack')
  })

  it('pyramidflow → pyramidflow (with wrapper nodes)', () => {
    const nodes = makeNodes({ samplers: ['KSampler', 'PyramidFlowSampler'] })
    const r = determineStrategy('pyramidflow', true, nodes, emptyModels)
    expect(r.strategy).toBe('pyramidflow')
  })

  it('allegro → allegro (with wrapper nodes)', () => {
    const nodes = makeNodes({ samplers: ['KSampler', 'AllegroSampler'] })
    const r = determineStrategy('allegro', true, nodes, emptyModels)
    expect(r.strategy).toBe('allegro')
  })

  it('sd15 + animatediff + motion models → animatediff', () => {
    const nodes = makeNodes({ motion: ['ADE_LoadAnimateDiffModel', 'ADE_ApplyAnimateDiffModelSimple', 'ADE_UseEvolvedSampling'] })
    const models = { ...emptyModels, motionModels: ['animatediff_lightning_4step.safetensors'] }
    const r = determineStrategy('sd15', true, nodes, models)
    expect(r.strategy).toBe('animatediff')
  })

  it('flux → unet_flux', () => {
    const r = determineStrategy('flux', false, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_flux')
  })

  it('flux2 → unet_flux2', () => {
    const r = determineStrategy('flux2', false, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_flux2')
  })

  it('zimage → unet_zimage', () => {
    const r = determineStrategy('zimage', false, makeNodes(), emptyModels)
    expect(r.strategy).toBe('unet_zimage')
  })

  it('zimage → unavailable without loaders', () => {
    const nodes = makeNodes({ loaders: [] })
    const r = determineStrategy('zimage', false, nodes, emptyModels)
    expect(r.strategy).toBe('unavailable')
  })

  it('sdxl → checkpoint', () => {
    const r = determineStrategy('sdxl', false, makeNodes(), emptyModels)
    expect(r.strategy).toBe('checkpoint')
  })

  it('missing all loaders → unavailable', () => {
    const nodes = makeNodes({ loaders: [] })
    const r = determineStrategy('flux', false, nodes, emptyModels)
    expect(r.strategy).toBe('unavailable')
  })
})
