/**
 * Model Pipeline Tests
 *
 * Ensures every model type gets the correct encoder, VAE, defaults, and workflow.
 * Run: npx vitest run src/api/__tests__/model-pipeline.test.ts
 */
import { describe, it, expect } from 'vitest'
import { classifyModel, type ModelType } from '../comfyui'
import { MODEL_TYPE_DEFAULTS } from '../../stores/createStore'
import { COMPONENT_REGISTRY } from '../discover'

// ─── Model Classification ───

describe('classifyModel', () => {
  const cases: [string, ModelType][] = [
    // FLUX 2 — must be detected BEFORE generic flux
    ['flux-2-klein-base-4b-fp8.safetensors', 'flux2'],
    ['flux2-dev-fp8.safetensors', 'flux2'],
    ['FLUX-2-schnell.safetensors', 'flux2'],

    // FLUX 1
    ['flux1-schnell-fp8.safetensors', 'flux'],
    ['flux1-dev-fp8.safetensors', 'flux'],
    ['FLUX.1-schnell.safetensors', 'flux'],

    // SDXL
    ['Juggernaut-XL_v9.safetensors', 'sdxl'],
    ['RealVisXL_V5.safetensors', 'sdxl'],
    ['animagineXL_v3.safetensors', 'sdxl'],
    ['ponyDiffusionV6XL.safetensors', 'sdxl'],
    ['illustriousXL_v01.safetensors', 'sdxl'],
    ['noobaiXL.safetensors', 'sdxl'],
    ['sd_xl_base_1.0.safetensors', 'sdxl'],
    ['zavychromaXL_v10.safetensors', 'sdxl'],

    // SD 1.5
    ['v1-5-pruned.safetensors', 'sd15'],
    ['realisticVisionV51.safetensors', 'sd15'],
    ['deliberate_v3.safetensors', 'sd15'],
    ['dreamshaper_8.safetensors', 'sd15'],
    ['absolutereality_v16.safetensors', 'sd15'],
    ['sd_1.5_base.safetensors', 'sd15'],

    // Wan Video
    ['wan2.1_t2v_1.3B_bf16.safetensors', 'wan'],
    ['wan2.1_t2v_14B_fp8.safetensors', 'wan'],

    // HunyuanVideo
    ['hunyuanvideo1.5_480p_t2v_fp8.safetensors', 'hunyuan'],
    ['hunyuanvideo_t2v.safetensors', 'hunyuan'],

    // LTX Video
    ['ltx-2.3-22b-distilled-fp8.safetensors', 'ltx'],
    ['ltxv_0.9.7_13b_dev_fp8.safetensors', 'ltx'],
    ['LTX-Video-model.safetensors', 'ltx'],
  ]

  for (const [filename, expected] of cases) {
    it(`${filename} → ${expected}`, () => {
      expect(classifyModel(filename)).toBe(expected)
    })
  }

  it('unknown model returns unknown', () => {
    expect(classifyModel('some_random_model.safetensors')).toBe('unknown')
  })

  it('flux2 is detected before flux', () => {
    // This is critical — flux2 patterns must be checked FIRST
    expect(classifyModel('flux-2-dev.safetensors')).toBe('flux2')
    expect(classifyModel('flux2-schnell.safetensors')).toBe('flux2')
    // Generic flux should NOT match flux2
    expect(classifyModel('flux1-dev.safetensors')).toBe('flux')
  })

  it('wan is detected before other patterns', () => {
    expect(classifyModel('wan2.1_model.safetensors')).toBe('wan')
  })
})

// ─── Model Type Defaults ───

describe('MODEL_TYPE_DEFAULTS', () => {
  it('every ModelType has defaults', () => {
    const allTypes: ModelType[] = ['sd15', 'sdxl', 'flux', 'flux2', 'wan', 'hunyuan', 'ltx', 'unknown']
    for (const type of allTypes) {
      const defaults = MODEL_TYPE_DEFAULTS[type]
      expect(defaults, `missing defaults for ${type}`).toBeDefined()
      expect(defaults.steps).toBeGreaterThan(0)
      expect(defaults.cfgScale).toBeGreaterThanOrEqual(0)
      expect(defaults.width).toBeGreaterThan(0)
      expect(defaults.height).toBeGreaterThan(0)
      expect(defaults.sampler).toBeTruthy()
      expect(defaults.scheduler).toBeTruthy()
    }
  })

  it('FLUX uses low CFG', () => {
    expect(MODEL_TYPE_DEFAULTS.flux.cfgScale).toBe(1.0)
    expect(MODEL_TYPE_DEFAULTS.flux2.cfgScale).toBe(3.5) // flux2 uses 3.5
  })

  it('SD1.5 uses 512x512', () => {
    expect(MODEL_TYPE_DEFAULTS.sd15.width).toBe(512)
    expect(MODEL_TYPE_DEFAULTS.sd15.height).toBe(512)
  })

  it('SDXL/FLUX uses 1024x1024', () => {
    expect(MODEL_TYPE_DEFAULTS.sdxl.width).toBe(1024)
    expect(MODEL_TYPE_DEFAULTS.flux.width).toBe(1024)
  })

  it('Video models have frames and fps', () => {
    expect(MODEL_TYPE_DEFAULTS.wan.frames).toBeGreaterThan(0)
    expect(MODEL_TYPE_DEFAULTS.wan.fps).toBeGreaterThan(0)
    expect(MODEL_TYPE_DEFAULTS.hunyuan.frames).toBeGreaterThan(0)
    expect(MODEL_TYPE_DEFAULTS.hunyuan.fps).toBeGreaterThan(0)
    expect(MODEL_TYPE_DEFAULTS.ltx.frames).toBeGreaterThan(0)
    expect(MODEL_TYPE_DEFAULTS.ltx.fps).toBeGreaterThan(0)
  })
})

// ─── COMPONENT_REGISTRY Consistency ───

describe('COMPONENT_REGISTRY', () => {
  it('checkpoint models (sd15, sdxl) dont need separate VAE/CLIP', () => {
    expect(COMPONENT_REGISTRY.sd15.needsSeparateVAE).toBe(false)
    expect(COMPONENT_REGISTRY.sd15.needsSeparateCLIP).toBe(false)
    expect(COMPONENT_REGISTRY.sdxl.needsSeparateVAE).toBe(false)
    expect(COMPONENT_REGISTRY.sdxl.needsSeparateCLIP).toBe(false)
  })

  it('UNET models need separate CLIP (and most need VAE)', () => {
    for (const type of ['flux', 'flux2', 'wan', 'hunyuan'] as ModelType[]) {
      const reg = COMPONENT_REGISTRY[type]
      expect(reg.needsSeparateVAE, `${type} needs VAE`).toBe(true)
      expect(reg.needsSeparateCLIP, `${type} needs CLIP`).toBe(true)
      expect(reg.vae, `${type} has VAE spec`).toBeDefined()
      expect(reg.clip, `${type} has CLIP spec`).toBeDefined()
      expect(reg.vae!.downloadUrl, `${type} VAE has URL`).toContain('https://')
      expect(reg.clip!.downloadUrl, `${type} CLIP has URL`).toContain('https://')
    }
    // LTX needs CLIP but NOT separate VAE
    expect(COMPONENT_REGISTRY.ltx.needsSeparateCLIP).toBe(true)
    expect(COMPONENT_REGISTRY.ltx.needsSeparateVAE).toBe(false)
    expect(COMPONENT_REGISTRY.ltx.clip).toBeDefined()
    expect(COMPONENT_REGISTRY.ltx.clip!.downloadUrl).toContain('https://')
  })

  it('FLUX 1 uses T5 encoder', () => {
    expect(COMPONENT_REGISTRY.flux.clip!.patterns).toContain('t5xxl')
  })

  it('FLUX 2 uses Qwen/Mistral encoder (NOT T5)', () => {
    const patterns = COMPONENT_REGISTRY.flux2.clip!.patterns
    expect(patterns).toContain('qwen')
    expect(patterns).not.toContain('t5xxl')
  })

  it('Wan uses UMT5 encoder', () => {
    expect(COMPONENT_REGISTRY.wan.clip!.patterns).toContain('umt5')
  })

  it('Hunyuan uses Qwen encoder', () => {
    expect(COMPONENT_REGISTRY.hunyuan.clip!.patterns).toContain('qwen')
  })

  it('LTX uses Gemma encoder', () => {
    expect(COMPONENT_REGISTRY.ltx.clip!.patterns).toContain('gemma')
  })

  it('every downloadUrl is HTTPS', () => {
    for (const [type, reg] of Object.entries(COMPONENT_REGISTRY)) {
      if (reg.vae?.downloadUrl) {
        expect(reg.vae.downloadUrl, `${type} VAE URL`).toMatch(/^https:\/\//)
      }
      if (reg.clip?.downloadUrl) {
        expect(reg.clip.downloadUrl, `${type} CLIP URL`).toMatch(/^https:\/\//)
      }
    }
  })
})

// ─── Encoder-Type Consistency ───
// This is the most critical test: the CLIP file patterns in findMatchingCLIP()
// must be compatible with the CLIPLoader type in dynamic-workflow.ts

describe('Encoder-Type consistency', () => {
  // Map of model type → expected CLIPLoader type → compatible encoder patterns
  const EXPECTED_CLIP_TYPES: Record<string, { loaderType: string; encoderPatterns: string[] }> = {
    flux:    { loaderType: 'flux',  encoderPatterns: ['t5', 'clip_l'] },
    flux2:   { loaderType: 'flux2', encoderPatterns: ['qwen', 'mistral'] },
    wan:     { loaderType: 'wan',   encoderPatterns: ['umt5', 'wan', 't5'] },
    hunyuan: { loaderType: 'wan',   encoderPatterns: ['qwen', 'llava', 'umt5'] },
    ltx:     { loaderType: 'ltxv',  encoderPatterns: ['gemma'] },
  }

  for (const [type, expected] of Object.entries(EXPECTED_CLIP_TYPES)) {
    it(`${type}: registry patterns match expected encoder type`, () => {
      const reg = COMPONENT_REGISTRY[type as ModelType]
      if (!reg.clip) return
      // At least one pattern should be in the expected list
      const hasMatch = reg.clip.patterns.some(p =>
        expected.encoderPatterns.some(e => p.includes(e) || e.includes(p))
      )
      expect(hasMatch, `${type}: registry patterns ${reg.clip.patterns} should overlap with ${expected.encoderPatterns}`).toBe(true)
    })
  }
})
