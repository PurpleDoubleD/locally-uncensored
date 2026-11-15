// Local 3D on Windows and Linux (3.1.0): the TRELLIS.2 bundle, where its files
// go, how ComfyUI reads them back, and how a finished model is named in the
// gallery.
import { describe, it, expect } from 'vitest'
import { getThreeDBundles, TRELLIS2_FILES } from '../model-bundles'
import {
  COMFY_MODEL_FOLDERS, extractComfyOutputFiles, galleryTypeForFile, isThreeDModelFile, classifyModel,
} from '../comfyui'
import { starterBundleFor } from '../../lib/starter-bundle'
import { localTier } from '../../lib/render/local-model-tier'

const GIB = 1_073_741_824

describe('the TRELLIS.2 bundle', () => {
  const bundles = getThreeDBundles()
  const [bundle] = bundles

  it('is one bundle of five files, about 8.95 GB', () => {
    expect(bundles).toHaveLength(1)
    expect(bundle.files).toHaveLength(5)
    const bytes = bundle.files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0)
    expect(bytes).toBe(8954386952)
    // sizeGB is GiB, the unit the download tray turns back into bytes.
    for (const f of bundle.files) {
      expect(Math.abs(f.sizeGB! * GIB - f.sizeBytes!)).toBeLessThan(0.0001 * GIB)
    }
    const sum = bundle.files.reduce((s, f) => s + f.sizeGB!, 0)
    expect(bundle.totalSizeGB).toBeCloseTo(sum, 2)
  })

  it('names the files the graph loads, each in its ComfyUI folder', () => {
    const where = Object.fromEntries(bundle.files.map((f) => [f.filename, f.subfolder]))
    expect(where).toEqual({
      [TRELLIS2_FILES.model]: 'diffusion_models',
      [TRELLIS2_FILES.shapeVae]: 'vae',
      [TRELLIS2_FILES.textureVae]: 'vae',
      [TRELLIS2_FILES.imageEncoder]: 'clip_vision',
      [TRELLIS2_FILES.cutout]: 'background_removal',
    })
    const bytes = Object.fromEntries(bundle.files.map((f) => [f.filename, f.sizeBytes]))
    expect(bytes).toEqual({
      'trellis_2_int8_convrot.safetensors': 5253048192,
      'trellis_2_shape_vae_bf16.safetensors': 1095844024,
      'trellis_2_texture_vae_bf16.safetensors': 948461364,
      'dino_v3_vit_l.safetensors': 1212559776,
      'birefnet.safetensors': 444473596,
    })
  })

  it('downloads only from Comfy-Org on Hugging Face, pinned to a commit, with a digest', () => {
    for (const f of bundle.files) {
      expect(f.downloadUrl).toMatch(
        /^https:\/\/huggingface\.co\/Comfy-Org\/(TRELLIS\.2|BiRefNet)\/resolve\/[0-9a-f]{40}\/[a-z_]+\/[a-z0-9_.]+\.safetensors$/,
      )
      expect(f.downloadUrl!.endsWith(`/${f.subfolder}/${f.filename}`)).toBe(true)
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    const cutout = bundle.files.find((f) => f.subfolder === 'background_removal')!
    expect(cutout.downloadUrl).toContain('/Comfy-Org/BiRefNet/')
    expect(bundle.files.filter((f) => f.downloadUrl!.includes('/Comfy-Org/TRELLIS.2/'))).toHaveLength(4)
    expect(bundle.files.every((f) => f.filename!.endsWith('.safetensors'))).toBe(true)
  })

  it('every folder it writes is one the app reads back', () => {
    const read = new Set(COMFY_MODEL_FOLDERS.map((f) => f.subfolder))
    for (const f of bundle.files) expect(read.has(f.subfolder!), f.subfolder).toBe(true)
  })

  it('is unfiltered, verified by the box run, and needs no node pack', () => {
    expect(bundle.uncensored).toBe(true)
    // Real run on the 12 GB box card, 14.11.2026: draft, standard and fine.
    expect(bundle.verified).toBe(true)
    expect(bundle.customNodes ?? []).toEqual([])
    expect(bundle.tags).toContain('MIT')
    expect(bundle.vramMinGB).toBe(12)
  })

  it('is what the 3D setup card installs', () => {
    expect(starterBundleFor('3d', '3d')?.name).toBe(bundle.name)
  })

  it('carries the tier the local picker gives its family', () => {
    expect(localTier({ name: TRELLIS2_FILES.model, type: bundle.workflow })).toBe(bundle.tier)
    expect(bundle.tier).toBe('best')
  })
})

describe('the 3D model file stays out of the image picker', () => {
  it('is recognised by name', () => {
    expect(isThreeDModelFile('trellis_2_int8_convrot.safetensors')).toBe(true)
    expect(isThreeDModelFile('sub/trellis_2_bf16.safetensors')).toBe(true)
    expect(isThreeDModelFile('TRELLIS2.safetensors')).toBe(true)
    expect(isThreeDModelFile('pixal3d_int8_convrot.safetensors')).toBe(false)
    expect(isThreeDModelFile('flux1-dev-fp8.safetensors')).toBe(false)
    expect(isThreeDModelFile('trellis_20b.safetensors')).toBe(false)
  })

  it('would otherwise come back as an unknown, which the image picker lets through', () => {
    expect(classifyModel('trellis_2_int8_convrot.safetensors')).toBe('unknown')
  })
})

describe('galleryTypeForFile', () => {
  it('names every mesh format a 3D model, whatever the mode', () => {
    for (const name of ['m_00001_.glb', 'm.gltf', 'm.obj', 'm.ply', 'm.stl', 'M.GLB']) {
      expect(galleryTypeForFile(name, 'image'), name).toBe('3d')
      expect(galleryTypeForFile(name, 'video'), name).toBe('3d')
    }
  })

  it('leaves pictures, videos and sound as they were', () => {
    expect(galleryTypeForFile('a.png', 'image')).toBe('image')
    expect(galleryTypeForFile('a.mp4', 'video')).toBe('video')
    expect(galleryTypeForFile('a.mp3', 'image')).toBe('audio')
    expect(galleryTypeForFile('a.objx', 'image')).toBe('image')
  })
})

describe('extractComfyOutputFiles and SaveGLB', () => {
  // UI.Saved3DModels.as_dict (comfy_api/latest/_ui.py, v0.42.4): the files
  // under "3d", next to a camera_info of [None] and an empty model_3d_info.
  it('finds the model under the "3d" key and skips the rest', () => {
    const output = {
      '3d': [{ filename: 'locally_uncensored_3d_abc123_00001_.glb', subfolder: '3d', type: 'output' }],
      camera_info: [null],
      model_3d_info: [],
    }
    expect(extractComfyOutputFiles(output)).toEqual([
      { filename: 'locally_uncensored_3d_abc123_00001_.glb', subfolder: '3d', type: 'output' },
    ])
  })
})
