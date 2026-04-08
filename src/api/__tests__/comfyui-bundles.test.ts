import { getVideoBundles, CUSTOM_NODE_REGISTRY, type ModelBundle } from '../discover'

describe('Video Bundle Definitions', () => {
  let bundles: ModelBundle[]

  beforeAll(() => {
    bundles = getVideoBundles()
  })

  it('has 13 video bundles', () => {
    // 14 original - Allegro (diffusers only) + CogVideoX 2B replaced by 5B I2V
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
    expect(i2vBundles.length).toBe(3) // SVD + FramePack + CogVideoX 5B I2V
    const i2vNames = i2vBundles.map(b => b.name)
    expect(i2vNames.some(n => n.includes('SVD'))).toBe(true)
    expect(i2vNames.some(n => n.includes('FramePack'))).toBe(true)
  })

  it('LTX bundle has workflow "ltx" not "wan"', () => {
    const ltx = bundles.find(b => b.name.includes('LTX'))
    expect(ltx).toBeDefined()
    expect(ltx!.workflow).toBe('ltx')
  })

  it('every workflow type is a known strategy', () => {
    const knownWorkflows = ['wan', 'hunyuan', 'ltx', 'animatediff', 'cogvideo', 'framepack',
      'svd', 'mochi', 'cosmos', 'pyramidflow', 'allegro']
    for (const b of bundles) {
      expect(knownWorkflows).toContain(b.workflow)
    }
  })
})

describe('Custom Node Registry', () => {
  it('all entries have valid GitHub repo URL', () => {
    for (const [key, entry] of Object.entries(CUSTOM_NODE_REGISTRY)) {
      expect(entry.repo).toMatch(/^https:\/\/github\.com\//)
      expect(entry.name).toBeTruthy()
    }
  })

  it('all entries have non-empty requiredNodes', () => {
    for (const [key, entry] of Object.entries(CUSTOM_NODE_REGISTRY)) {
      expect(entry.requiredNodes.length).toBeGreaterThan(0)
    }
  })

  it('no duplicate repo URLs', () => {
    const repos = Object.values(CUSTOM_NODE_REGISTRY).map(e => e.repo)
    expect(new Set(repos).size).toBe(repos.length)
  })

  it('has 5 custom node entries', () => {
    expect(Object.keys(CUSTOM_NODE_REGISTRY).length).toBe(5)
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

  it('cogvideox_vae is shared between CogVideoX bundles', () => {
    const cogBundles = bundles.filter(b => b.workflow === 'cogvideo')
    expect(cogBundles.length).toBe(2) // 5B I2V + 1.5 5B

    for (const b of cogBundles) {
      const vae = b.files.find(f => f.filename === 'cogvideox_vae_bf16.safetensors')
      expect(vae).toBeDefined()
    }
  })
})
