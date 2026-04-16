import { determineStrategy, type WorkflowStrategy } from '../dynamic-workflow'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'
import type { ModelType } from '../comfyui'

// ─── Helper: build mock CategorizedNodes with all nodes available ───

function makeFullNodes(extras: Partial<CategorizedNodes> = {}): CategorizedNodes {
  return {
    loaders: [
      'UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader',
      'ImageOnlyCheckpointLoader', 'CLIPVisionLoader', 'LoadImage',
      'CogVideoXModelLoader', 'CogVideoXCLIPLoader',
      'LoadFramePackModel', 'DownloadAndLoadFramePackModel',
      'PyramidFlowModelLoader', 'PyramidFlowVAELoader',
      'AllegroModelLoader',
    ],
    samplers: [
      'KSampler', 'KSamplerAdvanced',
      'CogVideoXSampler', 'FramePackSampler', 'PyramidFlowSampler', 'AllegroSampler',
    ],
    latentInit: [
      'EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage',
      'EmptyHunyuanLatentVideo', 'EmptyLTXVLatentVideo',
      'EmptyMochiLatentVideo', 'EmptyCosmosLatentVideo',
      'CogVideoXEmptyLatents',
    ],
    textEncoders: ['CLIPTextEncode', 'CogVideoXTextEncode', 'PyramidFlowTextEncode', 'AllegroTextEncode'],
    decoders: ['VAEDecode', 'CogVideoXVAEDecode', 'PyramidFlowDecode', 'AllegroDecoder'],
    savers: ['SaveImage'],
    videoSavers: ['VHS_VideoCombine', 'SaveAnimatedWEBP'],
    motion: ['ADE_LoadAnimateDiffModel', 'ADE_ApplyAnimateDiffModelSimple', 'ADE_UseEvolvedSampling', 'SVD_img2vid_Conditioning', 'VideoLinearCFGGuidance'],
    ...extras,
  }
}

const defaultModels: AvailableModels = {
  checkpoints: ['test_checkpoint.safetensors'],
  unets: ['test_model.safetensors'],
  vaes: ['test_vae.safetensors'],
  clips: ['test_clip.safetensors'],
  motionModels: ['animatediff_lightning_4step.safetensors'],
}

// ─── Strategy mapping tests ───

describe('determineStrategy — all 15 model types', () => {
  const strategyMap: [ModelType, WorkflowStrategy][] = [
    ['wan', 'unet_video'],
    ['hunyuan', 'unet_video'],
    ['ltx', 'unet_ltx'],
    ['mochi', 'unet_mochi'],
    ['cosmos', 'unet_cosmos'],
    ['svd', 'svd'],
    ['cogvideo', 'cogvideo'],
    ['framepack', 'framepack'],
    ['pyramidflow', 'pyramidflow'],
    ['allegro', 'allegro'],
    ['flux', 'unet_flux'],
    ['flux2', 'unet_flux2'],
    ['zimage', 'unet_zimage'],
    ['ernie_image', 'unet_ernie_image'],
  ]

  for (const [modelType, expectedStrategy] of strategyMap) {
    it(`${modelType} → ${expectedStrategy}`, () => {
      const r = determineStrategy(modelType, true, makeFullNodes(), defaultModels)
      expect(r.strategy).toBe(expectedStrategy)
    })
  }

  it('sd15 video + animatediff → animatediff', () => {
    const r = determineStrategy('sd15', true, makeFullNodes(), defaultModels)
    expect(r.strategy).toBe('animatediff')
  })

  it('sdxl image → checkpoint', () => {
    const r = determineStrategy('sdxl', false, makeFullNodes(), defaultModels)
    expect(r.strategy).toBe('checkpoint')
  })
})

// ─── Strategy unavailability tests ───

describe('determineStrategy — missing nodes', () => {
  const minimalNodes: CategorizedNodes = {
    loaders: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CheckpointLoaderSimple'],
    samplers: ['KSampler'],
    latentInit: ['EmptyLatentImage'],
    textEncoders: ['CLIPTextEncode'],
    decoders: ['VAEDecode'],
    savers: ['SaveImage'],
    videoSavers: [],
    motion: [],
  }

  it('cogvideo without CogVideoXSampler → unavailable', () => {
    const r = determineStrategy('cogvideo', true, minimalNodes, defaultModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('CogVideoXWrapper')
  })

  it('framepack without FramePackSampler → unavailable', () => {
    const r = determineStrategy('framepack', true, minimalNodes, defaultModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('FramePackWrapper')
  })

  it('svd without ImageOnlyCheckpointLoader → unavailable', () => {
    const r = determineStrategy('svd', true, minimalNodes, defaultModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('ImageOnlyCheckpointLoader')
  })

  it('allegro without AllegroSampler → unavailable', () => {
    const r = determineStrategy('allegro', true, minimalNodes, defaultModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('ComfyUI-Allegro')
  })

  it('pyramidflow without PyramidFlowSampler → unavailable', () => {
    const r = determineStrategy('pyramidflow', true, minimalNodes, defaultModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('PyramidFlowWrapper')
  })
})

// ─── Workflow type coverage ───

describe('Every video bundle workflow type has a strategy', () => {
  // These are all the workflow types used in getVideoBundles()
  const workflowTypes: [string, ModelType][] = [
    ['wan', 'wan'],
    ['hunyuan', 'hunyuan'],
    ['ltx', 'ltx'],
    ['animatediff', 'sd15'],
    ['cogvideo', 'cogvideo'],
    ['framepack', 'framepack'],
    ['svd', 'svd'],
    ['mochi', 'mochi'],
    ['pyramidflow', 'pyramidflow'],
    ['allegro', 'allegro'],
    ['cosmos', 'cosmos'],
  ]

  for (const [workflow, modelType] of workflowTypes) {
    it(`workflow "${workflow}" maps to a valid strategy for ${modelType}`, () => {
      const r = determineStrategy(modelType, true, makeFullNodes(), defaultModels)
      expect(r.strategy).not.toBe('unavailable')
    })
  }
})
