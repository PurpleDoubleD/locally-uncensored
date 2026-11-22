/**
 * Qwen-Image 2.1: one local model for generating AND editing.
 *
 * The model is a single 7B DiT that writes a picture from a prompt and edits
 * one from a reference picture plus a prompt, through the node
 * TextEncodeQwenImage21 that ComfyUI 0.37.0 added. Both official Comfy-Org
 * templates route the prompt through that node, so the lane needs it either
 * way, and an older ComfyUI is told so instead of getting a graph it would
 * reject.
 *
 * Everything asserted here was read off the real sources on 2026-09-21, not
 * guessed:
 *   - templates/image_qwen_image_2_1_t2i.json and
 *     templates/image_qwen_image_2_1_image_edit.json (Comfy-Org/workflow_templates)
 *     for the node chain, the slot order and the sampler numbers
 *   - comfy_extras/nodes_qwen.py for the input ids and the three outputs
 *   - comfy_api/latest/_io.py for the dotted id of the reference slots: the
 *     Autogrow group is "images", the slots are image_1 to image_16, and the
 *     API id is the two joined with a dot
 *
 * These build the real graph against a mocked /object_info rather than reading
 * the builder's source as text, which is what wan22-workflow.test.ts does: a
 * renamed input has to break a test, not quietly read as undefined.
 *
 * Run: npx vitest run src/api/__tests__/qwen-image-21-workflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  // comfyuiUrl reads `window` (isTauri), so stub it for the node test env.
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow, determineStrategy } from '../dynamic-workflow'
import { categorizeNodes, getAllNodeInfo, type CategorizedNodes, type AvailableModels } from '../comfyui-nodes'
import {
  classifyModel, isImageModelType, isVideoModelType, findMatchingVAE, findMatchingCLIP,
  COMPONENT_REGISTRY, MODEL_TYPE_DEFAULTS,
} from '../comfyui'
import { getImageBundles } from '../discover'
import { localFetch } from '../backend'
import { nodeOf, nodesOf } from './graph-test-support'
import { QWEN21_OFFICIAL_MODEL as OFFICIAL_MODEL, NOCT_Q_MODEL, QWEN21_WEIGHTS } from './qwen21-weights'

const ENCODER = 'qwen3vl_8b_int8_convrot.safetensors'
const VAE_FILE = 'qwen_image_2.1_vae_bf16.safetensors'

/** Minimal /object_info for a ComfyUI new enough to run Qwen-Image 2.1, with
 *  one image model file in the UNETLoader. */
const qwenNodes = (model: string) => ({
  UNETLoader: { input: { required: { unet_name: [[model]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } },
  TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } },
  EmptyLatentImage: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
})
const OFFICIAL_NODES = qwenNodes(OFFICIAL_MODEL)

const paramsFor = (model: string) => ({
  model,
  prompt: 'a red apple on a white plate', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 25, cfgScale: 1, width: 1024, height: 1024, seed: 42, batchSize: 1,
})

const emptyModels: AvailableModels = {
  checkpoints: [], unets: [OFFICIAL_MODEL], vaes: [VAE_FILE], clips: [ENCODER], motionModels: [],
}

function serveEnums(vaes: string[] = [VAE_FILE], clips: string[] = [ENCODER]) {
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      CLIPLoader: { input: { required: { clip_name: [clips] } } },
      VAELoader: { input: { required: { vae_name: [vaes] } } },
    }),
  } as never)
}

// ── Classification ──────────────────────────────────────────────────────

describe('Qwen-Image 2.1 classification', () => {
  it('names the catalogue file and the spelling variants', () => {
    expect(classifyModel(OFFICIAL_MODEL)).toBe('qwenimage')
    expect(classifyModel('qwen_image_2.1_bf16.safetensors')).toBe('qwenimage')
    expect(classifyModel('Qwen-Image-2.1-Q8_0.gguf')).toBe('qwenimage')
    expect(classifyModel('qwenimage_2_1_w4a8.safetensors')).toBe('qwenimage')
  })

  // Noct Q is a Qwen-Image 2.1 finetune whose file names say neither "qwen"
  // nor "2.1": the Hugging Face name, a CivitAI style name, a subfolder.
  it('names the Noct Q finetune under the names it is published with', () => {
    expect(classifyModel(NOCT_Q_MODEL)).toBe('qwenimage')
    expect(classifyModel('NoctQ_V3_base_int8_convrot.safetensors')).toBe('qwenimage')
    expect(classifyModel('noctQ_v4.safetensors')).toBe('qwenimage')
    expect(classifyModel('noctQQwenImage21_v4Int8.safetensors')).toBe('qwenimage')
    expect(classifyModel('Noct-Q-V4-fp8.safetensors')).toBe('qwenimage')
    expect(classifyModel('noct_q_v4_bf16.safetensors')).toBe('qwenimage')
    expect(classifyModel('qwen\\NoctQ_V4_int8_convrot.safetensors')).toBe('qwenimage')
  })

  it('COUNTER-CHECK: a name that merely starts like Noct Q is not taken for it', () => {
    expect(classifyModel('noctquartz_xl.safetensors')).not.toBe('qwenimage')
    expect(classifyModel('equinoctq.safetensors')).not.toBe('qwenimage')
    expect(classifyModel('noctaluna_style_sdxl.safetensors')).not.toBe('qwenimage')
  })

  // The regression that matters: this classifier also sees VAE and text
  // encoder filenames (the addon inventory lane runs every folder through it).
  it('does NOT swallow the text encoder or any companion file', () => {
    expect(classifyModel(ENCODER)).not.toBe('qwenimage')
    expect(classifyModel('qwen3vl_8b_bf16.safetensors')).not.toBe('qwenimage')
    expect(classifyModel('qwen3vl_4b_fp8_scaled.safetensors')).not.toBe('qwenimage')
    expect(classifyModel('qwen_3_4b.safetensors')).not.toBe('qwenimage')
    expect(classifyModel('qwen_2.5_vl_7b_fp8_scaled.safetensors')).not.toBe('qwenimage')
    // Krea 2's companion autoencoder shares the stem and carries no version.
    expect(classifyModel('qwen_image_vae.safetensors')).not.toBe('qwenimage')
  })

  it('keeps the older Qwen-Image generations off the 2.1 pipeline (they have their own)', () => {
    expect(classifyModel('qwen_image_fp8_e4m3fn.safetensors')).toBe('qwenimage1')
    expect(classifyModel('qwen_image_edit_2509_fp8.safetensors')).toBe('qwenimage1')
    expect(classifyModel('qwen_image_2512_bf16.safetensors')).toBe('qwenimage1')
    expect(classifyModel('qwen_image_vae.safetensors')).toBe('unknown')
  })

  it('is an image model type, so it shows in Generate AND in Edit', () => {
    expect(isImageModelType('qwenimage')).toBe(true)
    expect(isVideoModelType('qwenimage')).toBe(false)
  })
})

// ── Defaults ────────────────────────────────────────────────────────────

describe('Qwen-Image 2.1 defaults (from the official templates)', () => {
  const d = MODEL_TYPE_DEFAULTS.qwenimage

  it('25 steps, CFG 1, euler, simple, 1024x1024', () => {
    expect(d.steps).toBe(25)
    expect(d.cfg).toBe(1)
    expect(d.sampler).toBe('euler')
    expect(d.scheduler).toBe('simple')
    expect(d.width).toBe(1024)
    expect(d.height).toBe(1024)
  })

  it('is an image entry, so one frame', () => {
    expect(d.frames).toBe(1)
    expect(d.fps).toBe(1)
  })
})

// ── COMPONENT_REGISTRY ──────────────────────────────────────────────────

describe('Qwen-Image 2.1 COMPONENT_REGISTRY', () => {
  const entry = COMPONENT_REGISTRY.qwenimage

  it('UNET plus a separate VAE and text encoder, CLIPLoader type qwen_image', () => {
    expect(entry).toBeDefined()
    expect(entry.loader).toBe('UNETLoader')
    expect(entry.needsSeparateVAE).toBe(true)
    expect(entry.needsSeparateCLIP).toBe(true)
    expect(entry.clipType).toBe('qwen_image')
  })

  it('names the two companion files the bundle actually ships', () => {
    expect(entry.vae?.downloadFilename).toBe(VAE_FILE)
    expect(entry.clip?.downloadFilename).toBe(ENCODER)
    expect(entry.vae?.subfolder).toBe('vae')
    expect(entry.clip?.subfolder).toBe('text_encoders')
    expect(entry.vae?.downloadUrl).toMatch(/^https:\/\/huggingface\.co\/Comfy-Org\/Qwen-Image-2\.1\//)
    expect(entry.clip?.downloadUrl).toMatch(/^https:\/\/huggingface\.co\/Comfy-Org\/Qwen-Image-2\.1\//)
  })
})

// ── Strategy gate ───────────────────────────────────────────────────────

describe('determineStrategy, the Qwen-Image 2.1 gate', () => {
  const full: CategorizedNodes = categorizeNodes(OFFICIAL_NODES as never)

  it('routes to unet_qwenimage when the loaders and the encode node are there', () => {
    const r = determineStrategy('qwenimage', false, full, emptyModels)
    expect(r.strategy).toBe('unet_qwenimage')
  })

  // The sentence is the whole point of the branch: a user on ComfyUI 0.36 has
  // one thing to do, and the message says what and where.
  it('without TextEncodeQwenImage21 it names the version and where to update', () => {
    const old: CategorizedNodes = { ...full, textEncoders: full.textEncoders.filter(n => n !== 'TextEncodeQwenImage21') }
    const r = determineStrategy('qwenimage', false, old, emptyModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toBe('Qwen-Image 2.1 needs ComfyUI 0.37.0 or newer. Update ComfyUI in Settings.')
  })

  it('without the loaders it says which loaders, not which version', () => {
    const bare: CategorizedNodes = { ...full, loaders: [] }
    const r = determineStrategy('qwenimage', false, bare, emptyModels)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toContain('UNETLoader')
    expect(r.reason).not.toContain('0.37.0')
  })
})

// ── The generate graph ──────────────────────────────────────────────────

describe.each(QWEN21_WEIGHTS)('buildDynamicWorkflow, Qwen-Image 2.1 generate (no reference image), %s', (_weights, MODEL) => {
  const QWEN_NODES = qwenNodes(MODEL)
  const baseParams = paramsFor(MODEL)
  beforeEach(() => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(QWEN_NODES as never)
    serveEnums()
  })

  it('loads UNET, CLIPLoader(qwen_image) and the 2.1 VAE from the live enum', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams } as never)
    expect(nodeOf(wf, 'UNETLoader')![1].inputs.unet_name).toBe(MODEL)
    const clip = nodeOf(wf, 'CLIPLoader')![1]
    expect(clip.inputs.clip_name).toBe(ENCODER)
    expect(clip.inputs.type).toBe('qwen_image')
    expect(nodeOf(wf, 'VAELoader')![1].inputs.vae_name).toBe(VAE_FILE)
  })

  it('encodes through ONE TextEncodeQwenImage21 and no CLIPTextEncode at all', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams } as never)
    const encodes = nodesOf(wf, 'TextEncodeQwenImage21')
    expect(encodes).toHaveLength(1)
    const enc = encodes[0][1]
    expect(enc.inputs.prompt).toBe(baseParams.prompt)
    expect(enc.inputs.negative_prompt).toBe('')
    expect(enc.inputs.clip).toEqual([nodeOf(wf, 'CLIPLoader')![0], 0])
    // The t2i template attaches neither: no reference image means no reference
    // latents, and the node keeps its vision path instead.
    expect(enc.inputs.vae).toBeUndefined()
    expect(enc.inputs['images.image_1']).toBeUndefined()
    // resolution is a REQUIRED widget of the node, so it has to be there even
    // on the path that never reads it. Leaving it off gets the whole prompt
    // rejected with "Required input is missing".
    expect(enc.inputs.resolution).toBe(1024)
    expect(nodeOf(wf, 'CLIPTextEncode')).toBeUndefined()
    expect(nodeOf(wf, 'LoadImage')).toBeUndefined()
  })

  it('the sampler reads positive from slot 0 and negative from slot 1 of that one node', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams } as never)
    const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const ks = nodeOf(wf, 'KSampler')![1]
    expect(ks.inputs.positive).toEqual([encId, 0])
    expect(ks.inputs.negative).toEqual([encId, 1])
    expect(ks.inputs.denoise).toBe(1.0)
    expect(ks.inputs.cfg).toBe(1)
    expect(ks.inputs.steps).toBe(25)
    expect(ks.inputs.sampler_name).toBe('euler')
    expect(ks.inputs.scheduler).toBe('simple')
  })

  it('takes its latent from EmptyLatentImage at the requested canvas', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, width: 1536, height: 864 } as never)
    const [latentId, latent] = nodeOf(wf, 'EmptyLatentImage')!
    expect(latent.inputs.width).toBe(1536)
    expect(latent.inputs.height).toBe(864)
    expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([latentId, 0])
  })

  // ComfyUI rejects a whole prompt when ANY required input of a node is
  // absent ("Required input is missing", execution.py validate_inputs), and
  // that happens before a single step is sampled. The node's required set is
  // clip, prompt, negative_prompt and resolution, so the guard is asserted
  // against the schema rather than against a list typed out by hand.
  it('carries every input the node declares as required, on both paths', async () => {
    const required = Object.keys(QWEN_NODES.TextEncodeQwenImage21.input.required)
    for (const params of [baseParams, { ...baseParams, inputImage: 'lu_source.png', denoise: 0.7 }]) {
      const wf = await buildDynamicWorkflow({ ...params } as never)
      const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
      for (const key of required) {
        expect(enc.inputs[key], `${key} missing`).toBeDefined()
      }
    }
  })

  it('decodes and saves like every other image lane', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams } as never)
    const [decodeId] = nodeOf(wf, 'VAEDecode')!
    expect(nodeOf(wf, 'VAEDecode')![1].inputs.vae).toEqual([nodeOf(wf, 'VAELoader')![0], 0])
    expect(nodeOf(wf, 'SaveImage')![1].inputs.images).toEqual([decodeId, 0])
  })
})

// ── The edit graph ──────────────────────────────────────────────────────

describe.each(QWEN21_WEIGHTS)('buildDynamicWorkflow, Qwen-Image 2.1 edit (one reference image), %s', (_weights, MODEL) => {
  const QWEN_NODES = qwenNodes(MODEL)
  const baseParams = paramsFor(MODEL)
  beforeEach(() => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(QWEN_NODES as never)
    serveEnums()
  })

  // denoise 0.7 is what the Edit lane sends by default. On every other image
  // strategy that turns the picture into the sampler's starting latent; here
  // it must not, or an edit instruction silently becomes latent img2img.
  const editParams = { ...baseParams, prompt: 'put a blue hat on the person', inputImage: 'lu_source.png', denoise: 0.7 }

  it('feeds the reference into the encode node under its dotted API id', async () => {
    const wf = await buildDynamicWorkflow({ ...editParams } as never)
    const [loadId, load] = nodeOf(wf, 'LoadImage')!
    expect(load.inputs.image).toBe('lu_source.png')
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    expect(enc.inputs['images.image_1']).toEqual([loadId, 0])
    expect(enc.inputs.prompt).toBe('put a blue hat on the person')
  })

  it('attaches the VAE, so the reference arrives as reference latents', async () => {
    const wf = await buildDynamicWorkflow({ ...editParams } as never)
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    expect(enc.inputs.vae).toEqual([nodeOf(wf, 'VAELoader')![0], 0])
  })

  it('takes the latent from slot 2 and drops the empty one', async () => {
    const wf = await buildDynamicWorkflow({ ...editParams } as never)
    const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
    expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([encId, 2])
    expect(nodeOf(wf, 'EmptyLatentImage')).toBeUndefined()
  })

  it('never builds the generic img2img chain, and samples at denoise 1', async () => {
    const wf = await buildDynamicWorkflow({ ...editParams } as never)
    expect(nodeOf(wf, 'VAEEncode')).toBeUndefined()
    expect(nodeOf(wf, 'VAEEncodeForInpaint')).toBeUndefined()
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1.0)
  })

  it('folds the requested canvas into the resolution budget, on a step of 32', async () => {
    const square = await buildDynamicWorkflow({ ...editParams } as never)
    expect(nodeOf(square, 'TextEncodeQwenImage21')![1].inputs.resolution).toBe(1024)
    // 1536 x 864 is 1.33 megapixels, so a side length of about 1152.
    const wide = await buildDynamicWorkflow({ ...editParams, width: 1536, height: 864 } as never)
    const res = nodeOf(wide, 'TextEncodeQwenImage21')![1].inputs.resolution as number
    expect(res % 32).toBe(0)
    expect(res).toBe(1152)
  })

  // Not built in this cut: the node takes no mask, so the existing lock has to
  // keep holding rather than letting a painted mask fall on the floor.
  it('a painted mask is refused, not dropped', async () => {
    await expect(buildDynamicWorkflow({ ...editParams, maskImage: 'lu_mask.png' } as never))
      .rejects.toThrow(/Local image editing needs an SD 1.5 \/ SDXL checkpoint/)
  })
})

// ── Companion resolution ────────────────────────────────────────────────

describe.each(QWEN21_WEIGHTS)('the resolvers pick the 2.1 files, and leave Krea 2 its own, %s', (_weights, MODEL) => {
  beforeEach(() => { vi.mocked(getAllNodeInfo).mockResolvedValue(qwenNodes(MODEL) as never) })

  // A box can hold both families at once now that both are in the Model
  // Manager, and their companion filenames are one tier apart.
  const bothVaes = ['qwen_image_vae.safetensors', VAE_FILE]
  const bothClips = ['qwen3vl_4b_fp8_scaled.safetensors', ENCODER]

  it('Qwen-Image 2.1 takes the 2.1 autoencoder and the 8B encoder', async () => {
    serveEnums(bothVaes, bothClips)
    expect(await findMatchingVAE('qwenimage')).toBe(VAE_FILE)
    expect(await findMatchingCLIP('qwenimage', MODEL)).toBe(ENCODER)
  })

  it('Krea 2 takes the older autoencoder and the 4B encoder', async () => {
    serveEnums(bothVaes, bothClips)
    expect(await findMatchingVAE('krea2')).toBe('qwen_image_vae.safetensors')
    expect(await findMatchingCLIP('krea2', 'krea-2-dev-fp8.safetensors')).toBe('qwen3vl_4b_fp8_scaled.safetensors')
  })

  it('with only the 2.1 files installed, Krea 2 says what to download instead of loading them', async () => {
    serveEnums([VAE_FILE], [ENCODER])
    await expect(findMatchingVAE('krea2')).rejects.toThrow(/Krea 2 VAE/)
    await expect(findMatchingCLIP('krea2', 'krea-2-dev-fp8.safetensors')).rejects.toThrow(/Krea 2 text encoder/)
  })

  it('with only Krea 2s files installed, Qwen-Image 2.1 says what to download', async () => {
    serveEnums(['qwen_image_vae.safetensors'], ['qwen3vl_4b_fp8_scaled.safetensors'])
    await expect(findMatchingVAE('qwenimage')).rejects.toThrow(new RegExp(VAE_FILE.replace(/\./g, '\\.')))
    await expect(findMatchingCLIP('qwenimage', MODEL)).rejects.toThrow(new RegExp(ENCODER))
  })
})

// ── The Model Manager bundle ────────────────────────────────────────────

describe('Qwen-Image 2.1 bundle', () => {
  const bundle = getImageBundles().find(b => b.workflow === 'qwenimage')

  it('exists exactly once, next to the edition with the other text encoder and the Noct Q finetune', () => {
    // The two prompt enhancer add-ons share the family and carry no model file.
    const withModel = getImageBundles().filter(b => b.workflow === 'qwenimage' && b.files.some(f => f.subfolder === 'diffusion_models'))
    expect(withModel.map(b => b.name)).toEqual(['Qwen-Image 2.1 (Generate and Edit)', 'Qwen-Image 2.1 (No Filter)', 'Noct Q (Qwen-Image 2.1, Unfiltered)'])
    expect(withModel[0].name).toBe(bundle!.name)
    expect(bundle).toBeDefined()
  })

  it('ships the three files the graph loads, in the three folders it reads', () => {
    const byFolder = Object.fromEntries(bundle!.files.map(f => [f.subfolder, f.filename]))
    expect(bundle!.files).toHaveLength(3)
    expect(byFolder.diffusion_models).toBe(OFFICIAL_MODEL)
    expect(byFolder.text_encoders).toBe(ENCODER)
    expect(byFolder.vae).toBe(VAE_FILE)
  })

  it('every address points at the Comfy-Org repack', () => {
    for (const f of bundle!.files) {
      expect(f.downloadUrl).toMatch(/^https:\/\/huggingface\.co\/Comfy-Org\/Qwen-Image-2\.1\/resolve\/main\//)
    }
  })

  // The size is the install criterion (checkBundleInstalled multiplies it by
  // 1_073_741_824 and demands the file be that big), so these are the measured
  // byte counts in gibibytes, not the decimal figures on the file listing.
  it('the declared sizes are the measured ones, and the total is their sum', () => {
    const bytes: Record<string, number> = {
      [OFFICIAL_MODEL]: 7_256_783_064,
      [ENCODER]: 9_350_798_360,
      [VAE_FILE]: 675_509_688,
    }
    let sum = 0
    for (const f of bundle!.files) {
      const gib = bytes[f.filename!] / 1_073_741_824
      expect(Math.abs(f.sizeGB! - gib), f.filename).toBeLessThan(0.01)
      sum += f.sizeGB!
    }
    expect(Math.abs(bundle!.totalSizeGB - sum)).toBeLessThan(0.05)
  })

  it('states the licence, non-commercial, with the address to read it', () => {
    expect(bundle!.description).toContain('Qwen Research License, non-commercial use')
    expect(bundle!.description).toContain('https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE')
  })

  it('declares a VRAM figure the fit hint can read', () => {
    expect(bundle!.vramRequired).toMatch(/^\d/)
    expect(Number.parseInt(bundle!.vramRequired, 10)).toBeGreaterThanOrEqual(8)
  })

  it('needs no custom nodes', () => {
    expect(bundle!.customNodes || []).toHaveLength(0)
  })
})

// ── Further references (GH #144) ────────────────────────────────────────

describe.each(QWEN21_WEIGHTS)('buildDynamicWorkflow, Qwen-Image 2.1 edit with further references, %s', (_weights, MODEL) => {
  const QWEN_NODES = qwenNodes(MODEL)
  const baseParams = paramsFor(MODEL)
  beforeEach(() => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(QWEN_NODES as never)
    serveEnums()
  })

  it('the source is image_1 and every reference follows as image_2 and up', async () => {
    const wf = await buildDynamicWorkflow({
      ...baseParams, inputImage: 'scene.png', denoise: 0.7, referenceImages: ['person.png', 'outfit.png'],
    } as never)
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    const loaded = (slot: string) => {
      const [id] = enc.inputs[slot] as [string, number]
      return wf[id].inputs!.image
    }
    expect(loaded('images.image_1')).toBe('scene.png')
    expect(loaded('images.image_2')).toBe('person.png')
    expect(loaded('images.image_3')).toBe('outfit.png')
    expect(enc.inputs['images.image_4']).toBeUndefined()
    expect(nodesOf(wf, 'LoadImage')).toHaveLength(3)
  })

  // Discord help-18, 23.10.2026 ("IMAGE 2 or IMAGE 2.?"): the encoder labels
  // the images <image1>, <image2> (comfy/text_encoders/qwen_image21.py), so
  // every spelling of an image that is there reaches it in that form.
  it('names the images in the prompt as the encoder labels them, <image2>', async () => {
    const wf = await buildDynamicWorkflow({
      ...baseParams, inputImage: 'scene.png', denoise: 0.7, referenceImages: ['person.png', 'outfit.png'],
      prompt: 'the person in IMAGE 1. takes the pose of Image2, wearing the shirt from img #3, not image 4',
      negativePrompt: 'a copy of picture 2',
    } as never)
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    expect(enc.inputs.prompt).toBe('the person in <image1>. takes the pose of <image2>, wearing the shirt from <image3>, not image 4')
    expect(enc.inputs.negative_prompt).toBe('a copy of <image2>')
  })

  it('a generate run keeps the prompt as typed', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, prompt: 'image 2 of a fox' } as never)
    expect(nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.prompt).toBe('image 2 of a fox')
  })

  // Discord D7 / G26: up to ten images in all. The node has slots image_1 to
  // image_16, the model reads ten (lib/edit-references).
  it('takes nine references besides the source, in order, and drops a tenth', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => `ref${i + 2}.png`)
    const wf = await buildDynamicWorkflow({
      ...baseParams, inputImage: 'scene.png', denoise: 0.7, referenceImages: refs,
    } as never)
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    const loaded = (slot: string) => {
      const [id] = enc.inputs[slot] as [string, number]
      return wf[id].inputs!.image
    }
    expect(loaded('images.image_1')).toBe('scene.png')
    for (let i = 2; i <= 10; i++) expect(loaded(`images.image_${i}`)).toBe(`ref${i}.png`)
    expect(enc.inputs['images.image_11']).toBeUndefined()
    expect(nodesOf(wf, 'LoadImage')).toHaveLength(10)
    expect(nodesOf(wf, 'LoadImage').map(([, node]) => node.inputs!.image)).not.toContain('ref11.png')
  })

  it('up to four images in all every image keeps the full side of the canvas', async () => {
    const wf = await buildDynamicWorkflow({
      ...baseParams, inputImage: 'scene.png', denoise: 0.7, referenceImages: ['a.png', 'b.png', 'c.png'],
    } as never)
    expect(nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.resolution).toBe(1024)
  })

  it('past four images they share the pixel budget of four, so ten fit a 12 GB card', async () => {
    const at = async (refs: number, width = 1024, height = 1024) => {
      const wf = await buildDynamicWorkflow({
        ...baseParams, width, height, inputImage: 'scene.png', denoise: 0.7,
        referenceImages: Array.from({ length: refs }, (_, i) => `r${i}.png`),
      } as never)
      return nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.resolution as number
    }
    // 1024 * sqrt(4 / 10) = 647.6, floored to the grid of 32.
    expect(await at(9)).toBe(640)
    // 1024 * sqrt(4 / 5) = 915.9
    expect(await at(4)).toBe(896)
    for (const refs of [4, 6, 9]) {
      const side = await at(refs)
      expect((refs + 1) * side * side).toBeLessThanOrEqual(4 * 1024 * 1024)
      expect(side % 32).toBe(0)
    }
    // A larger canvas keeps its own larger budget: 1536 * sqrt(0.4) = 971.4.
    expect(await at(9, 1536, 1536)).toBe(960)
  })

  // References without a source are not an edit: since B45 (3.0.9) they are
  // the reference images of a text to image run, read by the text encoder,
  // with the picture from the empty latent (create-takes-reference-images).
  it('a generate run takes references as reference images, not as an edit source', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, referenceImages: ['person.png'] } as never)
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    expect(enc.inputs['images.image_1']).toBeDefined()
    expect(nodeOf(wf, 'VAEEncode')).toBeUndefined()
    expect(nodeOf(wf, 'EmptyLatentImage')).toBeDefined()
  })
})
