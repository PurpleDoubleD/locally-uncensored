import { describe, it, expect } from 'vitest'
import {
  categorizeNodes,
  detectAvailableModels,
  getSamplerOptions,
  getSchedulerOptions,
  hasNode,
  clearNodeCache,
  type NodeMetadata,
} from '../comfyui-nodes'

// Helper to create a minimal node metadata entry
function makeNode(output: string[] = ['MODEL'], category?: string): NodeMetadata {
  return {
    input: { required: {} },
    output,
    category,
  }
}

// Helper to create a node spec with a required dropdown field
function makeNodeWithDropdown(fieldName: string, options: string[]): NodeMetadata {
  return {
    input: {
      required: {
        [fieldName]: [options],
      },
    },
    output: ['MODEL'],
  }
}

describe('comfyui-nodes — pure functions', () => {
  // ─── categorizeNodes ───

  describe('categorizeNodes', () => {
    it('categorizes loader nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        CheckpointLoaderSimple: makeNode(),
        UNETLoader: makeNode(),
        VAELoader: makeNode(),
        CLIPLoader: makeNode(),
        DualCLIPLoader: makeNode(),
        TripleCLIPLoader: makeNode(),
        ImageOnlyCheckpointLoader: makeNode(),
        CLIPVisionLoader: makeNode(),
        LoadImage: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.loaders).toContain('CheckpointLoaderSimple')
      expect(result.loaders).toContain('UNETLoader')
      expect(result.loaders).toContain('VAELoader')
      expect(result.loaders).toContain('CLIPLoader')
      expect(result.loaders).toContain('DualCLIPLoader')
      expect(result.loaders).toContain('TripleCLIPLoader')
      expect(result.loaders).toContain('ImageOnlyCheckpointLoader')
      expect(result.loaders).toContain('CLIPVisionLoader')
      expect(result.loaders).toContain('LoadImage')
    })

    it('categorizes sampler nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        KSampler: makeNode(),
        KSamplerAdvanced: makeNode(),
        SamplerCustom: makeNode(),
        CogVideoXSampler: makeNode(),
        FramePackSampler: makeNode(),
        PyramidFlowSampler: makeNode(),
        AllegroSampler: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.samplers).toContain('KSampler')
      expect(result.samplers).toContain('KSamplerAdvanced')
      expect(result.samplers).toContain('SamplerCustom')
      expect(result.samplers).toContain('CogVideoXSampler')
      expect(result.samplers).toContain('FramePackSampler')
      expect(result.samplers).toContain('PyramidFlowSampler')
      expect(result.samplers).toContain('AllegroSampler')
    })

    it('categorizes latentInit nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        EmptyLatentImage: makeNode(),
        EmptySD3LatentImage: makeNode(),
        EmptyFlux2LatentImage: makeNode(),
        EmptyHunyuanLatentVideo: makeNode(),
        EmptyLTXVLatentVideo: makeNode(),
        EmptyMochiLatentVideo: makeNode(),
        EmptyCosmosLatentVideo: makeNode(),
        CogVideoXEmptyLatents: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.latentInit).toHaveLength(8)
      expect(result.latentInit).toContain('EmptyLatentImage')
      expect(result.latentInit).toContain('EmptyHunyuanLatentVideo')
      expect(result.latentInit).toContain('CogVideoXEmptyLatents')
    })

    it('categorizes text encoder nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        CLIPTextEncode: makeNode(),
        CLIPTextEncodeSDXL: makeNode(),
        CogVideoXTextEncode: makeNode(),
        PyramidFlowTextEncode: makeNode(),
        AllegroTextEncode: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.textEncoders).toHaveLength(5)
      expect(result.textEncoders).toContain('CLIPTextEncode')
    })

    it('categorizes decoder nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        VAEDecode: makeNode(),
        VAEDecodeTiled: makeNode(),
        CogVideoXVAEDecode: makeNode(),
        PyramidFlowDecode: makeNode(),
        AllegroDecoder: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.decoders).toHaveLength(5)
    })

    it('categorizes saver and video saver nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        SaveImage: makeNode(),
        PreviewImage: makeNode(),
        SaveAnimatedWEBP: makeNode(),
        VHS_VideoCombine: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.savers).toEqual(['SaveImage', 'PreviewImage'])
      expect(result.videoSavers).toEqual(['SaveAnimatedWEBP', 'VHS_VideoCombine'])
    })

    it('categorizes motion nodes correctly', () => {
      const nodes: Record<string, NodeMetadata> = {
        ADE_LoadAnimateDiffModel: makeNode(),
        ADE_ApplyAnimateDiffModelSimple: makeNode(),
        ADE_UseEvolvedSampling: makeNode(),
        SVD_img2vid_Conditioning: makeNode(),
        VideoLinearCFGGuidance: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.motion).toHaveLength(5)
      expect(result.motion).toContain('ADE_LoadAnimateDiffModel')
      expect(result.motion).toContain('SVD_img2vid_Conditioning')
    })

    it('categorizes wrapper loader nodes (custom)', () => {
      const nodes: Record<string, NodeMetadata> = {
        CogVideoXModelLoader: makeNode(),
        CogVideoXCLIPLoader: makeNode(),
        LoadFramePackModel: makeNode(),
        DownloadAndLoadFramePackModel: makeNode(),
        PyramidFlowModelLoader: makeNode(),
        PyramidFlowVAELoader: makeNode(),
        AllegroModelLoader: makeNode(),
      }
      const result = categorizeNodes(nodes)
      expect(result.loaders).toHaveLength(7)
    })

    it('returns empty arrays for empty input', () => {
      const result = categorizeNodes({})
      expect(result.loaders).toEqual([])
      expect(result.samplers).toEqual([])
      expect(result.latentInit).toEqual([])
      expect(result.textEncoders).toEqual([])
      expect(result.decoders).toEqual([])
      expect(result.savers).toEqual([])
      expect(result.videoSavers).toEqual([])
      expect(result.motion).toEqual([])
    })

    it('ignores unknown/uncategorized nodes', () => {
      const nodes: Record<string, NodeMetadata> = {
        MyCustomNode: makeNode(),
        AnotherCustomNode: makeNode(),
        KSampler: makeNode(),
      }
      const result = categorizeNodes(nodes)
      // Only KSampler should be categorized
      expect(result.samplers).toEqual(['KSampler'])
      expect(result.loaders).toEqual([])
    })
  })

  // ─── detectAvailableModels ───

  describe('detectAvailableModels', () => {
    it('extracts checkpoints from CheckpointLoaderSimple', () => {
      const nodes: Record<string, NodeMetadata> = {
        CheckpointLoaderSimple: makeNodeWithDropdown('ckpt_name', ['model_a.safetensors', 'model_b.safetensors']),
      }
      const models = detectAvailableModels(nodes)
      expect(models.checkpoints).toEqual(['model_a.safetensors', 'model_b.safetensors'])
    })

    it('extracts UNETs from UNETLoader', () => {
      const nodes: Record<string, NodeMetadata> = {
        UNETLoader: makeNodeWithDropdown('unet_name', ['flux1-schnell-fp8.safetensors']),
      }
      const models = detectAvailableModels(nodes)
      expect(models.unets).toEqual(['flux1-schnell-fp8.safetensors'])
    })

    it('extracts VAEs from VAELoader', () => {
      const nodes: Record<string, NodeMetadata> = {
        VAELoader: makeNodeWithDropdown('vae_name', ['ae.safetensors', 'kl-f8-anime2.safetensors']),
      }
      const models = detectAvailableModels(nodes)
      expect(models.vaes).toEqual(['ae.safetensors', 'kl-f8-anime2.safetensors'])
    })

    it('extracts CLIPs from CLIPLoader', () => {
      const nodes: Record<string, NodeMetadata> = {
        CLIPLoader: makeNodeWithDropdown('clip_name', ['clip_l.safetensors', 't5xxl_fp8.safetensors']),
      }
      const models = detectAvailableModels(nodes)
      expect(models.clips).toEqual(['clip_l.safetensors', 't5xxl_fp8.safetensors'])
    })

    it('extracts motion models from ADE_LoadAnimateDiffModel', () => {
      const nodes: Record<string, NodeMetadata> = {
        ADE_LoadAnimateDiffModel: makeNodeWithDropdown('model_name', ['v3_sd15_mm.ckpt']),
      }
      const models = detectAvailableModels(nodes)
      expect(models.motionModels).toEqual(['v3_sd15_mm.ckpt'])
    })

    it('returns empty arrays when node types are missing', () => {
      const models = detectAvailableModels({})
      expect(models.checkpoints).toEqual([])
      expect(models.unets).toEqual([])
      expect(models.vaes).toEqual([])
      expect(models.clips).toEqual([])
      expect(models.motionModels).toEqual([])
    })

    it('returns empty array when field format is unexpected', () => {
      const nodes: Record<string, NodeMetadata> = {
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: 'not_an_array' } },
          output: ['MODEL'],
        },
      }
      const models = detectAvailableModels(nodes)
      expect(models.checkpoints).toEqual([])
    })
  })

  // ─── getSamplerOptions ───

  describe('getSamplerOptions', () => {
    it('returns sampler names from KSampler spec', () => {
      const nodes: Record<string, NodeMetadata> = {
        KSampler: makeNodeWithDropdown('sampler_name', ['euler', 'euler_ancestral', 'dpmpp_2m']),
      }
      const options = getSamplerOptions(nodes)
      expect(options).toEqual(['euler', 'euler_ancestral', 'dpmpp_2m'])
    })

    it('returns fallback ["euler"] when KSampler is missing', () => {
      const options = getSamplerOptions({})
      expect(options).toEqual(['euler'])
    })

    it('returns fallback when KSampler has no sampler_name field', () => {
      const nodes: Record<string, NodeMetadata> = {
        KSampler: { input: { required: {} }, output: ['LATENT'] },
      }
      const options = getSamplerOptions(nodes)
      expect(options).toEqual(['euler'])
    })
  })

  // ─── getSchedulerOptions ───

  describe('getSchedulerOptions', () => {
    it('returns scheduler names from KSampler spec', () => {
      const nodes: Record<string, NodeMetadata> = {
        KSampler: makeNodeWithDropdown('scheduler', ['normal', 'karras', 'exponential', 'sgm_uniform']),
      }
      const options = getSchedulerOptions(nodes)
      expect(options).toEqual(['normal', 'karras', 'exponential', 'sgm_uniform'])
    })

    it('returns fallback ["normal"] when KSampler is missing', () => {
      const options = getSchedulerOptions({})
      expect(options).toEqual(['normal'])
    })
  })

  // ─── hasNode ───

  describe('hasNode', () => {
    it('returns false when cache is empty (no node info loaded)', () => {
      clearNodeCache()
      expect(hasNode('KSampler')).toBe(false)
    })

    it('returns false for a node not in cache even after clear', () => {
      clearNodeCache()
      expect(hasNode('NonExistentNode')).toBe(false)
    })
  })
})
