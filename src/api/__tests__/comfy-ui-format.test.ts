/**
 * GitHub Discussion #124: a workflow saved with the regular ComfyUI "Save" or
 * "Export" (nodes and links, positional widgets_values) imports like an API
 * export. The fixtures are hand-written after the stock ComfyUI templates
 * (SDXL txt2img, Z-Image Turbo, Wan 2.2 14B i2v), the node definitions are an
 * excerpt of what /object_info serves for those nodes. The subgraph cases at
 * the end run on real, unchanged ComfyUI templates (fixtures/comfy-ui/templates).
 *
 * Run: npx vitest run src/api/__tests__/comfy-ui-format.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  convertUiGraph, flattenSubgraphs, isComfyUiGraph, uiGraphNodeTypes, uiGraphProblem,
  type ComfyNodeDefs, type UiGraph, type UiNode,
} from '../comfy-ui-format'
import { autoDetectParameterMap, parseImportedWorkflow } from '../workflows'

const DIR = join(process.cwd(), 'src/api/__tests__/fixtures/comfy-ui')
const load = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T
const defs = load<ComfyNodeDefs>('object-info.json')
const ui = (name: string): UiGraph => {
  const g = load<unknown>(name)
  if (!isComfyUiGraph(g)) throw new Error(`${name} is not a UI graph`)
  return g
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function convertOk(g: UiGraph, d: ComfyNodeDefs = defs) {
  const r = convertUiGraph(g, d)
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`)
  return r
}

describe('isComfyUiGraph', () => {
  it('knows the regular save format', () => {
    expect(isComfyUiGraph(load('sdxl-txt2img.ui.json'))).toBe(true)
    expect(isComfyUiGraph(load('z-image-turbo.ui.json'))).toBe(true)
  })
  it('does not take the API format or junk for it', () => {
    expect(isComfyUiGraph({ '1': { class_type: 'KSampler', inputs: {} } })).toBe(false)
    expect(isComfyUiGraph({ nodes: [] })).toBe(false)
    expect(isComfyUiGraph({ nodes: [{ id: 1 }] })).toBe(false)
    expect(isComfyUiGraph(null)).toBe(false)
  })
})

describe('SDXL txt2img (reroute, primitive, bypassed LoRA, note, stray node)', () => {
  const r = convertOk(ui('sdxl-txt2img.ui.json'))

  it('produces exactly the graph the ComfyUI canvas would queue', () => {
    expect(r.graph).toEqual({
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }, _meta: { title: 'Load Checkpoint' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'beautiful scenery nature glass bottle landscape, purple galaxy bottle', clip: ['4', 1] }, _meta: { title: 'Positive' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['4', 1] }, _meta: { title: 'Negative' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: 'Empty Latent Image' } },
      '3': {
        class_type: 'KSampler',
        inputs: {
          model: ['4', 0], seed: 123456789, steps: 25, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras',
          positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], denoise: 1,
        },
        _meta: { title: 'KSampler' },
      },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] }, _meta: { title: 'VAE Decode' } },
      '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'sdxl' }, _meta: { title: 'Save Image' } },
    })
  })

  it('says what it left out', () => {
    expect(r.notes).toEqual([
      '1 bypassed node passed through',
      '1 note left out',
      '1 unconnected node left out',
    ])
  })

  it('maps the prompt, sampler and size like an API import does', () => {
    const map = autoDetectParameterMap(r.graph)
    expect(map.positivePrompt).toEqual({ nodeId: '6', inputKey: 'text' })
    expect(map.negativePrompt).toEqual({ nodeId: '7', inputKey: 'text' })
    expect(map.seed).toEqual({ nodeId: '3', inputKey: 'seed' })
    expect(map.model).toEqual({ nodeId: '4', inputKey: 'ckpt_name', loaderType: 'checkpoint' })
    expect(map.width).toEqual({ nodeId: '5', inputKey: 'width' })
  })

  it('uses the LoRA once it is switched on again', () => {
    const g = ui('sdxl-txt2img.ui.json')
    const lora = g.nodes.find((n) => n.type === 'LoraLoader')
    if (!lora) throw new Error('fixture has no LoRA')
    lora.mode = 0
    const on = convertOk(g)
    expect(on.graph['10'].inputs).toEqual({
      model: ['4', 0], clip: ['4', 1], lora_name: 'detail_tweaker_xl.safetensors', strength_model: 0.8, strength_clip: 0.8,
    })
    expect(on.graph['3'].inputs?.model).toEqual(['10', 0])
    expect(on.graph['6'].inputs?.clip).toEqual(['10', 1])
  })
})

describe('Z-Image Turbo (object links, muted preview, markdown note)', () => {
  const r = convertOk(ui('z-image-turbo.ui.json'))

  it('converts every node that runs', () => {
    expect(Object.keys(r.graph).sort()).toEqual(['1', '10', '2', '3', '4', '5', '6', '7', '8', '9'])
    expect(r.graph['2'].inputs).toEqual({ clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' })
    expect(r.graph['4'].inputs).toEqual({ model: ['1', 0], shift: 3 })
    expect(r.graph['8'].inputs).toEqual({
      model: ['4', 0], seed: 884412977313505, steps: 9, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple',
      positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], denoise: 1,
    })
    expect(r.graph['6'].inputs).toEqual({ conditioning: ['5', 0] })
  })

  it('leaves the muted preview out without asking ComfyUI about it', () => {
    expect(uiGraphNodeTypes(ui('z-image-turbo.ui.json'))).toContain('PreviewImage')
    expect(defs.PreviewImage).toBeUndefined()
    expect(r.graph['11']).toBeUndefined()
    expect(r.notes).toEqual(['1 muted node left out', '1 note left out'])
  })

  it('is an image workflow with the UNET loader as its model', () => {
    const t = parseImportedWorkflow('Z-Image', r.graph)
    expect(t.mode).toBe('image')
    expect(t.parameterMap.model).toEqual({ nodeId: '1', inputKey: 'unet_name', loaderType: 'unet' })
  })
})

describe('Wan 2.2 i2v (two advanced samplers, image upload widget, V3 combos)', () => {
  const r = convertOk(ui('wan22-i2v.ui.json'))

  it('skips the seed control and the upload button values', () => {
    expect(r.graph['11'].inputs).toEqual({
      model: ['3', 0], add_noise: 'enable', noise_seed: 438230291, steps: 20, cfg: 3.5,
      sampler_name: 'euler', scheduler: 'simple', positive: ['10', 0], negative: ['10', 1], latent_image: ['10', 2],
      start_at_step: 0, end_at_step: 10, return_with_leftover_noise: 'enable',
    })
    expect(r.graph['12'].inputs).toMatchObject({ add_noise: 'disable', noise_seed: 0, start_at_step: 10, end_at_step: 10000, latent_image: ['11', 0] })
    expect(r.graph['9'].inputs).toEqual({ image: 'portrait.jpg' })
  })

  it('wires optional inputs only when connected', () => {
    expect(r.graph['10'].inputs).toEqual({
      positive: ['7', 0], negative: ['8', 0], vae: ['6', 0], width: 640, height: 640, length: 81, batch_size: 1,
      start_image: ['9', 0],
    })
    expect(r.graph['14'].inputs).toEqual({ images: ['13', 0], fps: 16 })
    expect(r.graph['15'].inputs).toEqual({ video: ['14', 0], filename_prefix: 'video/wan22_i2v', format: 'auto', codec: 'auto' })
  })

  it('maps the source image and size for LU', () => {
    const map = autoDetectParameterMap(r.graph)
    expect(map.inputImage).toEqual({ nodeId: '9', inputKey: 'image' })
    expect(map.positivePrompt?.nodeId).toBe('7')
    expect(map.negativePrompt?.nodeId).toBe('8')
  })
})

describe('what is rejected, with a reason', () => {
  it('a node ComfyUI does not know, naming it', () => {
    const g = ui('sdxl-txt2img.ui.json')
    const d = clone(defs)
    delete d.VAEDecode
    const r = convertUiGraph(g, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ComfyUI does not know these nodes: VAEDecode')
    // The same names as data, for the offer to install their packs (wish #14).
    if (!r.ok) expect(r.missingNodeTypes).toEqual(['VAEDecode'])
  })

  it('settings that do not fit the installed node version', () => {
    const g = ui('sdxl-txt2img.ui.json')
    const ks = g.nodes.find((n) => n.type === 'KSampler')
    if (!ks) throw new Error('no KSampler')
    // An older definition without the control widget value: steps lands on "fixed".
    ks.widgets_values = [123456789, 'fixed', 'fixed', 7, 'dpmpp_2m', 'karras', 1]
    const r = convertUiGraph(g, defs)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/#3 \(KSampler\): the saved settings do not match/)
  })

  it('a required input fed only by a muted node', () => {
    const g = ui('sdxl-txt2img.ui.json')
    const ckpt = g.nodes.find((n) => n.type === 'CheckpointLoaderSimple')
    if (!ckpt) throw new Error('no loader')
    ckpt.mode = 2
    const r = convertUiGraph(g, defs)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('has no "')
  })

  it('a subgraph that cannot be read, before ComfyUI is asked', () => {
    const g = ui('z-image-turbo.ui.json')
    const sgId = '9e2f6a50-1c3b-4d8e-a7f0-5b4c3d2e1f00'
    g.definitions = { subgraphs: [{ id: sgId, name: 'Text to image', nodes: 'broken', links: [] }] }
    g.nodes.push({ id: 20, type: sgId, mode: 0, inputs: [], outputs: [] })
    expect(uiGraphProblem(g)).toMatch(/subgraph used by node #20 .* could not be read/)
    expect(uiGraphNodeTypes(g)).toEqual([])
    const r = convertUiGraph(g, defs)
    expect(r.ok).toBe(false)
  })

  it('a file that only defines a subgraph but never uses it is fine', () => {
    const g = ui('z-image-turbo.ui.json')
    g.definitions = { subgraphs: [{ id: 'unused', nodes: [] }] }
    expect(uiGraphProblem(g)).toBeNull()
    expect(convertUiGraph(g, defs).ok).toBe(true)
  })

  it('legacy group nodes', () => {
    const g = ui('z-image-turbo.ui.json')
    g.nodes.push({ id: 21, type: 'workflow>MyGroup', mode: 0 })
    expect(uiGraphProblem(g)).toMatch(/group nodes/)
  })

  it('a graph without any output node', () => {
    const g = ui('z-image-turbo.ui.json')
    g.nodes = g.nodes.filter((n) => n.type !== 'SaveImage')
    const r = convertUiGraph(g, defs)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no output node/)
  })
})

describe('more canvas helpers', () => {
  it('resolves a KJNodes Set/Get pair to the real source', () => {
    const g = ui('z-image-turbo.ui.json')
    // VAE goes 3 -> SetNode(30) ... GetNode(31) -> VAEDecode instead of a direct wire.
    g.links = (g.links ?? []).filter((l) => !(typeof l === 'object' && l !== null && (l as { id: number }).id === 3))
    g.links.push(
      { id: 30, origin_id: 3, origin_slot: 0, target_id: 30, target_slot: 0, type: 'VAE' },
      { id: 31, origin_id: 31, origin_slot: 0, target_id: 9, target_slot: 1, type: 'VAE' },
    )
    g.nodes.push(
      { id: 30, type: 'SetNode', mode: 0, inputs: [{ name: 'VAE', type: 'VAE', link: 30 }], outputs: [{ name: '*', type: '*' }], widgets_values: ['vae'] },
      { id: 31, type: 'GetNode', mode: 0, inputs: [], outputs: [{ name: 'VAE', type: 'VAE' }], widgets_values: ['vae'] },
    )
    const dec = g.nodes.find((n) => n.type === 'VAEDecode')
    if (!dec?.inputs) throw new Error('no decoder')
    dec.inputs[1].link = 31
    const r = convertOk(g)
    expect(r.graph['9'].inputs?.vae).toEqual(['3', 0])
    expect(r.graph['30']).toBeUndefined()
  })

  it('ignores a canvas-only node with no wires, such as a label', () => {
    const g = ui('z-image-turbo.ui.json')
    g.nodes.push({ id: 40, type: 'Label (rgthree)', mode: 0, inputs: [], outputs: [], widgets_values: [] })
    const r = convertOk(g)
    expect(r.notes).toContain('canvas-only nodes left out: Label (rgthree)')
  })

  it('reads widgets_values stored by name (Video Helper Suite style)', () => {
    const g = ui('z-image-turbo.ui.json')
    const save = g.nodes.find((n) => n.type === 'SaveImage')
    if (!save) throw new Error('no save')
    save.widgets_values = { filename_prefix: 'by-name' }
    expect(convertOk(g).graph['10'].inputs?.filename_prefix).toBe('by-name')
  })

  it('fills a widget the file predates with the definition default', () => {
    const g = ui('z-image-turbo.ui.json')
    const latent = g.nodes.find((n) => n.type === 'EmptySD3LatentImage')
    if (!latent) throw new Error('no latent')
    latent.widgets_values = [768, 1344]
    expect(convertOk(g).graph['7'].inputs).toEqual({ width: 768, height: 1344, batch_size: 1 })
  })
})

// ── Subgraphs ───────────────────────────────────────────────────
//
// The files under templates/ are real ComfyUI templates, unchanged (see
// templates/SOURCE.md). image_z_image_turbo.json is the file the 3.0.8 test
// run on Windows saw turned down with "uses subgraphs" (same SHA-256).

const template = (name: string): UiGraph => ui(`templates/${name}`)
const ZIMAGE_SG = 'f2fdebf6-dfaf-43b6-9eb2-7f70613cfdc1'

function nodeById(g: UiGraph, id: number): UiNode {
  const n = g.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('subgraphs: the stock Z-Image Turbo template', () => {
  const r = convertOk(template('image_z_image_turbo.json'))

  it('unpacks the subgraph into the graph the canvas queues', () => {
    expect(r.graph).toEqual({
      '9': { class_type: 'SaveImage', inputs: { images: ['57:8', 0], filename_prefix: 'z-image-turbo' }, _meta: { title: 'Save Image' } },
      '57:30': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' }, _meta: { title: 'Load CLIP' } },
      '57:29': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' }, _meta: { title: 'Load VAE' } },
      '57:33': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['57:27', 0] }, _meta: { title: 'ConditioningZeroOut' } },
      '57:8': { class_type: 'VAEDecode', inputs: { samples: ['57:3', 0], vae: ['57:29', 0] }, _meta: { title: 'VAE Decode' } },
      '57:28': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' }, _meta: { title: 'Load Diffusion Model' } },
      '57:27': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'Latina female with thick wavy hair, harbor boats and pastel houses behind. Breezy seaside light, warm tones, cinematic close-up. ',
          clip: ['57:30', 0],
        },
        _meta: { title: 'CLIP Text Encode (Prompt)' },
      },
      '57:13': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: 'EmptySD3LatentImage' } },
      '57:11': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['57:28', 0], shift: 3 }, _meta: { title: 'ModelSamplingAuraFlow' } },
      '57:3': {
        class_type: 'KSampler',
        inputs: {
          model: ['57:11', 0], seed: 0, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple',
          positive: ['57:27', 0], negative: ['57:33', 0], latent_image: ['57:13', 0], denoise: 1,
        },
        _meta: { title: 'KSampler' },
      },
    })
    expect(r.notes).toEqual(['1 subgraph unpacked', '1 note left out'])
  })

  it('asks ComfyUI for the inner node types, never for the subgraph id', () => {
    expect(uiGraphNodeTypes(template('image_z_image_turbo.json'))).toEqual([
      'CLIPLoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'EmptySD3LatentImage', 'KSampler',
      'ModelSamplingAuraFlow', 'SaveImage', 'UNETLoader', 'VAEDecode', 'VAELoader',
    ])
    expect(uiGraphProblem(template('image_z_image_turbo.json'))).toBeNull()
  })

  it('is an image workflow LU can drive: prompt, seed, size and model found inside', () => {
    const t = parseImportedWorkflow('Z-Image Turbo', r.graph)
    expect(t.mode).toBe('image')
    expect(t.parameterMap.positivePrompt).toEqual({ nodeId: '57:27', inputKey: 'text' })
    expect(t.parameterMap.seed).toEqual({ nodeId: '57:3', inputKey: 'seed' })
    expect(t.parameterMap.width).toEqual({ nodeId: '57:13', inputKey: 'width' })
    expect(t.parameterMap.model).toEqual({ nodeId: '57:28', inputKey: 'unet_name', loaderType: 'unet' })
  })

  it('takes the values kept on the subgraph node by the older frontend', () => {
    const g = template('image_z_image_turbo.json')
    const sgNode = nodeById(g, 57)
    sgNode.properties = {}
    // One value per subgraph input that feeds a widget, in subgraph input order.
    sgNode.widgets_values = ['a red fox in snow', 768, 512, 42, 4, 'z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors']
    const out = convertOk(g)
    expect(out.graph['57:27'].inputs?.text).toBe('a red fox in snow')
    expect(out.graph['57:13'].inputs).toEqual({ width: 768, height: 512, batch_size: 1 })
    expect(out.graph['57:3'].inputs?.seed).toBe(42)
    expect(out.graph['57:3'].inputs?.steps).toBe(4)
    // Only the PrimitiveNode stand-ins carry the values, none of them is sent.
    expect(Object.values(out.graph).some((n) => n.class_type === 'PrimitiveNode')).toBe(false)
  })

  it('turns down kept values that do not line up with the subgraph inputs', () => {
    const g = template('image_z_image_turbo.json')
    nodeById(g, 57).widgets_values = ['a red fox', 768]
    const r2 = convertUiGraph(g, defs)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toMatch(/keeps 2 settings for 8 inputs/)
    expect(uiGraphProblem(g)).toMatch(/cannot be matched safely/)
  })

  it('turns down a kept value of the wrong type', () => {
    const g = template('image_z_image_turbo.json')
    nodeById(g, 57).widgets_values = ['a red fox', 'wide', 512, 42, 4, 'z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors']
    const r2 = convertUiGraph(g, defs)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toMatch(/#57:13 \(EmptySD3LatentImage\): the saved settings do not match/)
  })
})

describe('subgraphs: one subgraph used twice', () => {
  // The Z-Image template with a second instance of its subgraph next to the
  // first, its prompt fed from a Primitive node outside, its own Save Image.
  const twice = (): UiGraph => {
    const g = template('image_z_image_turbo.json')
    g.nodes.push(
      {
        id: 58, type: ZIMAGE_SG, mode: 0,
        inputs: [{ name: 'text', type: 'STRING', widget: { name: 'text' }, link: 64 }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
        widgets_values: [],
      },
      { id: 59, type: 'PrimitiveNode', mode: 0, outputs: [{ name: 'STRING', type: 'STRING' }], widgets_values: ['a lighthouse at dusk'] },
      { id: 60, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 63 }], widgets_values: ['second'] },
    )
    g.links?.push([63, 58, 0, 60, 0, 'IMAGE'], [64, 59, 0, 58, 0, 'STRING'])
    return g
  }

  it('gives each instance its own inner nodes and keeps their wires apart', () => {
    const r = convertOk(twice())
    const ids = Object.keys(r.graph)
    expect(ids.filter((id) => id.startsWith('57:'))).toHaveLength(9)
    expect(ids.filter((id) => id.startsWith('58:'))).toHaveLength(9)
    expect(r.graph['9'].inputs?.images).toEqual(['57:8', 0])
    expect(r.graph['60'].inputs?.images).toEqual(['58:8', 0])
    expect(r.graph['58:3'].inputs).toMatchObject({
      model: ['58:11', 0], positive: ['58:27', 0], negative: ['58:33', 0], latent_image: ['58:13', 0],
    })
    expect(r.graph['58:8'].inputs).toEqual({ samples: ['58:3', 0], vae: ['58:29', 0] })
    expect(r.notes).toContain('2 subgraphs unpacked')
  })

  it('feeds a wired subgraph input from outside, the other instance keeps its own value', () => {
    const r = convertOk(twice())
    expect(r.graph['58:27'].inputs?.text).toBe('a lighthouse at dusk')
    expect(r.graph['57:27'].inputs?.text).toMatch(/^Latina female/)
  })
})

describe('subgraphs: nested (the stock NetaYume Lumina template)', () => {
  const r = convertOk(template('image_netayume_lumina_t2i.json'))

  it('unpacks the negative prompt subgraph inside the text to image subgraph', () => {
    expect(Object.keys(r.graph).sort()).toEqual([
      '48:31', '48:32', '48:33', '48:34', '48:35:40', '48:35:41', '48:35:42', '48:35:43',
      '48:36', '48:49', '48:50', '48:51', '48:52', '9',
    ])
    expect(r.notes).toEqual(['2 subgraphs unpacked', '4 notes left out'])
  })

  it('wires across both borders: out of the inner subgraph and into it from the outer one', () => {
    // KSampler negative comes out of the nested subgraph's output.
    expect(r.graph['48:33'].inputs?.negative).toEqual(['48:35:43', 0])
    // The nested CLIPTextEncode gets its clip from the loader one level up.
    expect(r.graph['48:35:43'].inputs).toEqual({ text: ['48:35:40', 0], clip: ['48:34', 1] })
    expect(r.graph['48:35:40'].inputs).toEqual({ string_a: ['48:35:41', 0], string_b: ['48:35:42', 0], delimiter: '' })
    expect(r.graph['48:35:42'].inputs?.value).toMatch(/^blurry, worst quality/)
    expect(r.graph['48:50'].inputs).toEqual({ text: ['48:49', 0], clip: ['48:34', 1] })
    expect(r.graph['48:51'].inputs?.value).toMatch(/^@comfyanonymous, "Warm and cheerful/)
    expect(r.graph['9'].inputs?.images).toEqual(['48:36', 0])
  })

  it('bypassing the nested subgraph node leaves KSampler without a negative, as in ComfyUI', () => {
    const g = template('image_netayume_lumina_t2i.json')
    const sg = g.definitions?.subgraphs?.[0] as { nodes: UiNode[] }
    const inner = sg.nodes.find((n) => n.id === 35)
    if (!inner) throw new Error('no nested node')
    inner.mode = 4
    const r2 = convertUiGraph(g, defs)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toMatch(/#48:33 \(KSampler\) has no "negative"/)
  })
})

describe('subgraphs: bypass and mute on the subgraph node', () => {
  const INV = 'a0b1c2d3-0000-4000-8000-000000000001'
  // The Z-Image template with an "Invert" subgraph between decoder and Save Image.
  const withInvert = (mode: number): UiGraph => {
    const g = template('image_z_image_turbo.json')
    g.definitions?.subgraphs?.push({
      id: INV, name: 'Invert', version: 1,
      inputNode: { id: -10, bounding: [0, 0, 10, 10] },
      outputNode: { id: -20, bounding: [0, 0, 10, 10] },
      inputs: [{ id: 'i0', name: 'image', type: 'IMAGE', linkIds: [1] }],
      outputs: [{ id: 'o0', name: 'IMAGE', type: 'IMAGE', linkIds: [2] }],
      widgets: [],
      nodes: [{ id: 1, type: 'ImageInvert', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 1 }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] }],
      links: [
        { id: 1, origin_id: -10, origin_slot: 0, target_id: 1, target_slot: 0, type: 'IMAGE' },
        { id: 2, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
      ],
    })
    g.nodes.push({
      id: 70, type: INV, mode,
      inputs: [{ name: 'image', type: 'IMAGE', link: 62 }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
      widgets_values: [],
    })
    g.links = [[62, 57, 0, 70, 0, 'IMAGE'], [65, 70, 0, 9, 0, 'IMAGE']]
    const save = nodeById(g, 9)
    if (save.inputs) save.inputs[0].link = 65
    return g
  }

  it('runs the subgraph when it is on', () => {
    const r = convertOk(withInvert(0))
    expect(r.graph['70:1'].inputs).toEqual({ image: ['57:8', 0] })
    expect(r.graph['9'].inputs?.images).toEqual(['70:1', 0])
  })

  it('bypassed: the image passes straight through and nothing inside is asked for', () => {
    const g = withInvert(4)
    const r = convertOk(g)
    expect(r.graph['9'].inputs?.images).toEqual(['57:8', 0])
    expect(Object.keys(r.graph).some((id) => id.startsWith('70'))).toBe(false)
    expect(uiGraphNodeTypes(g)).not.toContain(INV)
    expect(uiGraphNodeTypes(g)).not.toContain('ImageInvert')
    expect(r.notes).toContain('1 bypassed node passed through')
  })

  it('muted: everything fed by it is left out, so Save Image has no image', () => {
    const r = convertUiGraph(withInvert(2), defs)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/#9 \(SaveImage\) has no "images"/)
  })
})

describe('subgraphs: files that are turned down', () => {
  it('a subgraph that contains itself', () => {
    const g = template('image_z_image_turbo.json')
    const sg = g.definitions?.subgraphs?.[0] as { nodes: UiNode[]; links: unknown[] }
    sg.nodes.push({ id: 99, type: ZIMAGE_SG, mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] })
    expect(uiGraphProblem(g)).toMatch(/nested more than 16 levels deep or contain themselves/)
    expect(convertUiGraph(g, defs).ok).toBe(false)
  })

  it('group nodes inside a subgraph', () => {
    const g = template('image_z_image_turbo.json')
    const sg = g.definitions?.subgraphs?.[0] as { nodes: UiNode[] }
    sg.nodes.push({ id: 98, type: 'workflow>Old group', mode: 0 })
    expect(uiGraphProblem(g)).toMatch(/group nodes/)
  })

  it('a file without subgraph nodes comes back from flattening unchanged', () => {
    const g = ui('sdxl-txt2img.ui.json')
    const r = flattenSubgraphs(g)
    expect(r.ok && r.graph).toBe(g)
  })
})

// ── V3 dynamic inputs (GitHub #196) ─────────────────────────────
//
// The node definitions are the excerpt of object-info-ltx25.json, written
// down from the ComfyUI v0.42.4 sources (templates/SOURCE.md names file and
// line of every node). The widget values are those of the LTX 2.5 i2v
// template of Comfy-Org.

const v3 = load<ComfyNodeDefs>('object-info-ltx25.json')

/** One node of the given type wired into a Save Video, as the canvas saves it. */
function oneNode(type: string, widgets: unknown[], inputs: UiNode['inputs'] = [], extra: UiNode[] = [], links: unknown[] = []): UiGraph {
  return {
    nodes: [
      { id: 1, type, mode: 0, inputs, outputs: [{ name: 'out', type: '*' }], widgets_values: widgets },
      { id: 2, type: 'PreviewAny', mode: 0, inputs: [{ name: 'source', type: '*', link: 1 }], widgets_values: [] },
      ...extra,
    ],
    links: [[1, 1, 0, 2, 0, '*'], ...links],
  }
}

describe('V3 dynamic inputs: DynamicCombo (TextGenerateLTX2Prompt.sampling_mode)', () => {
  const clip = { id: 3, type: 'CLIPLoader', mode: 0, inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP' }], widgets_values: ['gemma4_e2b_it_int8_convrot.safetensors', 'ltxv', 'default'] }
  const wired = [{ name: 'clip', type: 'CLIP', link: 2 }]
  const values = ['', 600, 'on', 0.7, 64, 0.95, 0.05, 1.15, 0, 0, false, true]

  it('names the values of the chosen option "<combo>.<input>" and reads on after them', () => {
    const r = convertOk(oneNode('TextGenerateLTX2Prompt', values, wired, [clip], [[2, 3, 0, 1, 0, 'CLIP']]), v3)
    expect(r.graph['1'].inputs).toEqual({
      clip: ['3', 0],
      prompt: '',
      max_length: 600,
      sampling_mode: 'on',
      'sampling_mode.temperature': 0.7,
      'sampling_mode.top_k': 64,
      'sampling_mode.top_p': 0.95,
      'sampling_mode.min_p': 0.05,
      'sampling_mode.repetition_penalty': 1.15,
      'sampling_mode.seed': 0,
      'sampling_mode.presence_penalty': 0,
      thinking: false,
      use_default_template: true,
    })
  })

  it('an option without inputs ("off") takes no values of its own', () => {
    const r = convertOk(oneNode('TextGenerateLTX2Prompt', ['', 600, 'off', true, false], wired, [clip], [[2, 3, 0, 1, 0, 'CLIP']]), v3)
    expect(r.graph['1'].inputs).toMatchObject({ sampling_mode: 'off', thinking: true, use_default_template: false })
    expect(Object.keys(r.graph['1'].inputs ?? {}).some((k) => k.startsWith('sampling_mode.'))).toBe(false)
  })

  it('a value that is no option of the combo turns the file down instead of shifting the rest', () => {
    const r = convertUiGraph(oneNode('TextGenerateLTX2Prompt', ['', 600, 'sometimes', 0.7], wired, [clip], [[2, 3, 0, 1, 0, 'CLIP']]), v3)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/saved settings do not match/)
  })

  it('nested combos: Save Video format "auto" with its own codec "auto"', () => {
    const g: UiGraph = {
      nodes: [
        { id: 1, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets_values: ['neon_cyborg_portrait.png', 'image'] },
        { id: 2, type: 'CreateVideo', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], outputs: [{ name: 'VIDEO', type: 'VIDEO' }], widgets_values: [24, 8] },
        { id: 3, type: 'SaveVideo', mode: 0, inputs: [{ name: 'video', type: 'VIDEO', link: 2 }], widgets_values: ['video/x', 'auto', 'auto'] },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 2, 0, 3, 0, 'VIDEO']],
    }
    expect(convertOk(g, v3).graph['3'].inputs).toEqual({ video: ['2', 0], filename_prefix: 'video/x', format: 'auto', 'format.codec': 'auto' })
  })
})

describe('V3 dynamic inputs: Autogrow (ComfyMathExpression.values)', () => {
  const int = { id: 3, type: 'PrimitiveInt', mode: 0, inputs: [], outputs: [{ name: 'INT', type: 'INT' }], widgets_values: [1280, 'fixed'] }
  const sockets = (linkA: number | null) => [
    { name: 'values.a', type: 'FLOAT,INT,BOOLEAN', link: linkA },
    { name: 'values.b', type: 'FLOAT,INT,BOOLEAN', link: null },
  ]

  it('reads the sockets "values.a", "values.b" and does not ask for "values" itself', () => {
    const r = convertOk(oneNode('ComfyMathExpression', ['a/2'], sockets(2), [int], [[2, 3, 0, 1, 0, 'INT']]), v3)
    expect(r.graph['1'].inputs).toEqual({ expression: 'a/2', 'values.a': ['3', 0] })
  })

  it('the first name is required: an open "values.a" is named', () => {
    const r = convertUiGraph(oneNode('ComfyMathExpression', ['a/2'], sockets(null)), v3)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/has no "values\.a" connected/)
  })
})

describe('V3 widgets of more than one type (widgetType)', () => {
  it('LTXVEmptyLatentAudio keeps frame_rate in its widget values, batch_size stays 1', () => {
    const vae = { id: 3, type: 'VAELoader', mode: 0, inputs: [], outputs: [{ name: 'VAE', type: 'VAE' }], widgets_values: ['ltx-2.5-audio-vae-bf16.safetensors'] }
    const r = convertOk(oneNode('LTXVEmptyLatentAudio', [97, 25, 1], [{ name: 'audio_vae', type: 'VAE', link: 2 }], [vae], [[2, 3, 0, 1, 0, 'VAE']]), v3)
    expect(r.graph['1'].inputs).toEqual({ frames_number: 97, frame_rate: 25, batch_size: 1, audio_vae: ['3', 0] })
  })
})
