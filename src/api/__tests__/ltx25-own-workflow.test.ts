/**
 * GitHub #196: the LTX 2.5 image-to-video template of Comfy-Org runs in
 * ComfyUI but not in LU. What LU did wrong with it, one case each:
 *   - every VAE and CLIP loader got the one file LU picked, though the
 *     workflow needs a video and an audio VAE, a text encoder and a prompt
 *     enhancer;
 *   - without a KSampler the first CLIPTextEncode counted as the positive
 *     prompt, and in the template that is the negative one;
 *   - the size is set by a ResolutionSelector (aspect ratio and megapixels),
 *     so a portrait run still came out 16:9.
 * At the end the real template file goes the whole way: import through the
 * node definitions of ComfyUI v0.42.4, parameter detection, injection.
 *
 * Run: npx vitest run src/api/__tests__/ltx25-own-workflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComfyApiGraph } from '../../types/comfy-graph'
import type { ComfyNodeDefs } from '../comfy-ui-format'
import type { VideoParams } from '../comfyui'

const installed = {
  vae: ['ltx-2.5-audio-vae-bf16.safetensors', 'ltx-2.5-video-vae-bf16.safetensors'],
  clip: ['gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 'gemma4_e2b_it_int8_convrot.safetensors'],
}

vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  getVAEModels: vi.fn(async () => installed.vae),
  getCLIPModels: vi.fn(async () => installed.clip),
  findMatchingVAE: vi.fn(async () => 'lu_pick_vae.safetensors'),
  findMatchingCLIP: vi.fn(async () => 'lu_pick_clip.safetensors'),
}))

const { autoDetectParameterMap, injectParameters, parseImportedWorkflow } = await import('../workflows')
const { readWorkflowText } = await import('../workflow-import')
const { luSetInputs, paramKey } = await import('../workflow-params')

const portrait: VideoParams = {
  prompt: 'a lighthouse at dusk', negativePrompt: 'blurry', model: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  sampler: 'euler', scheduler: 'simple', steps: 8, cfgScale: 1,
  width: 480, height: 832, seed: 7, batchSize: 1, frames: 121, fps: 24,
  inputImage: 'upload_1.png',
}

beforeEach(() => {
  installed.vae = ['ltx-2.5-audio-vae-bf16.safetensors', 'ltx-2.5-video-vae-bf16.safetensors']
  installed.clip = ['gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 'gemma4_e2b_it_int8_convrot.safetensors']
})

// An API graph shaped like the template, small: the negative encoder comes
// first, the positive text arrives over a wire from a prompt box, the
// conditioning runs through LTXVConditioning into a guider, no KSampler.
function ltxGraph(): ComfyApiGraph {
  return {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'ugly, cartoon', clip: ['5', 0] } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: ['8', 0], clip: ['5', 0] } },
    '3': { class_type: 'LTXVConditioning', inputs: { positive: ['2', 0], negative: ['1', 0], frame_rate: 24 } },
    '4': { class_type: 'CFGGuider', inputs: { model: ['9', 0], positive: ['3', 0], negative: ['3', 1], cfg: 1 } },
    '5': { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv', device: 'default' } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-video-vae-bf16.safetensors' } },
    '7': { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-audio-vae-bf16.safetensors' } },
    '8': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a robot on a roof' } },
    '9': { class_type: 'UNETLoader', inputs: { unet_name: 'ltx.safetensors', weight_dtype: 'default' } },
    '10': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 0.9, multiple: 32 } },
    '11': { class_type: 'CLIPLoader', inputs: { clip_name: 'gemma4_e2b_it_int8_convrot.safetensors', type: 'ltxv', device: 'default' } },
  }
}

describe('VAE and CLIP loaders keep the files the workflow names', () => {
  it('a video and an audio VAE, a text encoder and an enhancer all stay as they are', async () => {
    const wf = ltxGraph()
    const sent = await injectParameters(wf, autoDetectParameterMap(wf), portrait, 'ltx25')
    expect(sent['6'].inputs?.vae_name).toBe('ltx-2.5-video-vae-bf16.safetensors')
    expect(sent['7'].inputs?.vae_name).toBe('ltx-2.5-audio-vae-bf16.safetensors')
    expect(sent['5'].inputs?.clip_name).toBe('gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors')
    expect(sent['11'].inputs?.clip_name).toBe('gemma4_e2b_it_int8_convrot.safetensors')
    expect(sent['5'].inputs?.type).toBe('ltxv')
  })

  it('only a file this ComfyUI lacks is replaced by LU\'s pick', async () => {
    installed.vae = ['ltx-2.5-video-vae-bf16.safetensors']
    installed.clip = []
    const wf = ltxGraph()
    const sent = await injectParameters(wf, autoDetectParameterMap(wf), portrait, 'ltx25')
    expect(sent['6'].inputs?.vae_name).toBe('ltx-2.5-video-vae-bf16.safetensors')
    expect(sent['7'].inputs?.vae_name).toBe('lu_pick_vae.safetensors')
    expect(sent['5'].inputs?.clip_name).toBe('lu_pick_clip.safetensors')
  })

  it('a VAE the user chose still wins', async () => {
    const wf = ltxGraph()
    const sent = await injectParameters(wf, autoDetectParameterMap(wf), portrait, 'ltx25', { '7': { vae_name: 'mine.safetensors' } })
    expect(sent['7'].inputs?.vae_name).toBe('mine.safetensors')
  })
})

describe('prompt roles come from the wires, not from the order of the encoders', () => {
  it('positive through LTXVConditioning and a guider, its text from the prompt box upstream', () => {
    const map = autoDetectParameterMap(ltxGraph())
    expect(map.positivePrompt).toEqual({ nodeId: '8', inputKey: 'value' })
    expect(map.negativePrompt).toEqual({ nodeId: '1', inputKey: 'text' })
  })

  it('the prompt lands in the positive path and the wire to the encoder stays', async () => {
    const wf = ltxGraph()
    const sent = await injectParameters(wf, autoDetectParameterMap(wf), portrait, 'ltx25')
    expect(sent['8'].inputs?.value).toBe('a lighthouse at dusk')
    expect(sent['2'].inputs?.text).toEqual(['8', 0])
    expect(sent['1'].inputs?.text).toBe('blurry')
  })

  it('a map saved by an older LU with the roles swapped is mended on the run', async () => {
    const wf = ltxGraph()
    const stale = { ...autoDetectParameterMap(wf), positivePrompt: { nodeId: '1', inputKey: 'text' }, negativePrompt: { nodeId: '2', inputKey: 'text' } }
    const sent = await injectParameters(wf, stale, portrait, 'ltx25')
    expect(sent['1'].inputs?.text).toBe('blurry')
    expect(sent['8'].inputs?.value).toBe('a lighthouse at dusk')
    expect(sent['2'].inputs?.text).toEqual(['8', 0])
    // And the list of editable values agrees with the run.
    expect(luSetInputs(wf, stale).get(paramKey('8', 'value'))?.label).toBe('Prompt')
  })

  it('a KSampler workflow keeps its prompts as before', () => {
    const wf: ComfyApiGraph = {
      '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['7', 0], negative: ['6', 0], denoise: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['4', 1] } },
    }
    const map = autoDetectParameterMap(wf)
    expect(map.positivePrompt).toEqual({ nodeId: '7', inputKey: 'text' })
    expect(map.negativePrompt).toEqual({ nodeId: '6', inputKey: 'text' })
  })
})

describe('ResolutionSelector follows LU\'s size', () => {
  it('portrait picks 9:16 and keeps the megapixels of the workflow', async () => {
    const wf = ltxGraph()
    const sent = await injectParameters(wf, autoDetectParameterMap(wf), portrait, 'ltx25')
    expect(sent['10'].inputs?.aspect_ratio).toBe('9:16 (Portrait Widescreen)')
    expect(sent['10'].inputs?.megapixels).toBe(0.9)
    expect(luSetInputs(wf, autoDetectParameterMap(wf)).get(paramKey('10', 'aspect_ratio'))?.label).toBe('Aspect ratio')
  })

  it('square and landscape sizes find their option too', async () => {
    const wf = ltxGraph()
    const map = autoDetectParameterMap(wf)
    expect((await injectParameters(wf, map, { ...portrait, width: 1024, height: 1024 }, 'ltx25'))['10'].inputs?.aspect_ratio).toBe('1:1 (Square)')
    expect((await injectParameters(wf, map, { ...portrait, width: 1216, height: 832 }, 'ltx25'))['10'].inputs?.aspect_ratio).toBe('3:2 (Photo)')
  })

  it('a workflow with a width and height to write leaves the selector alone', async () => {
    const wf = { ...ltxGraph(), '12': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 576, batch_size: 1 } } }
    const sent = await injectParameters(wf, autoDetectParameterMap(wf), portrait, 'ltx25')
    expect(sent['12'].inputs?.width).toBe(480)
    expect(sent['10'].inputs?.aspect_ratio).toBe('16:9 (Widescreen)')
  })
})

// ── The real template ───────────────────────────────────────────
//
// templates/video_ltx2_5_i2v.json is the file of Comfy-Org/workflow_templates
// as it is (templates/SOURCE.md: commit, checksum, license). The node
// definitions are object-info-ltx25.json, written down from the ComfyUI
// v0.42.4 sources, with the loader lists holding the files the template
// names, as on a machine that has them.

const DIR = join(process.cwd(), 'src/api/__tests__/fixtures/comfy-ui')
const v3 = JSON.parse(readFileSync(join(DIR, 'object-info-ltx25.json'), 'utf8')) as ComfyNodeDefs
const templateText = readFileSync(join(DIR, 'templates/video_ltx2_5_i2v.json'), 'utf8')
const fromV3 = async (types: string[]) => {
  const out: ComfyNodeDefs = {}
  for (const t of types) if (v3[t]) out[t] = v3[t]
  return out
}

describe('the LTX 2.5 i2v template of Comfy-Org, import to injection', () => {
  it('goes from file to the graph LU sends, with the prompt, files and aspect ratio right', async () => {
    const read = await readWorkflowText(templateText, fromV3)
    if (!read.ok) throw new Error(`import failed: ${read.reason}`)
    expect(read.format).toBe('ui')
    expect(read.notes).toEqual(['1 subgraph unpacked', '4 notes left out'])

    const t = parseImportedWorkflow('LTX 2.5 i2v', read.graph)
    expect(t.mode).toBe('video')
    expect(t.parameterMap.positivePrompt).toEqual({ nodeId: '398:376', inputKey: 'value' })
    expect(t.parameterMap.negativePrompt).toEqual({ nodeId: '398:373', inputKey: 'text' })
    expect(t.parameterMap.inputImage).toEqual({ nodeId: '395', inputKey: 'image' })
    expect(t.parameterMap.model).toEqual({ nodeId: '398:384', inputKey: 'unet_name', loaderType: 'unet' })

    const sent = await injectParameters(t.workflow, t.parameterMap, portrait, 'ltx25')
    // The prompt box feeds the enhancer and the switch, the switch the encoder.
    expect(sent['398:376'].inputs?.value).toBe('a lighthouse at dusk')
    expect(sent['398:364'].inputs?.text).toEqual(['398:382', 0])
    expect(sent['398:380'].inputs?.prompt).toEqual(['398:376', 0])
    expect(sent['398:373'].inputs?.text).toBe('blurry')
    // Both VAEs and both text models as the template names them.
    expect(sent['398:385'].inputs?.vae_name).toBe('ltx-2.5-video-vae-bf16.safetensors')
    expect(sent['398:386'].inputs?.vae_name).toBe('ltx-2.5-audio-vae-bf16.safetensors')
    expect(sent['398:387'].inputs).toMatchObject({ clip_name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', type: 'ltxv' })
    expect(sent['398:393'].inputs).toMatchObject({ clip_name: 'gemma4_e2b_it_int8_convrot.safetensors', type: 'ltxv' })
    // Portrait size, the template's 0.9 megapixels.
    expect(sent['403'].inputs).toMatchObject({ aspect_ratio: '9:16 (Portrait Widescreen)', megapixels: 0.9, multiple: 32 })
    expect(sent['395'].inputs?.image).toBe('upload_1.png')
    // The V3 inputs went through under the names ComfyUI expects.
    expect(sent['398:380'].inputs).toMatchObject({ sampling_mode: 'on', 'sampling_mode.temperature': 0.7, 'sampling_mode.seed': 0 })
    expect(sent['398:378'].inputs).toMatchObject({ expression: 'a * b + 1', 'values.a': ['398:362', 0], 'values.b': ['398:361', 0] })
    expect(sent['398:351'].inputs).toMatchObject({ resize_type: 'scale longer dimension', 'resize_type.longer_size': 1536, scale_method: 'lanczos' })
    expect(sent['398:366'].inputs).toMatchObject({ frame_rate: ['398:359', 1], batch_size: 1 })
    expect(sent['75'].inputs).toMatchObject({ format: 'auto', 'format.codec': 'auto' })
  })
})
