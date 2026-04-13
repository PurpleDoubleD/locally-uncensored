import { describe, it, expect } from 'vitest'
import {
  validateWorkflowJson,
  extractSearchTerms,
  autoDetectParameterMap,
  getBuiltinTemplates,
  parseImportedWorkflow,
} from '../workflows'
import type { ModelType } from '../comfyui'

describe('workflows — pure functions', () => {
  // ─── validateWorkflowJson ───

  describe('validateWorkflowJson', () => {
    it('accepts valid API format (nodes with class_type)', () => {
      const wf = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        '2': { class_type: 'KSampler', inputs: { seed: 42 } },
      }
      expect(validateWorkflowJson(wf)).toBe(true)
    })

    it('accepts valid Web/UI format (nodes array with type)', () => {
      const wf = {
        nodes: [
          { id: 1, type: 'CheckpointLoaderSimple', widgets_values: [] },
          { id: 2, type: 'KSampler', widgets_values: [] },
        ],
        links: [],
      }
      expect(validateWorkflowJson(wf)).toBe(true)
    })

    it('rejects object with no nodes (no class_type or nodes array)', () => {
      expect(validateWorkflowJson({ foo: 'bar', baz: 123 })).toBe(false)
    })

    it('rejects empty object', () => {
      expect(validateWorkflowJson({})).toBe(false)
    })

    it('rejects null', () => {
      expect(validateWorkflowJson(null)).toBe(false)
    })

    it('rejects a string', () => {
      expect(validateWorkflowJson('hello')).toBe(false)
    })

    it('rejects an array', () => {
      expect(validateWorkflowJson([1, 2, 3])).toBe(false)
    })

    it('rejects undefined', () => {
      expect(validateWorkflowJson(undefined)).toBe(false)
    })

    it('accepts web format even without links key', () => {
      const wf = {
        nodes: [{ id: 1, type: 'SaveImage' }],
      }
      expect(validateWorkflowJson(wf)).toBe(true)
    })

    it('rejects nodes array with objects missing type field', () => {
      const wf = {
        nodes: [{ id: 1, name: 'nottype' }],
      }
      expect(validateWorkflowJson(wf)).toBe(false)
    })
  })

  // ─── extractSearchTerms ───

  describe('extractSearchTerms', () => {
    it('returns type-specific terms for flux', () => {
      const result = extractSearchTerms('flux1-schnell-fp8.safetensors', 'flux' as ModelType)
      expect(result).toBe('flux comfyui workflow')
    })

    it('returns type-specific terms for sdxl', () => {
      const result = extractSearchTerms('juggernaut.safetensors', 'sdxl' as ModelType)
      expect(result).toBe('sdxl comfyui workflow')
    })

    it('returns type-specific terms for sd15', () => {
      const result = extractSearchTerms('realisticVision.safetensors', 'sd15' as ModelType)
      expect(result).toBe('sd 1.5 comfyui workflow')
    })

    it('returns type-specific terms for flux2', () => {
      const result = extractSearchTerms('flux2.safetensors', 'flux2' as ModelType)
      expect(result).toBe('flux 2 comfyui workflow')
    })

    it('returns type-specific terms for wan', () => {
      const result = extractSearchTerms('wan2.1_t2v.safetensors', 'wan' as ModelType)
      expect(result).toBe('wan comfyui workflow')
    })

    it('returns type-specific terms for hunyuan', () => {
      const result = extractSearchTerms('hunyuanvideo.safetensors', 'hunyuan' as ModelType)
      expect(result).toBe('hunyuan comfyui workflow')
    })

    it('strips extensions and noise words for unknown type', () => {
      const result = extractSearchTerms('my-cool-model_fp16.safetensors', 'unknown' as ModelType)
      expect(result).toContain('comfyui workflow')
      expect(result).not.toContain('fp16')
      expect(result).not.toContain('safetensors')
    })

    it('keeps only first 3 meaningful words for unknown type', () => {
      const result = extractSearchTerms('very-long-model-name-with-many-parts.safetensors', 'unknown' as ModelType)
      const parts = result.replace(' comfyui workflow', '').split(' ')
      expect(parts.length).toBeLessThanOrEqual(3)
    })

    it('returns generic fallback for empty-ish model name', () => {
      const result = extractSearchTerms('.safetensors', 'unknown' as ModelType)
      expect(result).toBe('comfyui workflow')
    })
  })

  // ─── autoDetectParameterMap ───

  describe('autoDetectParameterMap', () => {
    it('detects KSampler parameters (seed, steps, cfg, sampler, scheduler)', () => {
      const wf = {
        '1': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: null, negative: null } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.seed).toEqual({ nodeId: '1', inputKey: 'seed' })
      expect(map.steps).toEqual({ nodeId: '1', inputKey: 'steps' })
      expect(map.cfgScale).toEqual({ nodeId: '1', inputKey: 'cfg' })
      expect(map.sampler).toEqual({ nodeId: '1', inputKey: 'sampler_name' })
      expect(map.scheduler).toEqual({ nodeId: '1', inputKey: 'scheduler' })
    })

    it('detects KSamplerAdvanced the same way', () => {
      const wf = {
        '1': { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 0, steps: 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', positive: null, negative: null } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.seed).toBeDefined()
      expect(map.steps).toBeDefined()
    })

    it('detects EmptyLatentImage (width, height, batchSize)', () => {
      const wf = {
        '1': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.width).toEqual({ nodeId: '1', inputKey: 'width' })
      expect(map.height).toEqual({ nodeId: '1', inputKey: 'height' })
      expect(map.batchSize).toEqual({ nodeId: '1', inputKey: 'batch_size' })
    })

    it('detects EmptySD3LatentImage as well', () => {
      const wf = {
        '1': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.width).toBeDefined()
      expect(map.height).toBeDefined()
    })

    it('detects EmptyHunyuanLatentVideo (frames, fps via SaveAnimatedWEBP)', () => {
      const wf = {
        '1': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 848, height: 480, length: 24 } },
        '2': { class_type: 'SaveAnimatedWEBP', inputs: { fps: 8 } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.frames).toEqual({ nodeId: '1', inputKey: 'length' })
      expect(map.fps).toEqual({ nodeId: '2', inputKey: 'fps' })
    })

    it('detects VHS_VideoCombine for fps (frame_rate)', () => {
      const wf = {
        '1': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 24 } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.fps).toEqual({ nodeId: '1', inputKey: 'frame_rate' })
    })

    it('detects CLIPTextEncode for prompt via KSampler positive connection', () => {
      const wf = {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
        '3': {
          class_type: 'KSampler',
          inputs: {
            positive: ['1', 0],
            negative: ['2', 0],
            seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal',
          },
        },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.positivePrompt).toEqual({ nodeId: '1', inputKey: 'text' })
      expect(map.negativePrompt).toEqual({ nodeId: '2', inputKey: 'text' })
    })

    it('falls back to first CLIPTextEncode when no KSampler connection', () => {
      const wf = {
        '10': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt1' } },
        '11': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt2' } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.positivePrompt).toBeDefined()
    })

    it('detects CheckpointLoaderSimple for model', () => {
      const wf = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.model).toEqual({ nodeId: '1', inputKey: 'ckpt_name', loaderType: 'checkpoint' })
    })

    it('detects UNETLoader for model', () => {
      const wf = {
        '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors' } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.model).toEqual({ nodeId: '1', inputKey: 'unet_name', loaderType: 'unet' })
    })

    it('returns empty map for workflow with no recognized nodes', () => {
      const wf = {
        '1': { class_type: 'SomeCustomNode', inputs: { foo: 'bar' } },
      }
      const map = autoDetectParameterMap(wf)
      expect(map.seed).toBeUndefined()
      expect(map.steps).toBeUndefined()
      expect(map.model).toBeUndefined()
    })
  })

  // ─── getBuiltinTemplates ───

  describe('getBuiltinTemplates', () => {
    it('returns exactly 3 built-in templates', () => {
      const templates = getBuiltinTemplates()
      expect(templates).toHaveLength(3)
    })

    it('each template has required fields', () => {
      for (const t of getBuiltinTemplates()) {
        expect(typeof t.name).toBe('string')
        expect(t.name.length).toBeGreaterThan(0)
        expect(typeof t.description).toBe('string')
        expect(t.source).toBe('manual')
        expect(Array.isArray(t.modelTypes)).toBe(true)
        expect(t.modelTypes.length).toBeGreaterThan(0)
        expect(['image', 'video', 'both']).toContain(t.mode)
        expect(t.rawWorkflow).toBeDefined()
      }
    })

    it('includes SDXL/SD15 template', () => {
      const templates = getBuiltinTemplates()
      const sdxl = templates.find((t) => t.modelTypes.includes('sdxl'))
      expect(sdxl).toBeDefined()
      expect(sdxl!.mode).toBe('image')
    })

    it('includes FLUX template', () => {
      const templates = getBuiltinTemplates()
      const flux = templates.find((t) => t.modelTypes.includes('flux'))
      expect(flux).toBeDefined()
      expect(flux!.mode).toBe('image')
    })

    it('includes Wan/Hunyuan video template', () => {
      const templates = getBuiltinTemplates()
      const video = templates.find((t) => t.modelTypes.includes('wan'))
      expect(video).toBeDefined()
      expect(video!.mode).toBe('video')
    })

    it('builtin templates have valid rawWorkflow (API format nodes)', () => {
      for (const t of getBuiltinTemplates()) {
        const wf = t.rawWorkflow!
        const nodes = Object.values(wf)
        expect(nodes.length).toBeGreaterThan(0)
        for (const node of nodes) {
          expect(typeof node.class_type).toBe('string')
          expect(node.inputs).toBeDefined()
        }
      }
    })
  })

  // ─── parseImportedWorkflow ───

  describe('parseImportedWorkflow', () => {
    it('wraps a workflow into a template structure', () => {
      const wf = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' } },
        '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
        '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: null, negative: null } },
        '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
      }
      const result = parseImportedWorkflow('My Workflow', wf)
      expect(result.name).toBe('My Workflow')
      expect(result.workflow).toBe(wf)
      expect(result.source).toBe('manual')
      expect(result.mode).toBe('image')
    })

    it('detects video mode from EmptyHunyuanLatentVideo', () => {
      const wf = {
        '1': { class_type: 'UNETLoader', inputs: {} },
        '2': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 848, height: 480, length: 24 } },
        '3': { class_type: 'SaveAnimatedWEBP', inputs: {} },
      }
      const result = parseImportedWorkflow('Video WF', wf)
      expect(result.mode).toBe('video')
    })

    it('detects model types from CheckpointLoaderSimple', () => {
      const wf = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        '2': { class_type: 'SaveImage', inputs: {} },
      }
      const result = parseImportedWorkflow('Test', wf)
      expect(result.modelTypes).toContain('sdxl')
      expect(result.modelTypes).toContain('sd15')
    })

    it('auto-detects parameter map', () => {
      const wf = {
        '1': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: null, negative: null } },
      }
      const result = parseImportedWorkflow('Test', wf)
      expect(result.parameterMap.seed).toBeDefined()
      expect(result.parameterMap.steps).toBeDefined()
    })

    it('uses provided source and sourceUrl', () => {
      const wf = { '1': { class_type: 'SaveImage', inputs: {} } }
      const result = parseImportedWorkflow('Test', wf, 'civitai', 'https://civitai.com/models/123')
      expect(result.source).toBe('civitai')
      expect(result.sourceUrl).toBe('https://civitai.com/models/123')
    })
  })
})
