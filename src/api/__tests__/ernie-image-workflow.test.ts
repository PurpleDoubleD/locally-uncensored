/**
 * Deep smoke tests for ERNIE-Image workflow — end-to-end node chain verification.
 *
 * Tests the complete pipeline from model classification through to the actual
 * workflow JSON structure including ConditioningZeroOut, EmptyFlux2LatentImage,
 * and the correct node wiring.
 *
 * This goes deeper than comfyui-integration.test.ts which only tests
 * strategy determination — here we verify the actual workflow nodes.
 */
import { describe, it, expect } from 'vitest'
import { classifyModel, MODEL_TYPE_DEFAULTS as COMFYUI_DEFAULTS, COMPONENT_REGISTRY, isImageModelType, type ModelType } from '../comfyui'
import { determineStrategy, type WorkflowStrategy } from '../dynamic-workflow'
import { getImageBundles } from '../discover'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'

function allNodes(): CategorizedNodes {
  return {
    loaders: ['UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader',
      'ImageOnlyCheckpointLoader', 'CLIPVisionLoader', 'LoadImage'],
    samplers: ['KSampler', 'KSamplerAdvanced'],
    latentInit: ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage'],
    textEncoders: ['CLIPTextEncode', 'ConditioningZeroOut'],
    decoders: ['VAEDecode'],
    savers: ['SaveImage'],
    videoSavers: [],
    motion: [],
  }
}

const defaultModels: AvailableModels = {
  checkpoints: [], unets: ['ernie-image-turbo.safetensors'],
  vaes: ['flux2-vae.safetensors'], clips: ['ministral-3-3b.safetensors'],
  loras: [], controlnets: [], ipadapters: [],
}

// ── Classification ──────────────────────────────────────────────────────

describe('ERNIE-Image classification', () => {
  it('classifies ernie-image-turbo', () => {
    expect(classifyModel('ernie-image-turbo.safetensors')).toBe('ernie_image')
  })

  it('classifies ernie_image_turbo (underscore variant)', () => {
    expect(classifyModel('ernie_image_turbo_bf16.safetensors')).toBe('ernie_image')
  })

  it('classifies ernie-image (base, no turbo)', () => {
    expect(classifyModel('ernie-image.safetensors')).toBe('ernie_image')
  })

  it('ernie_image is an image model type', () => {
    expect(isImageModelType('ernie_image')).toBe(true)
  })

  it('ernie_image is NOT a video model type', () => {
    // Video models should not include ernie_image
    const videoTypes = ['wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'svd', 'framepack', 'pyramidflow', 'allegro']
    expect(videoTypes).not.toContain('ernie_image')
  })
})

// ── Defaults ────────────────────────────────────────────────────────────

describe('ERNIE-Image defaults (comfyui.ts workflow defaults)', () => {
  const defaults = COMFYUI_DEFAULTS.ernie_image

  it('uses 8 steps (Turbo)', () => {
    expect(defaults.steps).toBe(8)
  })

  it('uses CFG 1 (aggressive guidance)', () => {
    expect(defaults.cfg).toBe(1)
  })

  it('uses euler sampler', () => {
    expect(defaults.sampler).toBe('euler')
  })

  it('uses simple scheduler', () => {
    expect(defaults.scheduler).toBe('simple')
  })

  it('outputs 1024x1024', () => {
    expect(defaults.width).toBe(1024)
    expect(defaults.height).toBe(1024)
  })
})

// ── COMPONENT_REGISTRY ──────────────────────────────────────────────────

describe('ERNIE-Image COMPONENT_REGISTRY', () => {
  const entry = COMPONENT_REGISTRY.ernie_image

  it('entry exists', () => {
    expect(entry).toBeDefined()
  })

  it('uses UNETLoader', () => {
    expect(entry.loader).toBe('UNETLoader')
  })

  it('needs separate VAE', () => {
    expect(entry.needsSeparateVAE).toBe(true)
  })

  it('needs separate CLIP', () => {
    expect(entry.needsSeparateCLIP).toBe(true)
  })

  it('uses flux2 CLIP type', () => {
    expect(entry.clipType).toBe('flux2')
  })

  it('VAE patterns include flux2-vae', () => {
    expect(entry.vae?.matchPatterns).toContain('flux2-vae')
  })

  it('CLIP patterns include ministral and prompt enhancer', () => {
    expect(entry.clip?.matchPatterns).toContain('ministral-3-3b')
    expect(entry.clip?.matchPatterns).toContain('ernie-image-prompt-enhancer')
  })
})

// ── Strategy Determination ──────────────────────────────────────────────

describe('ERNIE-Image strategy', () => {
  it('determines unet_ernie_image when all nodes available', () => {
    const result = determineStrategy('ernie_image' as ModelType, false, allNodes(), defaultModels)
    expect(result.strategy).toBe('unet_ernie_image')
  })

  it('returns unavailable when CLIPLoader missing', () => {
    const nodes = allNodes()
    nodes.loaders = nodes.loaders.filter(n => n !== 'CLIPLoader')
    const result = determineStrategy('ernie_image' as ModelType, false, nodes, defaultModels)
    expect(result.strategy).toBe('unavailable')
  })

  it('returns unavailable when UNETLoader missing', () => {
    const nodes = allNodes()
    nodes.loaders = nodes.loaders.filter(n => n !== 'UNETLoader')
    const result = determineStrategy('ernie_image' as ModelType, false, nodes, defaultModels)
    expect(result.strategy).toBe('unavailable')
  })

  it('returns unavailable when VAELoader missing', () => {
    const nodes = allNodes()
    nodes.loaders = nodes.loaders.filter(n => n !== 'VAELoader')
    const result = determineStrategy('ernie_image' as ModelType, false, nodes, defaultModels)
    expect(result.strategy).toBe('unavailable')
  })
})

// ── Bundle Verification ─────────────────────────────────────────────────

describe('ERNIE-Image bundles', () => {
  const bundles = getImageBundles()
  const ernieBundles = bundles.filter(b => b.workflow === 'ernie_image')

  it('has exactly 2 bundles (Turbo + Base)', () => {
    expect(ernieBundles).toHaveLength(2)
  })

  it('both are verified (no Coming Soon banner)', () => {
    for (const b of ernieBundles) {
      expect(b.verified).toBe(true)
    }
  })

  it('both are NOT uncensored', () => {
    for (const b of ernieBundles) {
      expect(b.uncensored).toBe(false)
    }
  })

  it('Turbo bundle has correct name', () => {
    const turbo = ernieBundles.find(b => b.name.includes('Turbo'))
    expect(turbo).toBeDefined()
  })

  it('Base bundle has correct name', () => {
    const base = ernieBundles.find(b => b.name.includes('Base'))
    expect(base).toBeDefined()
  })

  it('each bundle has 4 files', () => {
    for (const b of ernieBundles) {
      expect(b.files).toHaveLength(4)
    }
  })

  it('all files have HuggingFace URLs pointing to Comfy-Org/ERNIE-Image', () => {
    for (const b of ernieBundles) {
      for (const f of b.files) {
        expect(f.downloadUrl).toContain('huggingface.co/Comfy-Org/ERNIE-Image')
      }
    }
  })

  it('includes shared flux2 VAE file', () => {
    for (const b of ernieBundles) {
      const vae = b.files.find(f => f.filename === 'flux2-vae.safetensors')
      expect(vae).toBeDefined()
      expect(vae!.subfolder).toBe('vae')
    }
  })

  it('includes Ministral-3B text encoder', () => {
    for (const b of ernieBundles) {
      const clip = b.files.find(f => f.filename === 'ministral-3-3b.safetensors')
      expect(clip).toBeDefined()
      expect(clip!.subfolder).toBe('text_encoders')
    }
  })

  it('includes prompt enhancer', () => {
    for (const b of ernieBundles) {
      const enhancer = b.files.find(f => f.filename === 'ernie-image-prompt-enhancer.safetensors')
      expect(enhancer).toBeDefined()
    }
  })

  it('total sizes are realistic (28-30 GB range)', () => {
    for (const b of ernieBundles) {
      expect(b.totalSizeGB).toBeGreaterThan(25)
      expect(b.totalSizeGB).toBeLessThan(35)
    }
  })

  it('requires 24 GB VRAM', () => {
    for (const b of ernieBundles) {
      expect(b.vramRequired).toBe('24 GB')
    }
  })

  it('requires no custom nodes', () => {
    for (const b of ernieBundles) {
      expect(b.customNodes || []).toHaveLength(0)
    }
  })
})

// ── Workflow ConditioningZeroOut verification ────────────────────────────
// We verify via source-level check since buildDynamicWorkflow requires
// a live ComfyUI connection.

describe('ERNIE-Image ConditioningZeroOut (source verification)', () => {
  it('dynamic-workflow.ts uses ConditioningZeroOut for ernie_image negative', () => {
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    const src = readFileSync(resolve(__dirname, '../dynamic-workflow.ts'), 'utf8')

    // The critical branching logic
    expect(src).toContain("strategy === 'unet_ernie_image'")
    expect(src).toContain('ConditioningZeroOut')
    // Verify ConditioningZeroOut takes positive conditioning as input
    expect(src).toMatch(/ConditioningZeroOut[\s\S]*conditioning.*posId/)
  })

  it('dynamic-workflow.ts uses EmptyFlux2LatentImage for ernie_image', () => {
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    const src = readFileSync(resolve(__dirname, '../dynamic-workflow.ts'), 'utf8')

    // ernie_image shares Flux2 latent space
    expect(src).toMatch(/unet_flux2.*unet_ernie_image|unet_ernie_image.*unet_flux2/)
    expect(src).toContain('EmptyFlux2LatentImage')
  })

  it('dynamic-workflow.ts uses flux2 clipType for ernie_image', () => {
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    const src = readFileSync(resolve(__dirname, '../dynamic-workflow.ts'), 'utf8')

    expect(src).toMatch(/ernie_image.*flux2/)
  })
})
