/**
 * A mask on the local Edit tab: which models read it, what an empty prompt
 * does, and that no run path drops it without a word.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { buildDynamicWorkflow, determineStrategy } from '../../api/dynamic-workflow'
import { getAllNodeInfo, type AvailableModels, type CategorizedNodes } from '../../api/comfyui-nodes'
import type { ModelType } from '../../api/comfyui'
import { classTypes, nodeOf } from '../../api/__tests__/graph-test-support'
import {
  comfyModelTakesMask, isPromptlessRemoval, localEditMaskBlock, MASK_NEEDS_CHECKPOINT,
  REMOVE_NEGATIVE_COMFY, REMOVE_PROMPT_COMFY,
} from '../local-edit-mask'

const IMAGE_TYPES: ModelType[] = [
  'flux', 'flux2', 'krea2', 'zimage', 'ernie_image', 'qwenimage', 'qwenimage1', 'chroma', 'hidream',
  'sd3', 'lumina2', 'sdxl', 'sd15', 'minimaxh3image', 'mossimage', 'unknown',
]
const NODES = {
  loaders: ['UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader'],
  textEncoders: ['TextEncodeQwenImage21'],
  latentInit: ['MiniMaxH3ImageConditioning'],
  samplers: [],
  motion: [],
} as unknown as CategorizedNodes
const MODELS = { motionModels: [] } as unknown as AvailableModels

const base = { intent: 'edit', backend: 'local' as const, mac: false, hasMask: true, modelType: 'flux' }

describe('which local models read a mask', () => {
  it('is exactly the types the builder sends down the checkpoint graph', () => {
    for (const type of IMAGE_TYPES) {
      expect(comfyModelTakesMask(type), type).toBe(['checkpoint', 'unet_zimage'].includes(determineStrategy(type, false, NODES, MODELS).strategy))
    }
  })

  it('a model that cannot is named before the click', () => {
    expect(localEditMaskBlock(base)).toBe(MASK_NEEDS_CHECKPOINT)
    expect(localEditMaskBlock({ ...base, modelType: 'sdxl' })).toBeNull()
    expect(localEditMaskBlock({ ...base, modelType: 'sd15' })).toBeNull()
  })

  it('says nothing without a mask, on a Mac, in the cloud or on another tab', () => {
    expect(localEditMaskBlock({ ...base, hasMask: false })).toBeNull()
    expect(localEditMaskBlock({ ...base, mac: true })).toBeNull()
    expect(localEditMaskBlock({ ...base, backend: 'cloud' })).toBeNull()
    expect(localEditMaskBlock({ ...base, intent: 'image' })).toBeNull()
  })
})

describe('an empty prompt', () => {
  const run = { intent: 'edit', backend: 'local' as const, hasMask: true, prompt: '  ' }

  it('removes what was painted on the local Edit tab', () => {
    expect(isPromptlessRemoval(run)).toBe(true)
  })

  it('is no removal with words, without a mask, in the cloud or elsewhere', () => {
    expect(isPromptlessRemoval({ ...run, prompt: 'a red door' })).toBe(false)
    expect(isPromptlessRemoval({ ...run, hasMask: false })).toBe(false)
    expect(isPromptlessRemoval({ ...run, backend: 'cloud' })).toBe(false)
    expect(isPromptlessRemoval({ ...run, intent: 'image' })).toBe(false)
  })

  it('builds an inpaint graph that repaints the masked area in full', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
      CLIPTextEncode: { input: { required: {} } },
      KSampler: { input: { required: {} } },
      EmptyLatentImage: { input: { required: {} } },
      LoadImage: { input: { required: { image: [[]] } } },
      LoadImageMask: { input: { required: { image: [[]] } } },
      VAEEncode: { input: { required: {} } },
      VAEEncodeForInpaint: { input: { required: {} } },
      VAEDecode: { input: { required: {} } },
      SaveImage: { input: { required: {} } },
    } as never)
    const wf = await buildDynamicWorkflow({
      model: 'sdxl.safetensors', prompt: REMOVE_PROMPT_COMFY, negativePrompt: REMOVE_NEGATIVE_COMFY,
      sampler: 'euler', scheduler: 'normal', width: 1024, height: 1024, steps: 20, cfgScale: 7, seed: 1, batchSize: 1,
      inputImage: 'src.png', maskImage: 'mask.png', denoise: 1,
    } as never)
    expect(classTypes(wf)).toContain('VAEEncodeForInpaint')
    expect(classTypes(wf)).not.toContain('VAEEncode')
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1)
  })
})

describe('no run path drops the mask', () => {
  const run = readFileSync(resolve(__dirname, '../../hooks/useCreate.ts'), 'utf8')
  beforeEach(() => vi.clearAllMocks())

  it('the text to image fallback refuses a masked edit', () => {
    expect(run).toContain("if (maskFilename || !legacyBuilderFits(imageModelType, mode === 'video')) throw dynErr")
  })

  it('an own workflow, which has no slot for it, gives way to LU\'s graph', () => {
    expect(run).toContain('takes no mask, so this edit ran on LU\'s own workflow.')
  })

  it('the second pass on a Mac, which has no mask, does not run over a masked edit', () => {
    expect(run).toContain('const pass = hiresFixEnabled && !editMask &&')
  })

  it('a mask from cloud mode is staged before the graph is built', () => {
    expect(run).toContain("await ensureLocalFilename(mask, 'mask.png')")
  })
})
