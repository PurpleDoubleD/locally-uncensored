// 2.5.8 specialized local lanes: pure-graph tests for the music / talking
// character / motion builders plus the classification + gallery-type helpers
// they lean on. allNodes is mocked as a plain presence map — exactly what
// getAllNodeInfo() feeds the builders at runtime.

import { describe, it, expect } from 'vitest'
import {
  buildMusicWorkflow,
  buildS2VWorkflow,
  buildMotionWorkflow,
  WorkflowUnavailableError,
  type LocalOpParams,
} from '../dynamic-workflow'
import { classifyModel, galleryTypeForFile, resolveLocalOpPick, type ClassifiedModel } from '../comfyui'

/**
 * One node of a ComfyUI prompt graph, the way the builders under test emit it.
 * The builders are still declared `Record<string, any>` (dynamic-workflow.ts
 * is another agent's file this round), so the shape is pinned HERE: every
 * assertion below now reads a checked field instead of an `any` that would
 * have swallowed a renamed key as `undefined === undefined`.
 */
interface ComfyNode {
  class_type: string
  inputs: Record<string, unknown>
}
type ComfyGraph = Record<string, ComfyNode>

/** The node of this class_type — fails loudly when the graph has none. */
function nodeOfType(wf: ComfyGraph, classType: string): ComfyNode {
  const node = Object.values(wf).find(n => n.class_type === classType)
  if (!node) throw new Error(`graph has no ${classType} node`)
  return node
}

/** A numeric input, checked rather than assumed. */
function numInput(node: ComfyNode, key: string): number {
  const v = node.inputs[key]
  if (typeof v !== 'number') {
    throw new Error(`${node.class_type}.inputs.${key} is not a number: ${String(v)}`)
  }
  return v
}

/** An array input (a ComfyUI link `[nodeId, slot]`, or a literal list). */
function arrInput(node: ComfyNode, key: string): unknown[] {
  const v = node.inputs[key]
  if (!Array.isArray(v)) {
    throw new Error(`${node.class_type}.inputs.${key} is not an array: ${String(v)}`)
  }
  return v
}

/** The presence map getAllNodeInfo() feeds the builders — keys only. */
const FULL_NODES: Record<string, object> = Object.fromEntries(
  [
    'TextEncodeAceStepAudio', 'EmptyAceStepLatentAudio',
    'TextEncodeAceStepAudio1.5', 'EmptyAceStep1.5LatentAudio',
    'VAEDecodeAudio', 'SaveAudioMP3', 'LoadAudio', 'ConditioningZeroOut',
    'AudioEncoderLoader', 'AudioEncoderEncode', 'WanSoundImageToVideo',
    'WanAnimateToVideo', 'WanVaceToVideo', 'TrimVideoLatent',
    'LoadVideo', 'GetVideoComponents', 'CreateVideo', 'SaveVideo',
    'DWPreprocessor', 'UnetLoaderGGUF', 'UNETLoader', 'CLIPLoader',
    'VAELoader', 'CLIPTextEncode', 'KSampler', 'VAEDecode',
    'ModelSamplingSD3', 'LoadImage', 'ImageScale',
  ].map((n) => [n, {}]),
)

const nodesWithout = (...names: string[]) => {
  const copy = { ...FULL_NODES }
  for (const n of names) delete copy[n]
  return copy
}

const classTypes = (wf: ComfyGraph) => Object.values(wf).map(n => n.class_type)

const baseParams = (over: Partial<LocalOpParams>): LocalOpParams => ({
  op: 'music',
  model: 'ace_step_v1_3.5b.safetensors',
  prompt: 'dreamy lofi',
  negativePrompt: '',
  seed: 7, steps: 20, cfgScale: 5, sampler: 'euler', scheduler: 'simple',
  width: 832, height: 480, frames: 77, fps: 16,
  ...over,
})

describe('lane model classification', () => {
  it('routes the specialized families before the generic wan/ace matches', () => {
    expect(classifyModel('wan2.1_vace_1.3B_fp16.safetensors')).toBe('wanvace')
    expect(classifyModel('Wan2.2-S2V-14B-Q4_K_M.gguf')).toBe('wans2v')
    expect(classifyModel('wan2.2_s2v_14B_fp8_scaled.safetensors')).toBe('wans2v')
    expect(classifyModel('Wan2.2-Animate-14B-Q4_K_M.gguf')).toBe('wananimate')
    expect(classifyModel('ace_step_v1_3.5b.safetensors')).toBe('ace')
    expect(classifyModel('ace_step_1.5_turbo_aio.safetensors')).toBe('ace')
  })

  it('rapid AIO merges are Wan 14B architecture, not the TI2V-5B path', () => {
    expect(classifyModel('wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf')).toBe('wan')
  })

  it('animatediff checkpoints never classify as wananimate', () => {
    expect(classifyModel('wan_animatediff_motion.ckpt')).not.toBe('wananimate')
  })
})

describe('galleryTypeForFile', () => {
  it('audio extensions win regardless of render mode', () => {
    expect(galleryTypeForFile('song_00001_.mp3', 'image')).toBe('audio')
    expect(galleryTypeForFile('song.flac', 'video')).toBe('audio')
  })
  it('everything else keeps the mode (incl. the animated-webp fallback)', () => {
    expect(galleryTypeForFile('a.png', 'image')).toBe('image')
    expect(galleryTypeForFile('a.mp4', 'video')).toBe('video')
    expect(galleryTypeForFile('a.webp', 'video')).toBe('video')
  })
})

describe('resolveLocalOpPick', () => {
  const list: ClassifiedModel[] = [
    { name: 'ace_step_v1_3.5b.safetensors', type: 'ace', source: 'checkpoint' },
    { name: 'ace_step_1.5_turbo_aio.safetensors', type: 'ace', source: 'checkpoint' },
  ]
  it('keeps a valid pick, coerces a stale one, empties on empty list', () => {
    expect(resolveLocalOpPick('ace_step_1.5_turbo_aio.safetensors', list)).toBe('ace_step_1.5_turbo_aio.safetensors')
    expect(resolveLocalOpPick('Wan2.2-S2V-14B-Q4_K_M.gguf', list)).toBe('ace_step_v1_3.5b.safetensors')
    expect(resolveLocalOpPick('anything', [])).toBe('')
  })
})

describe('buildMusicWorkflow', () => {
  it('builds the v1 ACE graph (checkpoint, encode, latent, mp3 save)', () => {
    const wf: ComfyGraph = buildMusicWorkflow(baseParams({ seconds: 45, lyrics: 'la la' }), 7, FULL_NODES)
    const types = classTypes(wf)
    expect(types).toContain('CheckpointLoaderSimple')
    expect(types).toContain('TextEncodeAceStepAudio')
    expect(types).toContain('EmptyAceStepLatentAudio')
    expect(types).toContain('VAEDecodeAudio')
    expect(types).toContain('SaveAudioMP3')
    expect(nodeOfType(wf, 'EmptyAceStepLatentAudio').inputs.seconds).toBe(45)
    expect(nodeOfType(wf, 'TextEncodeAceStepAudio').inputs.lyrics).toBe('la la')
  })

  it('routes ACE 1.5 checkpoints through the 1.5 node pair with a zeroed negative', () => {
    const wf: ComfyGraph = buildMusicWorkflow(
      baseParams({ model: 'ace_step_1.5_turbo_aio.safetensors', seconds: 60 }), 7, FULL_NODES)
    const types = classTypes(wf)
    expect(types).toContain('TextEncodeAceStepAudio1.5')
    expect(types).toContain('EmptyAceStep1.5LatentAudio')
    expect(types).toContain('ConditioningZeroOut')
    expect(types).not.toContain('TextEncodeAceStepAudio')
  })

  it('REJECT-AND-REPORTs an old core with an update message', () => {
    expect(() => buildMusicWorkflow(baseParams({}), 7, nodesWithout('TextEncodeAceStepAudio')))
      .toThrowError(WorkflowUnavailableError)
    try {
      buildMusicWorkflow(baseParams({}), 7, nodesWithout('TextEncodeAceStepAudio'))
    } catch (e) {
      expect((e as Error).message).toMatch(/Update ComfyUI/)
    }
  })
})

describe('buildS2VWorkflow', () => {
  const s2v = (over: Partial<LocalOpParams> = {}) => baseParams({
    op: 'lipsync',
    model: 'wan2.2_s2v_14B_fp8_scaled.safetensors',
    audioFile: 'voice.mp3',
    refImage: 'portrait.png',
    ...over,
  })

  it('wires audio embeddings into the S2V conditioner and muxes the voice into the mp4', () => {
    const wf: ComfyGraph = buildS2VWorkflow(s2v(), 7, FULL_NODES)
    const types = classTypes(wf)
    for (const t of ['LoadAudio', 'AudioEncoderLoader', 'AudioEncoderEncode', 'WanSoundImageToVideo', 'CreateVideo', 'SaveVideo']) {
      expect(types).toContain(t)
    }
    expect(nodeOfType(wf, 'CreateVideo').inputs.audio).toBeTruthy()
    const s2vNode = nodeOfType(wf, 'WanSoundImageToVideo')
    // length stays on the 4k+1 grid
    expect((numInput(s2vNode, 'length') - 1) % 4).toBe(0)
  })

  it('loads .gguf quants through the GGUF pack and hints its install when missing', () => {
    const wf: ComfyGraph = buildS2VWorkflow(s2v({ model: 'Wan2.2-S2V-14B-Q4_K_M.gguf' }), 7, FULL_NODES)
    expect(classTypes(wf)).toContain('UnetLoaderGGUF')
    try {
      buildS2VWorkflow(s2v({ model: 'Wan2.2-S2V-14B-Q4_K_M.gguf' }), 7, nodesWithout('UnetLoaderGGUF'))
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowUnavailableError)
      expect((e as WorkflowUnavailableError).installHint?.pack).toBe('ComfyUI-GGUF')
    }
  })

  it('rejects a missing voice or portrait before anything uploads', () => {
    expect(() => buildS2VWorkflow(s2v({ audioFile: undefined }), 7, FULL_NODES)).toThrow(/voice/i)
    expect(() => buildS2VWorkflow(s2v({ refImage: undefined }), 7, FULL_NODES)).toThrow(/portrait/i)
  })
})

describe('buildMotionWorkflow', () => {
  const motion = (over: Partial<LocalOpParams> = {}) => baseParams({
    op: 'motion',
    model: 'Wan2.2-Animate-14B-Q4_K_M.gguf',
    drivingVideo: 'dance.mp4',
    refImage: 'char.png',
    ...over,
  })

  it('builds the Animate graph: DWPose skeleton in, trimmed latent out, driving audio carried over', () => {
    const wf: ComfyGraph = buildMotionWorkflow(motion(), 7, FULL_NODES)
    const types = classTypes(wf)
    for (const t of ['LoadVideo', 'GetVideoComponents', 'DWPreprocessor', 'WanAnimateToVideo', 'TrimVideoLatent', 'CreateVideo']) {
      expect(types).toContain(t)
    }
    const trim = nodeOfType(wf, 'TrimVideoLatent')
    expect(Array.isArray(trim.inputs.trim_amount)).toBe(true)
    expect(arrInput(trim, 'trim_amount')[1]).toBe(3)
    const components = Object.entries(wf).find(([, n]) => n.class_type === 'GetVideoComponents')![0]
    expect(nodeOfType(wf, 'CreateVideo').inputs.audio).toEqual([components, 1])
  })

  it('routes VACE models through WanVaceToVideo with the skeleton as control video', () => {
    const wf: ComfyGraph = buildMotionWorkflow(motion({ model: 'wan2.1_vace_1.3B_fp16.safetensors' }), 7, FULL_NODES)
    const types = classTypes(wf)
    expect(types).toContain('WanVaceToVideo')
    expect(types).not.toContain('WanAnimateToVideo')
  })

  it('hints the controlnet_aux install when DWPose is missing', () => {
    try {
      buildMotionWorkflow(motion(), 7, nodesWithout('DWPreprocessor'))
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowUnavailableError)
      expect((e as WorkflowUnavailableError).installHint?.pack).toBe('comfyui_controlnet_aux')
    }
  })
})
