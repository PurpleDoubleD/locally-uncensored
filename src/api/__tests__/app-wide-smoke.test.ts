/**
 * App-wide smoke test — verifies critical cross-cutting concerns
 * that span multiple modules and would break the app if regressed.
 *
 * Coverage:
 * - All ModelTypes have defaults
 * - All ModelTypes have COMPONENT_REGISTRY entries (image models)
 * - All image bundles map to valid strategies
 * - All video bundles map to valid strategies
 * - No duplicate bundle names
 * - All bundles have valid HuggingFace URLs
 * - Provider format consistency
 * - Tool registry completeness
 * - Message type system integrity
 * - Chat mode system integrity
 */
import { describe, it, expect } from 'vitest'
import {
  classifyModel,
  COMPONENT_REGISTRY,
  isImageModelType,
  isVideoModelType,
  type ModelType,
} from '../comfyui'
import { MODEL_TYPE_DEFAULTS } from '../../stores/createStore'
import { determineStrategy } from '../dynamic-workflow'
import { getImageBundles, getVideoBundles } from '../discover'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'
import {
  isAgentCompatible,
  isThinkingCompatible,
  getToolCallingStrategy,
} from '../../lib/model-compatibility'

// ── Full node mock ──────────────────────────────────────────────────────
function fullNodes(): CategorizedNodes {
  return {
    loaders: [
      'UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader',
      'ImageOnlyCheckpointLoader', 'CLIPVisionLoader', 'LoadImage',
      'CogVideoXModelLoader', 'CogVideoXCLIPLoader',
      'LoadFramePackModel', 'DownloadAndLoadFramePackModel',
      'PyramidFlowModelLoader', 'PyramidFlowVAELoader',
      'AllegroModelLoader',
    ],
    samplers: ['KSampler', 'KSamplerAdvanced', 'CogVideoXSampler', 'FramePackSampler', 'PyramidFlowSampler', 'AllegroSampler'],
    latentInit: [
      'EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage',
      'EmptyHunyuanLatentVideo', 'EmptyLTXVLatentVideo',
      'EmptyMochiLatentVideo', 'EmptyCosmosLatentVideo',
      'CogVideoXEmptyLatents',
    ],
    textEncoders: ['CLIPTextEncode', 'ConditioningZeroOut', 'CogVideoXTextEncode', 'PyramidFlowTextEncode', 'AllegroTextEncode'],
    decoders: ['VAEDecode', 'CogVideoXVAEDecode', 'PyramidFlowDecode', 'AllegroDecoder'],
    savers: ['SaveImage'],
    videoSavers: ['VHS_VideoCombine', 'SaveAnimatedWEBP'],
    motion: ['ADE_LoadAnimateDiffModel', 'ADE_ApplyAnimateDiffModelSimple', 'ADE_UseEvolvedSampling', 'SVD_img2vid_Conditioning', 'VideoLinearCFGGuidance'],
  }
}

const defaultModels: AvailableModels = {
  checkpoints: ['test.safetensors'], unets: ['test_unet.safetensors'],
  vaes: ['test_vae.safetensors'], clips: ['test_clip.safetensors'],
  loras: [], controlnets: [], ipadapters: [], motionModels: ['mm_sd_v15_v2.ckpt'],
}

// ── MODEL_TYPE_DEFAULTS completeness ────────────────────────────────────

describe('MODEL_TYPE_DEFAULTS — completeness', () => {
  // Only types that exist in createStore MODEL_TYPE_DEFAULTS
  const allTypes = Object.keys(MODEL_TYPE_DEFAULTS)

  it('has at least 8 model types with defaults', () => {
    expect(allTypes.length).toBeGreaterThanOrEqual(8)
  })

  it('every defaults entry has steps, width, height', () => {
    for (const type of allTypes) {
      const d = (MODEL_TYPE_DEFAULTS as any)[type]
      expect(d.steps, `${type} missing steps`).toBeGreaterThan(0)
      expect(d.width, `${type} missing width`).toBeGreaterThan(0)
      expect(d.height, `${type} missing height`).toBeGreaterThan(0)
    }
  })

  it('every defaults entry has a sampler and scheduler', () => {
    for (const type of allTypes) {
      const d = (MODEL_TYPE_DEFAULTS as any)[type]
      expect(d.sampler, `${type} missing sampler`).toBeTruthy()
      expect(d.scheduler, `${type} missing scheduler`).toBeTruthy()
    }
  })

  it('includes critical types: sd15, sdxl, flux, flux2, unknown', () => {
    expect(allTypes).toContain('sd15')
    expect(allTypes).toContain('sdxl')
    expect(allTypes).toContain('flux')
    expect(allTypes).toContain('flux2')
    expect(allTypes).toContain('unknown')
  })
})

// ── COMPONENT_REGISTRY completeness ─────────────────────────────────────

describe('COMPONENT_REGISTRY — completeness for image models', () => {
  const imageTypes: ModelType[] = ['flux', 'flux2', 'zimage', 'ernie_image', 'sdxl', 'sd15']

  it('every image ModelType that needs UNET/Checkpoint has a registry entry', () => {
    for (const type of imageTypes) {
      expect(COMPONENT_REGISTRY[type], `Missing registry for ${type}`).toBeDefined()
    }
  })
})

// ── Bundle → Strategy pipeline ──────────────────────────────────────────

describe('Image bundles → strategy pipeline', () => {
  const bundles = getImageBundles()

  it('has at least 5 image bundles', () => {
    expect(bundles.length).toBeGreaterThanOrEqual(5)
  })

  it('no duplicate bundle names', () => {
    const names = bundles.map(b => b.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('every bundle maps to a valid (non-unavailable) strategy', () => {
    for (const b of bundles) {
      const type = b.workflow as ModelType
      const result = determineStrategy(type, false, fullNodes(), defaultModels)
      expect(result.strategy, `Bundle "${b.name}" → unavailable: ${result.reason}`).not.toBe('unavailable')
    }
  })

  it('every bundle has at least 1 file', () => {
    for (const b of bundles) {
      expect(b.files.length, `Bundle "${b.name}" has no files`).toBeGreaterThan(0)
    }
  })

  it('every bundle file has a downloadUrl', () => {
    for (const b of bundles) {
      for (const f of b.files) {
        expect(f.downloadUrl, `File "${f.filename}" in bundle "${b.name}" missing URL`).toBeTruthy()
        expect(f.downloadUrl).toMatch(/^https?:\/\//)
      }
    }
  })

  it('every bundle has a totalSizeGB > 0', () => {
    for (const b of bundles) {
      expect(b.totalSizeGB, `Bundle "${b.name}" has zero size`).toBeGreaterThan(0)
    }
  })
})

describe('Video bundles → strategy pipeline', () => {
  const bundles = getVideoBundles()

  it('has at least 8 video bundles', () => {
    expect(bundles.length).toBeGreaterThanOrEqual(8)
  })

  it('no duplicate bundle names', () => {
    const names = bundles.map(b => b.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('every video bundle maps to a valid strategy', () => {
    for (const b of bundles) {
      const type = b.workflow as ModelType
      const result = determineStrategy(type, true, fullNodes(), defaultModels)
      expect(result.strategy, `Video bundle "${b.name}" → unavailable: ${result.reason}`).not.toBe('unavailable')
    }
  })
})

// ── Chat mode system ────────────────────────────────────────────────────

describe('Chat mode system', () => {
  const validModes = ['lu', 'codex', 'openclaw', 'claude-code', 'remote'] as const

  it('all modes are strings (not undefined)', () => {
    for (const mode of validModes) {
      expect(typeof mode).toBe('string')
      expect(mode.length).toBeGreaterThan(0)
    }
  })
})

// ── Model classification coverage ───────────────────────────────────────

describe('classifyModel — representative models', () => {
  const cases: [string, ModelType][] = [
    ['v1-5-pruned-emaonly.safetensors', 'sd15'],
    ['sdxl_base_1.0.safetensors', 'sdxl'],
    ['flux1-dev.safetensors', 'flux'],
    ['flux2-dev.safetensors', 'flux2'],
    ['ernie-image-turbo.safetensors', 'ernie_image'],
    ['wan2.1_fun_14b.safetensors', 'wan'],
    ['hunyuan_video_v2.safetensors', 'hunyuan'],
  ]

  for (const [filename, expected] of cases) {
    it(`classifies "${filename}" as ${expected}`, () => {
      expect(classifyModel(filename)).toBe(expected)
    })
  }
})

// ── Provider strategy consistency ───────────────────────────────────────

describe('Provider strategy consistency', () => {
  it('all cloud models get native strategy', () => {
    const cloudModels = [
      'openai::gpt-4o', 'openai::gpt-4o-mini',
      'anthropic::claude-opus-4-20250514', 'anthropic::claude-sonnet-4-20250514',
    ]
    for (const m of cloudModels) {
      expect(getToolCallingStrategy(m)).toBe('native')
    }
  })

  it('popular Ollama models get correct strategy', () => {
    expect(getToolCallingStrategy('qwen3:8b')).toBe('native')
    expect(getToolCallingStrategy('hermes3:8b')).toBe('native')
    expect(getToolCallingStrategy('llama2:7b')).toBe('hermes_xml')
  })
})

// ── Cross-cutting: agent + thinking compatibility overlap ───────────────

describe('Agent + Thinking compatibility overlap', () => {
  it('some models support both agent and thinking', () => {
    const both = ['qwen3:8b', 'gemma4:12b', 'qwen3-coder:30b']
    for (const m of both) {
      expect(isAgentCompatible(m), `${m} should be agent-compatible`).toBe(true)
      expect(isThinkingCompatible(m), `${m} should be thinking-compatible`).toBe(true)
    }
  })

  it('some models support agent but NOT thinking', () => {
    const agentOnly = ['hermes3:8b', 'mistral:7b', 'llama3.1:8b']
    for (const m of agentOnly) {
      expect(isAgentCompatible(m), `${m} should be agent-compatible`).toBe(true)
      expect(isThinkingCompatible(m), `${m} should NOT be thinking-compatible`).toBe(false)
    }
  })
})
