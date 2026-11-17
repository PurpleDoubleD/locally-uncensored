// The local 3D graph (TRELLIS.2, 3.1.0) against the node sequence of ComfyUI's
// template 3d_pixal3d_trellis2_image_to_model.json (wheel
// comfyui_workflow_templates_json 0.1.120, the one ComfyUI v0.42.4 pins),
// TRELLIS.2 branch, with the preview nodes taken out. The class and input
// names below were read from the node code at v0.42.4.
import { describe, it, expect } from 'vitest'
import {
  buildThreeDWorkflow, THREE_D_DETAIL, THREE_D_NODES, THREE_D_CUTOUT_NODES, THREE_D_SAVE_NODE,
  WorkflowUnavailableError, dynamicComboKeys, type ThreeDParams,
} from '../dynamic-workflow'
import { TRELLIS2_FILES } from '../model-bundles'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const ALL = Object.fromEntries([...THREE_D_NODES, ...THREE_D_CUTOUT_NODES].map((n) => [n, {}]))
const base: ThreeDParams = { image: 'chair.png', detail: 'fine', cutout: true, seed: 42 }
const build = (p: Partial<ThreeDParams> = {}, nodes: Record<string, unknown> = ALL) =>
  buildThreeDWorkflow({ ...base, ...p }, nodes)

/** Every link as "target.input <- source:slot", for a readable diff. */
function links(g: ComfyApiGraph): string[] {
  const out: string[] = []
  for (const [id, node] of Object.entries(g)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') {
        out.push(`${id}.${k} <- ${v[0]}:${v[1]}`)
      }
    }
  }
  return out.sort()
}

// The template's TRELLIS.2 branch (switch "Switch to Trellis2" true, "Remove
// background" true), node ids as in the template, previews bridged over.
const TEMPLATE_CLASSES: Record<string, string> = {
  '122': 'LoadImage', '193': 'LoadBackgroundRemovalModel', '192': 'RemoveBackground', '312': 'ImageCropToMask',
  '15': 'CLIPVisionLoader', '40': 'UNETLoader', '117': 'VAELoader', '118': 'VAELoader',
  '199': 'CFGOverride', '125': 'RescaleCFG', '108': 'ModelSamplingSD3', '279': 'CFGOverride', '126': 'RescaleCFG',
  '299': 'Trellis2Conditioning', '87': 'EmptyTrellis2LatentStructure',
  '3': 'KSampler', '119': 'VaeDecodeStructureTrellis2', '91': 'Trellis2ShapeStage', '18': 'KSampler',
  '94': 'Trellis2UpsampleStage', '23': 'KSampler', '92': 'VaeDecodeShapeTrellis',
  '98': 'Trellis2TextureStage', '12': 'KSampler', '93': 'VaeDecodeTextureTrellis',
  '241': 'RemeshMesh', '186': 'DecimateMesh', '238': 'MeshSmoothNormals', '196': 'UnwrapMesh',
  '147': 'BakeTextureFromVoxel', '224': 'BakeNormalMapFromMesh', '233': 'BakeAmbientOcclusion',
  '210': 'ApplyTextureToMesh', '260': 'MeshSmoothNormals', [THREE_D_SAVE_NODE]: 'SaveGLB',
}
const TEMPLATE_LINKS = [
  '192.bg_removal_model <- 193:0', '192.image <- 122:0',
  '312.images <- 122:0', '312.masks <- 192:0',
  '199.model <- 40:0', '125.model <- 199:0', '108.model <- 125:0', '279.model <- 40:0', '126.model <- 279:0',
  '299.clip_vision_model <- 15:0', '299.image <- 312:0',
  '3.model <- 108:0', '3.positive <- 299:0', '3.negative <- 299:1', '3.latent_image <- 87:0',
  '119.samples <- 3:0', '119.vae <- 117:0',
  '91.positive <- 299:0', '91.negative <- 299:1', '91.voxel <- 119:0',
  '18.model <- 126:0', '18.positive <- 91:0', '18.negative <- 91:1', '18.latent_image <- 91:2',
  '94.positive <- 91:0', '94.negative <- 91:1', '94.shape_latent <- 18:0', '94.vae <- 117:0',
  '23.model <- 126:0', '23.positive <- 94:0', '23.negative <- 94:1', '23.latent_image <- 94:2',
  '92.samples <- 23:0', '92.vae <- 117:0',
  '98.positive <- 94:0', '98.negative <- 94:1', '98.shape_latent <- 23:0',
  '12.model <- 40:0', '12.positive <- 98:0', '12.negative <- 98:1', '12.latent_image <- 98:2',
  '93.samples <- 12:0', '93.vae <- 118:0', '93.shape_subdivides <- 92:1',
  '241.mesh <- 92:0', '186.mesh <- 241:0', '238.mesh <- 186:0', '196.mesh <- 238:0',
  '147.mesh <- 196:0', '147.voxel_colors <- 93:0', '147.reference_mesh <- 92:0',
  '224.low_poly <- 196:0', '224.high_poly <- 241:0', '233.low_poly <- 196:0', '233.high_poly <- 241:0',
  '210.mesh <- 196:0', '210.base_color <- 147:0', '210.metallic <- 147:1', '210.roughness <- 147:2',
  '210.occlusion <- 233:0', '210.normal_map <- 224:0',
  '260.mesh <- 210:0', `${THREE_D_SAVE_NODE}.mesh <- 260:0`,
].sort()

describe('buildThreeDWorkflow', () => {
  it('is the template node for node, link for link', () => {
    const g = build()
    expect(Object.fromEntries(Object.entries(g).map(([id, n]) => [id, n.class_type]))).toEqual(TEMPLATE_CLASSES)
    expect(links(g)).toEqual(TEMPLATE_LINKS)
  })

  it('loads the five bundle files by name', () => {
    const g = build()
    expect(g['40'].inputs).toMatchObject({ unet_name: TRELLIS2_FILES.model, weight_dtype: 'default' })
    expect(g['117'].inputs).toEqual({ vae_name: TRELLIS2_FILES.shapeVae })
    expect(g['118'].inputs).toEqual({ vae_name: TRELLIS2_FILES.textureVae })
    expect(g['15'].inputs).toEqual({ clip_name: TRELLIS2_FILES.imageEncoder })
    expect(g['193'].inputs).toEqual({ bg_removal_name: TRELLIS2_FILES.cutout })
    expect(g['122'].inputs).toEqual({ image: 'chair.png' })
  })

  it('keeps the template sampler and guidance settings', () => {
    const g = build()
    expect(g['199'].inputs).toMatchObject({ cfg: 1, start_percent: 0.667, end_percent: 1 })
    expect(g['279'].inputs).toMatchObject({ cfg: 1, start_percent: 0.769, end_percent: 1 })
    expect(g['125'].inputs).toMatchObject({ multiplier: 0.7 })
    expect(g['126'].inputs).toMatchObject({ multiplier: 0.5 })
    expect(g['108'].inputs).toMatchObject({ shift: 5 })
    const ks = (id: string) => {
      const i = g[id].inputs!
      return [i.steps, i.cfg, i.sampler_name, i.scheduler, i.denoise]
    }
    expect(ks('3')).toEqual([12, 7.5, 'euler', 'normal', 1])
    expect(ks('18')).toEqual([20, 7.5, 'euler', 'normal', 1])
    expect(ks('23')).toEqual([12, 7.5, 'euler', 'simple', 1])
    expect(ks('12')).toEqual([12, 1, 'euler', 'normal', 1])
    expect(g['3'].inputs!.seed).toBe(42)
    expect(g['12'].inputs!.seed).toBe(43)
    expect(g['119'].inputs).toMatchObject({ resolution: '32' })
    expect(g['87'].inputs).toEqual({ batch_size: 1 })
  })

  it('writes the remesh choice the way a DynamicCombo is sent', () => {
    expect(build()['241'].inputs).toMatchObject({
      sign_mode: 'solid', 'sign_mode.fill': 20, 'sign_mode.qef': false,
      band: 1, project_back: 0, fix_poles: false, smooth_iters: 20,
      drop_small_components: 0.01, precluster_max_verts: 20_000_000,
    })
    expect(build()['186'].inputs).toMatchObject({ placement_mode: 'midpoint' })
  })

  it('fine is the template; draft and standard are lighter', () => {
    const at = (detail: ThreeDParams['detail']) => {
      const g = build({ detail })
      return {
        shape: g['94'].inputs!.target_resolution, remesh: g['241'].inputs!.resolution,
        faces: g['186'].inputs!.target_face_count, unwrap: g['196'].inputs!.resolution,
        texture: g['147'].inputs!.texture_size, normal: g['224'].inputs!.resolution,
        ao: g['233'].inputs!.resolution,
      }
    }
    expect(at('fine')).toEqual({ shape: 1536, remesh: 768, faces: 700_000, unwrap: 4096, texture: 4096, normal: 2048, ao: 1024 })
    expect(at('standard').shape).toBe(1024)
    expect(at('draft').faces).toBeLessThan(at('standard').faces as number)
    // Inside the node ranges of v0.42.4.
    for (const d of Object.values(THREE_D_DETAIL)) {
      expect(d.shapeResolution).toBeGreaterThanOrEqual(1024)
      expect(d.shapeResolution).toBeLessThanOrEqual(2048)
      expect(d.shapeResolution % 128).toBe(0)
      expect(d.texture % 256).toBe(0)
      expect(d.normalMap % 64).toBe(0)
      expect(d.occlusion % 64).toBe(0)
      expect(d.occlusionSamples % 4).toBe(0)
      expect(d.remeshResolution).toBeGreaterThanOrEqual(32)
      expect(d.remeshResolution).toBeLessThanOrEqual(2048)
    }
  })

  it('without a cutout uses the picture\'s own mask and needs no cutout model', () => {
    const noCut = Object.fromEntries(THREE_D_NODES.map((n) => [n, {}]))
    const g = build({ cutout: false }, noCut)
    expect(g['192']).toBeUndefined()
    expect(g['193']).toBeUndefined()
    expect(g['312'].inputs!.masks).toEqual(['122', 1])
  })

  it('crops to a 1024 square on black', () => {
    expect(build()['312'].inputs).toEqual({
      images: ['122', 0], masks: ['192', 0], width: 1024, height: 1024, pad_factor: 1.0, grow_mask: 0, background: '#000000',
    })
  })

  it('saves a GLB under output/3d', () => {
    const save = build()[THREE_D_SAVE_NODE]
    expect(save.class_type).toBe('SaveGLB')
    expect(String(save.inputs!.filename_prefix)).toMatch(/^3d\//)
  })

  it('asks for an update on a ComfyUI without the TRELLIS.2 nodes', () => {
    const old = { ...ALL }
    delete old.Trellis2UpsampleStage
    expect(() => build({}, old)).toThrow(WorkflowUnavailableError)
    expect(() => build({}, old)).toThrow(/ComfyUI 0\.42\.4 or newer/)
    const noSave = { ...ALL }
    delete noSave.SaveGLB
    expect(() => build({}, noSave)).toThrow(/newer/)
  })

  // RemeshMesh's sign_mode as /object_info serves it (DynamicCombo.Input.as_dict,
  // comfy_api/latest/_io.py). ComfyUI 0.36 to 0.41 offer udf and sdf only;
  // 'solid' came with 0.42.0 (comfy_extras/nodes_mesh_postprocess.py).
  const qef = { qef: ['BOOLEAN', { default: false }] }
  const remesh = (keys: string[]) => ({
    input: {
      required: {
        mesh: ['MESH', {}], resolution: ['INT', { default: 512 }],
        sign_mode: ['COMFY_DYNAMICCOMBO_V3', {
          display_name: 'sign_mode',
          options: keys.map((key) => ({ key, inputs: { required: key === 'solid' ? { fill: ['FLOAT', { default: 20 }], ...qef } : qef } })),
        }],
      },
    },
  })

  it('reads the choices of a DynamicCombo from /object_info, and says when it cannot', () => {
    expect(dynamicComboKeys(remesh(['udf', 'sdf', 'solid']), 'sign_mode')).toEqual(['udf', 'sdf', 'solid'])
    expect(dynamicComboKeys({ input: { optional: { sign_mode: [['udf', 'sdf']] } } }, 'sign_mode')).toEqual(['udf', 'sdf'])
    for (const unknown of [undefined, {}, true, { input: {} }, { input: { required: { sign_mode: 'x' } } }, { input: { required: { sign_mode: ['COMFY_DYNAMICCOMBO_V3', {}] } } }]) {
      expect(dynamicComboKeys(unknown, 'sign_mode')).toBeNull()
    }
  })

  it('runs on a ComfyUI whose RemeshMesh offers solid (0.42 and newer)', () => {
    const g = build({}, { ...ALL, RemeshMesh: remesh(['udf', 'sdf', 'solid']) })
    expect(g['241'].inputs).toMatchObject({ sign_mode: 'solid', 'sign_mode.fill': 20, 'sign_mode.qef': false })
  })

  it('asks for an update, before the run, on a ComfyUI whose RemeshMesh has no solid (0.36 to 0.41)', () => {
    // There 'solid' matches no option, ComfyUI drops sign_mode and the node
    // fails with "missing 1 required positional argument: 'sign_mode'".
    const old = { ...ALL, RemeshMesh: remesh(['udf', 'sdf']) }
    expect(() => build({}, old)).toThrow(WorkflowUnavailableError)
    expect(() => build({}, old)).toThrow(/ComfyUI 0\.42\.4 or newer\. Update ComfyUI in Settings\./)
    try { build({}, old) } catch (e) { expect((e as WorkflowUnavailableError).needsComfyUpdate).toBe(true) }
  })

  it('keeps going where the entry cannot be read, as before', () => {
    expect(build({}, { ...ALL, RemeshMesh: { input: { required: { sign_mode: ['COMFY_DYNAMICCOMBO_V3', {}] } } } })['241'].inputs)
      .toMatchObject({ sign_mode: 'solid' })
  })

  it('refuses a cutout when the cutout nodes are missing', () => {
    const noCut = Object.fromEntries(THREE_D_NODES.map((n) => [n, {}]))
    expect(() => build({ cutout: true }, noCut)).toThrow(/RemoveBackground/)
  })
})
