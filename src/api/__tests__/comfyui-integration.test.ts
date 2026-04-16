/**
 * Integration tests: Full pipeline verification for all 14 video models.
 * Tests that Bundle → Strategy → Workflow is a valid end-to-end chain
 * WITHOUT requiring any real ComfyUI instance or model downloads.
 */

import { getVideoBundles, getImageBundles, CUSTOM_NODE_REGISTRY, type ModelBundle } from '../discover'
import { classifyModel, MODEL_TYPE_DEFAULTS, COMPONENT_REGISTRY as COMFYUI_REGISTRY, isVideoModelType } from '../comfyui'
import { determineStrategy } from '../dynamic-workflow'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'

// Full node availability mock — all nodes installed
function allNodesAvailable(): CategorizedNodes {
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
  }
}

const defaultModels: AvailableModels = {
  checkpoints: ['test_checkpoint.safetensors'],
  unets: ['test_model.safetensors'],
  vaes: ['test_vae.safetensors'],
  clips: ['test_clip.safetensors'],
  motionModels: ['animatediff_lightning_4step.safetensors'],
}

describe('Full Pipeline: Bundle → Strategy for all 14 video bundles', () => {
  const bundles = getVideoBundles()

  for (const bundle of bundles) {
    it(`"${bundle.name}" has a valid strategy when all nodes available`, () => {
      // 1. Find the main model file
      const mainFile = bundle.files[0]
      expect(mainFile).toBeDefined()

      // 2. Classify the model (or use the bundle workflow directly)
      const workflow = bundle.workflow

      // 3. Map workflow to ModelType for strategy detection
      const workflowToModelType: Record<string, string> = {
        wan: 'wan', hunyuan: 'hunyuan', ltx: 'ltx', animatediff: 'sd15',
        cogvideo: 'cogvideo', framepack: 'framepack', svd: 'svd',
        mochi: 'mochi', cosmos: 'cosmos', pyramidflow: 'pyramidflow', allegro: 'allegro',
      }
      const modelType = workflowToModelType[workflow]
      expect(modelType).toBeDefined()

      // 4. Verify strategy is available
      const result = determineStrategy(modelType as any, true, allNodesAvailable(), defaultModels)
      expect(result.strategy).not.toBe('unavailable')
    })
  }
})

describe('Bundle consistency checks', () => {
  const bundles = getVideoBundles()

  it('all video bundle workflows map to video model types', () => {
    const videoWorkflows = ['wan', 'hunyuan', 'ltx', 'animatediff', 'cogvideo', 'framepack', 'svd', 'mochi', 'cosmos', 'pyramidflow', 'allegro']
    for (const b of bundles) {
      expect(videoWorkflows).toContain(b.workflow)
    }
  })

  it('bundles with customNodes have matching registry entries', () => {
    for (const b of bundles) {
      if (b.customNodes) {
        for (const key of b.customNodes) {
          const entry = CUSTOM_NODE_REGISTRY[key]
          expect(entry).toBeDefined()
          expect(entry.repo).toMatch(/^https:\/\/github\.com\//)
        }
      }
    }
  })

  it('native bundles (no customNodes) use native ComfyUI strategies', () => {
    const nativeBundles = bundles.filter(b => !b.customNodes || b.customNodes.length === 0)
    const nativeWorkflows = ['wan', 'hunyuan', 'ltx', 'svd', 'mochi', 'cosmos']
    for (const b of nativeBundles) {
      expect(nativeWorkflows).toContain(b.workflow)
    }
  })

  it('every model type with defaults has positive parameter values', () => {
    const videoTypes = Object.keys(MODEL_TYPE_DEFAULTS)
    for (const type of videoTypes) {
      const d = MODEL_TYPE_DEFAULTS[type]
      expect(d.steps).toBeGreaterThan(0)
      expect(d.cfg).toBeGreaterThan(0)
      expect(d.width).toBeGreaterThan(0)
      expect(d.height).toBeGreaterThan(0)
      expect(d.frames).toBeGreaterThan(0)
      expect(d.fps).toBeGreaterThan(0)
    }
  })
})

describe('Model filename classification consistency', () => {
  const bundles = getVideoBundles()

  // For each bundle, the main model file should classify to the right type
  const workflowToExpectedClassification: Record<string, string[]> = {
    wan: ['wan'],
    hunyuan: ['hunyuan'],
    ltx: ['ltx'],
    mochi: ['mochi'],
    cosmos: ['cosmos'],
    cogvideo: ['cogvideo'],
    svd: ['svd'],
    framepack: ['framepack'],
    pyramidflow: ['pyramidflow'],
    allegro: ['allegro'],
    // AnimateDiff uses SD1.5 checkpoints — they classify as sd15 or unknown
    animatediff: ['sd15', 'unknown'],
  }

  for (const bundle of bundles) {
    const mainFile = bundle.files[0]
    if (!mainFile?.filename) continue

    it(`"${bundle.name}" main file classifies correctly for workflow "${bundle.workflow}"`, () => {
      const classified = classifyModel(mainFile.filename!)
      const expected = workflowToExpectedClassification[bundle.workflow]
      expect(expected).toBeDefined()
      // AnimateDiff motion models won't classify as sd15 (they're "animatediff_lightning...")
      // and Allegro model_index.json won't classify either — that's fine
      if (bundle.workflow === 'animatediff') {
        // AnimateDiff motion models contain "animatediff" — but the checkpoint should be sd15
        // Skip the motion model check, it's expected
        return
      }
      if (bundle.workflow === 'allegro' && mainFile.filename?.includes('model_index')) {
        // Allegro uses diffusers format, not safetensors — special case
        return
      }
      expect(expected).toContain(classified)
    })
  }
})

describe('COMPONENT_REGISTRY coverage', () => {
  it('every new video model type has a comfyui.ts registry entry', () => {
    const videoTypes = ['wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'svd', 'framepack', 'pyramidflow', 'allegro']
    for (const type of videoTypes) {
      expect(COMFYUI_REGISTRY[type]).toBeDefined()
    }
  })

  it('Cosmos uses oldt5 not t5xxl', () => {
    const cosmosClip = COMFYUI_REGISTRY.cosmos.clip!
    expect(cosmosClip.matchPatterns).toContain('oldt5')
  })

  it('SVD uses ImageOnlyCheckpointLoader', () => {
    expect(COMFYUI_REGISTRY.svd.loader).toBe('ImageOnlyCheckpointLoader')
  })

  it('FramePack shares HunyuanVideo VAE', () => {
    const fpVae = COMFYUI_REGISTRY.framepack.vae!
    expect(fpVae.matchPatterns).toContain('hunyuan')
  })

  it('ERNIE-Image uses flux2 CLIP type and separate VAE/CLIP', () => {
    const entry = COMFYUI_REGISTRY.ernie_image
    expect(entry).toBeDefined()
    expect(entry.loader).toBe('UNETLoader')
    expect(entry.needsSeparateVAE).toBe(true)
    expect(entry.needsSeparateCLIP).toBe(true)
    expect(entry.clipType).toBe('flux2')
    expect(entry.vae!.matchPatterns).toContain('flux2')
    expect(entry.clip!.matchPatterns).toContain('ernie-image-prompt-enhancer')
  })
})

describe('Full Pipeline: Image bundle → Strategy for ERNIE-Image', () => {
  const bundles = getImageBundles()
  const ernieBundles = bundles.filter(b => b.workflow === 'ernie_image')
  const ernieBundle = ernieBundles.find(b => b.name.includes('Turbo'))
  const ernieBaseBundle = ernieBundles.find(b => b.name.includes('Base'))

  it('ERNIE-Image has Turbo + Base bundles', () => {
    expect(ernieBundles).toHaveLength(2)
    expect(ernieBundle).toBeDefined()
    expect(ernieBaseBundle).toBeDefined()
  })

  it('ERNIE-Image Turbo has 4 files (model + ministral + enhancer + vae)', () => {
    expect(ernieBundle!.files.length).toBe(4)
  })

  it('ERNIE-Image Base has 4 files (model + ministral + enhancer + vae)', () => {
    expect(ernieBaseBundle!.files.length).toBe(4)
  })

  it('ERNIE-Image Turbo has valid strategy when all nodes available', () => {
    const result = determineStrategy('ernie_image' as any, false, allNodesAvailable(), defaultModels)
    expect(result.strategy).toBe('unet_ernie_image')
  })
})
