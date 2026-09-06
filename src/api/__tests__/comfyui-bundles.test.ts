import { describe, it, expect, beforeAll } from 'vitest'
import {
  getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles,
  CUSTOM_NODE_REGISTRY, type ModelBundle,
} from '../discover'

describe('Video Bundle Definitions', () => {
  let bundles: ModelBundle[]

  beforeAll(() => {
    bundles = getVideoBundles()
  })

  it('has 13 video bundles', () => {
    // 14 original - Allegro (diffusers only) + CogVideoX 2B replaced by 5B I2V,
    // + Wan 2.2 TI2V-5B (unified T2V/I2V, 2026-06-11); 2.5.8 adds the two
    // uncensored GGUF finetunes (NSFW Wan 14B t2v + Wan 2.2 Rapid AIO i2v).
    // 2026-07-24 removes three that could never run: both CogVideoX bundles
    // (21 GB each) and Pyramid Flow, whose builders emitted node class names no
    // wrapper registers. See wrapper-node-names.test.ts.
    expect(bundles.length).toBe(13)
  })

  it('every bundle has required fields', () => {
    for (const b of bundles) {
      expect(b.name).toBeTruthy()
      expect(b.description).toBeTruthy()
      expect(b.totalSizeGB).toBeGreaterThan(0)
      expect(b.vramRequired).toBeTruthy()
      expect(b.workflow).toBeTruthy()
      expect(b.tags.length).toBeGreaterThan(0)
    }
  })

  it('every bundle has at least 1 file with download info', () => {
    for (const b of bundles) {
      expect(b.files.length).toBeGreaterThan(0)
      for (const f of b.files) {
        expect(f.downloadUrl).toBeTruthy()
        expect(f.filename).toBeTruthy()
        expect(f.subfolder).toBeTruthy()
      }
    }
  })

  it('every file URL is https', () => {
    for (const b of bundles) {
      for (const f of b.files) {
        expect(f.downloadUrl).toMatch(/^https:\/\//)
      }
    }
  })

  it('every file has valid subfolder', () => {
    const validSubfolders = ['diffusion_models', 'vae', 'text_encoders', 'checkpoints', 'clip_vision',
      'custom_nodes/ComfyUI-AnimateDiff-Evolved/models']
    for (const b of bundles) {
      for (const f of b.files) {
        expect(validSubfolders).toContain(f.subfolder)
      }
    }
  })

  it('bundles with customNodes reference valid registry keys', () => {
    for (const b of bundles) {
      if (b.customNodes) {
        for (const key of b.customNodes) {
          expect(CUSTOM_NODE_REGISTRY[key]).toBeDefined()
        }
      }
    }
  })

  it('I2V bundles have i2v: true', () => {
    const i2vBundles = bundles.filter(b => b.i2v)
    // SVD + FramePack + Wan 2.2 TI2V-5B + Rapid AIO (2.5.8). The CogVideoX 5B
    // I2V bundle was pulled 2026-07-24 with the rest of its lane.
    expect(i2vBundles.length).toBe(4)
    const i2vNames = i2vBundles.map(b => b.name)
    expect(i2vNames.some(n => n.includes('SVD'))).toBe(true)
    expect(i2vNames.some(n => n.includes('FramePack'))).toBe(true)
    expect(i2vNames.some(n => n.includes('Wan 2.2'))).toBe(true)
    expect(i2vNames.some(n => n.includes('Rapid AIO'))).toBe(true)
  })

  it('LTX bundle has workflow "ltx" not "wan"', () => {
    const ltx = bundles.find(b => b.name.includes('LTX'))
    expect(ltx).toBeDefined()
    expect(ltx!.workflow).toBe('ltx')
  })

  it('every workflow type is a known strategy', () => {
    const knownWorkflows = ['wan', 'wan22', 'hunyuan', 'ltx', 'animatediff', 'cogvideo', 'framepack',
      'svd', 'mochi', 'cosmos', 'pyramidflow', 'allegro']
    for (const b of bundles) {
      expect(knownWorkflows).toContain(b.workflow)
    }
  })
})

describe('Custom Node Registry', () => {
  it('all entries have valid GitHub repo URL', () => {
    for (const entry of Object.values(CUSTOM_NODE_REGISTRY)) {
      expect(entry.repo).toMatch(/^https:\/\/github\.com\//)
      expect(entry.name).toBeTruthy()
    }
  })

  it('all entries have non-empty requiredNodes', () => {
    for (const entry of Object.values(CUSTOM_NODE_REGISTRY)) {
      expect(entry.requiredNodes.length).toBeGreaterThan(0)
    }
  })

  it('no duplicate repo URLs', () => {
    const repos = Object.values(CUSTOM_NODE_REGISTRY).map(e => e.repo)
    expect(new Set(repos).size).toBe(repos.length)
  })

  it('has 9 custom node entries', () => {
    // v2.4.5 added 'videohelpersuite' for Bug A (MP4 video output); v2.5.7 added
    // 'rmbg' for the Remove-Background cutout; 2.5.8 adds 'gguf' (quant loader
    // for the 14B lanes) and 'controlnet-aux' (DWPose for Motion Control).
    // When this registry grows again, bump the number AND add a smoke test
    // below for the new entry so future drift is loud.
    expect(Object.keys(CUSTOM_NODE_REGISTRY).length).toBe(9)
  })

  it('gguf entry routes to city96 upstream and requires the GGUF loader', () => {
    const entry = CUSTOM_NODE_REGISTRY['gguf']
    expect(entry).toBeTruthy()
    expect(entry.repo).toBe('https://github.com/city96/ComfyUI-GGUF')
    expect(entry.requiredNodes).toContain('UnetLoaderGGUF')
  })

  it('controlnet-aux entry routes to Fannovel16 upstream and requires DWPose', () => {
    const entry = CUSTOM_NODE_REGISTRY['controlnet-aux']
    expect(entry).toBeTruthy()
    expect(entry.repo).toBe('https://github.com/Fannovel16/comfyui_controlnet_aux')
    expect(entry.requiredNodes).toContain('DWPreprocessor')
  })

  it('videohelpersuite entry routes to Kosinkadink upstream', () => {
    const entry = CUSTOM_NODE_REGISTRY['videohelpersuite']
    expect(entry).toBeTruthy()
    expect(entry.repo).toBe('https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite')
    expect(entry.requiredNodes).toContain('VHS_VideoCombine')
  })

  it('rmbg entry routes to 1038lab upstream and requires the RMBG node', () => {
    const entry = CUSTOM_NODE_REGISTRY['rmbg']
    expect(entry).toBeTruthy()
    expect(entry.repo).toBe('https://github.com/1038lab/ComfyUI-RMBG')
    expect(entry.requiredNodes).toContain('RMBG')
  })
})

describe('2.5.8 specialized lane bundles (music / lipsync / motion)', () => {
  const laneBundles = () => [...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles()]

  it('every lane bundle is complete and https', () => {
    const all = laneBundles()
    expect(all.length).toBe(6) // 2 music + 2 lipsync + 2 motion
    for (const b of all) {
      expect(b.name).toBeTruthy()
      expect(b.totalSizeGB).toBeGreaterThan(0)
      expect(b.vramRequired).toBeTruthy()
      expect(b.files.length).toBeGreaterThan(0)
      for (const f of b.files) {
        expect(f.downloadUrl).toMatch(/^https:\/\//)
        expect(f.filename).toBeTruthy()
        expect(['checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'audio_encoders']).toContain(f.subfolder)
      }
    }
  })

  it('music bundles are single-file ACE checkpoints', () => {
    for (const b of getAudioBundles()) {
      expect(b.workflow).toBe('ace')
      expect(b.files.length).toBe(1)
      expect(b.files[0].subfolder).toBe('checkpoints')
    }
  })

  it('lipsync bundles carry the wav2vec2 audio encoder', () => {
    for (const b of getLipsyncBundles()) {
      expect(b.files.some((f) => f.subfolder === 'audio_encoders')).toBe(true)
    }
  })

  it('gguf lane bundles request the gguf node pack', () => {
    for (const b of laneBundles()) {
      // `filename` is optional on DiscoverModel (Ollama-tag entries carry
      // none), and a file without one is not a gguf either way.
      const hasGguf = b.files.some((f) => f.filename?.toLowerCase().endsWith('.gguf'))
      if (hasGguf) expect(b.customNodes).toContain('gguf')
    }
  })

  it('motion bundles request the pose extractor pack', () => {
    for (const b of getMotionBundles()) {
      expect(b.customNodes).toContain('controlnet-aux')
    }
  })
})

describe('Shared File Deduplication', () => {
  let bundles: ModelBundle[]

  beforeAll(() => {
    bundles = getVideoBundles()
  })

  it('shared files use same URL across bundles', () => {
    // clip_l.safetensors is used by HunyuanVideo and FramePack
    const clipLBundles = bundles.filter(b =>
      b.files.some(f => f.filename === 'clip_l.safetensors')
    )
    expect(clipLBundles.length).toBeGreaterThanOrEqual(2)

    const urls = clipLBundles.flatMap(b =>
      b.files.filter(f => f.filename === 'clip_l.safetensors').map(f => f.downloadUrl)
    )
    // All URLs for the same file should be identical
    expect(new Set(urls).size).toBe(1)
  })

  it('no CogVideoX files are offered anywhere any more', () => {
    // Was: "cogvideox_vae is shared between CogVideoX bundles". Both bundles are
    // gone (2026-07-24), so the sharing check is replaced by the stronger claim
    // that nothing in the catalogue still pulls a CogVideoX file down.
    expect(bundles.filter(b => b.workflow === 'cogvideo')).toEqual([])
    const cogFiles = bundles.flatMap(b => b.files).filter(f => (f.filename ?? '').includes('cogvideox'))
    expect(cogFiles.map(f => f.filename)).toEqual([])
  })
})
