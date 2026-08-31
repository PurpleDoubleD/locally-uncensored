/**
 * Node name pin. Every class_type the workflow builder emits has to come from
 * somewhere real: either ComfyUI core, or a custom node pack whose registry we
 * have actually read.
 *
 * This exists because three video lanes shipped for months against node names
 * that were simply made up. CogVideoX asked for CogVideoXSampler,
 * CogVideoXTextEncode, CogVideoXEmptyLatents and CogVideoXVAEDecode; kijai's
 * wrapper registers CogVideoSampler, CogVideoTextEncode and CogVideoDecode and
 * has no empty latents node at all. Pyramid Flow asked for
 * PyramidFlowModelLoader and PyramidFlowDecode; the wrapper registers
 * PyramidFlowTransformerLoader and PyramidFlowVAEDecode. Allegro followed the
 * same invented shape. Every submit came back a ComfyUI 400, and because the
 * install gate looked for the invented sampler too, users with a perfect
 * install were told to go install what they already had (bob80817-dev, D#88).
 *
 * Nothing caught it because the unit tests asserted our own mock node lists,
 * which were built from the same invented names. So the mocks agreed with the
 * builder and both were wrong. This test breaks that circle by pinning against
 * registries copied out of real checkouts.
 *
 * Adding a node to the builder means adding it here, with a source. That is the
 * whole point: if you cannot say where a class_type comes from, it does not go
 * in a graph a user downloads gigabytes for.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { determineStrategy } from '../dynamic-workflow'
import type { CategorizedNodes, AvailableModels } from '../comfyui-nodes'
import type { ModelType } from '../comfyui'

const BUILDER_SRC = join(__dirname, '..', 'dynamic-workflow.ts')

/**
 * ComfyUI core nodes. Everything in this list is either a long-standing core
 * class or was exercised in a real generate on this machine while building the
 * local Create lanes (music / lipsync / motion / extend, 2026-07-19 onward).
 */
const CORE_NODES = new Set([
  // loaders + encoders
  'CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'VAELoader',
  'ImageOnlyCheckpointLoader', 'CLIPVisionLoader', 'LoadImage', 'LoadImageMask', 'LoadAudio',
  'LoadVideo', 'AudioEncoderLoader',
  // conditioning
  'CLIPTextEncode', 'CLIPSetLastLayer', 'CLIPVisionEncode', 'ConditioningZeroOut',
  'InpaintModelConditioning', 'AudioEncoderEncode', 'ModelSamplingSD3',
  'SVD_img2vid_Conditioning', 'VideoLinearCFGGuidance',
  // latents
  'EmptyLatentImage', 'EmptyLTXVLatentVideo', 'Wan22ImageToVideoLatent', 'TrimVideoLatent',
  'WanSoundImageToVideo', 'WanAnimateToVideo', 'WanVaceToVideo',
  // sampling
  'KSampler',
  // lora
  'LoraLoader', 'LoraLoaderModelOnly',
  // decode + image ops
  // VAEDecodeTiled: core nodes.py; answered /object_info/VAEDecodeTiled live
  // on the 2026-08-02 e2e box (full tile/overlap/temporal signature).
  'VAEDecode', 'VAEDecodeTiled', 'VAEDecodeAudio', 'VAEEncode', 'VAEEncodeForInpaint', 'ImageScale',
  'GetVideoComponents', 'CreateVideo',
  // output
  'SaveImage', 'SaveAnimatedWEBP', 'SaveVideo', 'SaveAudioMP3',
])

/**
 * Custom node packs, keyed by the pack LU tells the user to install. Each set is
 * the NODE_CLASS_MAPPINGS keys of a real checkout, not the class names in the
 * python file. ComfyUI dispatches on the mapping key, and Pyramid Flow is the
 * cautionary tale: its loader class is PyramidFlowModelLoader but it is
 * registered as PyramidFlowTransformerLoader, so the class name was useless.
 */
const CUSTOM_PACK_NODES: Record<string, Set<string>> = {
  // kijai/ComfyUI-FramePackWrapper, nodes.py NODE_CLASS_MAPPINGS, read 2026-07-24
  'ComfyUI-FramePackWrapper': new Set([
    'DownloadAndLoadFramePackModel', 'FramePackSampler', 'FramePackTorchCompileSettings',
    'FramePackFindNearestBucket', 'LoadFramePackModel', 'FramePackLoraSelect',
    'FramePackSingleFrameSampler',
  ]),
  // Kosinkadink/ComfyUI-AnimateDiff-Evolved, the three nodes our chain uses
  'ComfyUI-AnimateDiff-Evolved': new Set([
    'ADE_LoadAnimateDiffModel', 'ADE_ApplyAnimateDiffModelSimple', 'ADE_UseEvolvedSampling',
  ]),
  // Kosinkadink/ComfyUI-VideoHelperSuite
  'ComfyUI-VideoHelperSuite': new Set(['VHS_VideoCombine']),
  // 1038lab/ComfyUI-RMBG
  'ComfyUI-RMBG': new Set(['RMBG']),
  // Fannovel16/comfyui_controlnet_aux
  'comfyui_controlnet_aux': new Set(['DWPreprocessor']),
  // city96/ComfyUI-GGUF
  'ComfyUI-GGUF': new Set(['UnetLoaderGGUF']),
}

/** Names proven not to exist in any release of the pack LU pointed at. */
const INVENTED_NAMES = [
  'CogVideoXSampler', 'CogVideoXTextEncode', 'CogVideoXEmptyLatents', 'CogVideoXVAEDecode',
  'CogVideoXCLIPLoader', 'PyramidFlowModelLoader', 'PyramidFlowDecode',
]

function emittedClassTypes(): string[] {
  const src = readFileSync(BUILDER_SRC, 'utf8')
  const out = new Set<string>()
  for (const m of src.matchAll(/class_type:\s*'([A-Za-z0-9_]+)'/g)) out.add(m[1])
  return [...out].sort()
}

function knownNode(name: string): boolean {
  if (CORE_NODES.has(name)) return true
  return Object.values(CUSTOM_PACK_NODES).some((pack) => pack.has(name))
}

describe('workflow builder emits only node names we have verified', () => {
  it('finds class_types to check (guards against the regex silently matching nothing)', () => {
    expect(emittedClassTypes().length).toBeGreaterThan(30)
  })

  it('every emitted class_type is core ComfyUI or a verified custom pack node', () => {
    const unknown = emittedClassTypes().filter((n) => !knownNode(n))
    expect(
      unknown,
      `Unknown class_type(s): ${unknown.join(', ')}.\n` +
        'Add each to CORE_NODES or to the CUSTOM_PACK_NODES entry for the pack that\n' +
        'registers it, and say in the comment where you read the registry. If you\n' +
        'cannot find it in a real checkout, the node does not exist and the graph\n' +
        'will come back as a ComfyUI 400.',
    ).toEqual([])
  })

  it('the invented names never come back', () => {
    const src = readFileSync(BUILDER_SRC, 'utf8')
    for (const name of INVENTED_NAMES) {
      // The audit comments mention these names on purpose, so only a real
      // class_type emission counts as a regression.
      expect(src, `${name} is emitted again`).not.toMatch(
        new RegExp(`class_type:\\s*'${name}'`),
      )
    }
  })
})

describe('lanes whose builders were removed stay closed', () => {
  // Every node these lanes ever asked for, present. A gate that reopens on node
  // presence would fail here, which is exactly what we want to catch.
  const allNodes: CategorizedNodes = {
    loaders: [
      'UNETLoader', 'CheckpointLoaderSimple', 'CLIPLoader', 'VAELoader',
      'CogVideoXModelLoader', 'CogVideoXCLIPLoader', 'CogVideoXVAELoader',
      'PyramidFlowTransformerLoader', 'PyramidFlowModelLoader', 'PyramidFlowVAELoader',
      'AllegroModelLoader',
    ],
    samplers: [
      'KSampler', 'CogVideoSampler', 'CogVideoXSampler',
      'PyramidFlowSampler', 'AllegroSampler',
    ],
    latentInit: ['EmptyLatentImage', 'CogVideoXEmptyLatents'],
    textEncoders: [
      'CLIPTextEncode', 'CogVideoTextEncode', 'CogVideoXTextEncode',
      'PyramidFlowTextEncode', 'AllegroTextEncode',
    ],
    decoders: [
      'VAEDecode', 'CogVideoDecode', 'CogVideoXVAEDecode',
      'PyramidFlowVAEDecode', 'PyramidFlowDecode', 'AllegroDecoder',
    ],
    savers: ['SaveImage'],
    videoSavers: ['VHS_VideoCombine', 'SaveAnimatedWEBP'],
    motion: [],
  }
  const models: AvailableModels = {
    checkpoints: ['test.safetensors'], unets: ['test_unet.safetensors'],
    vaes: ['test_vae.safetensors'], clips: ['test_clip.safetensors'],
    motionModels: [],
  }

  for (const type of ['cogvideo', 'pyramidflow', 'allegro'] as ModelType[]) {
    it(`${type} resolves to unavailable even with every node installed`, () => {
      const result = determineStrategy(type, true, allNodes, models)
      expect(result.strategy).toBe('unavailable')
      // No install hint: the user's install is not the problem, ours is.
      expect(result.installHint).toBeUndefined()
      expect(result.reason.length).toBeGreaterThan(20)
    })
  }
})
