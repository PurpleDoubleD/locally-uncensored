/**
 * Wan 2.2 A14B (GH #193): Create → Animate with
 * wan2.2_i2v_high_noise_14B_fp8_scaled died in the KSampler with "The size of
 * tensor a (48) must match the size of tensor b (16) at non-singleton
 * dimension 1". Every name with the wan2.2 tag went to the TI2V-5B builder,
 * which pins the 48-channel wan2.2_vae. Only the 5B uses that VAE. The 14B
 * pair (i2v/t2v, high and low noise, any quant) is Wan 2.1 architecture:
 * WanImageToVideo and the 16-channel wan_2.1_vae, the same files ComfyUI's own
 * template loads.
 *
 * Run: npx vitest run src/api/__tests__/wan22-a14b-vae.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classifyModel, isI2VModel, isT2VCapable, wan22LowNoisePartner } from '../comfyui'
import { COMPONENT_REGISTRY } from '../component-registry'
import { localFetch } from '../backend'
import { classTypes, nodeOf, nodesOf } from './graph-test-support'

const REPORTED = 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'

const A14B_I2V = [
  REPORTED,
  'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
  'wan2.2_i2v_high_noise_14B_fp16.safetensors',
  'Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf',
  'Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf',
  'Wan2_2-I2V-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors',
]
const A14B_T2V = [
  'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
  'wan2.2_t2v_low_noise_14B_fp16.safetensors',
  'Wan2.2-T2V-A14B-LowNoise-Q5_K_M.gguf',
]

const NODES = {
  UNETLoader: { input: { required: { unet_name: [[...A14B_I2V, ...A14B_T2V, 'wan2.2_ti2v_5B_fp16.safetensors'].filter((n) => !n.endsWith('.gguf'))] } } },
  CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
  // The 2.2 file sorts first on purpose: a first-match lookup picks it.
  VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors', 'wan_2.1_vae.safetensors']] } } },
  Wan22ImageToVideoLatent: { input: { required: { vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] }, optional: { start_image: ['IMAGE', {}] } } },
  WanImageToVideo: {
    input: {
      required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] },
      optional: { start_image: ['IMAGE'] },
    },
    output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
  },
  EmptyHunyuanLatentVideo: { input: { required: {} } },
  ModelSamplingSD3: { input: { required: { model: ['MODEL'], shift: ['FLOAT'] } } },
  KSampler: { input: { required: {} } },
  KSamplerAdvanced: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  VHS_VideoCombine: { input: { required: {} } },
  SaveAnimatedWEBP: { input: { required: {} } },
}

const serveComfy = (nodes: Record<string, unknown>) => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  vi.mocked(localFetch).mockImplementation((async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (typeof url === 'string' && url.includes('object_info') ? nodes : {}),
    text: async () => JSON.stringify(nodes),
  })) as never)
}

const videoParams = {
  prompt: 'the camera slowly pushes in', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 20, cfgScale: 5, width: 832, height: 480, seed: 42, batchSize: 1,
  frames: 81, fps: 16,
}

describe('classifyModel — the Wan 2.2 A14B pair is Wan 2.1 architecture', () => {
  for (const name of [...A14B_I2V, ...A14B_T2V]) {
    it(`${name} → wan`, () => {
      expect(classifyModel(name)).toBe('wan')
    })
  }
  it('the TI2V-5B stays on its own builder (regression guard)', () => {
    expect(classifyModel('wan2.2_ti2v_5B_fp16.safetensors')).toBe('wan22')
    expect(classifyModel('Wan2.2-TI2V-5B-Q8_0.gguf')).toBe('wan22')
    expect(classifyModel('wan22_5b_q8.gguf')).toBe('wan22')
  })
  it('S2V and Animate keep their lanes', () => {
    expect(classifyModel('wan2.2_s2v_14B_fp8_scaled.safetensors')).toBe('wans2v')
    expect(classifyModel('Wan2.2-Animate-14B-Q4_K_M.gguf')).toBe('wananimate')
  })
})

describe('pickers — i2v and t2v halves land on their own tab', () => {
  it('an A14B i2v file is offered for Animate only', () => {
    for (const name of A14B_I2V) {
      expect(isI2VModel(name)).toBe(true)
      expect(isT2VCapable(name)).toBe(false)
    }
  })
  it('an A14B t2v file is offered for text to video only', () => {
    for (const name of A14B_T2V) {
      expect(isI2VModel(name)).toBe(false)
      expect(isT2VCapable(name)).toBe(true)
    }
  })
  it('the TI2V-5B stays on both (regression guard)', () => {
    expect(isI2VModel('wan2.2_ti2v_5B_fp16.safetensors')).toBe(true)
    expect(isT2VCapable('wan2.2_ti2v_5B_fp16.safetensors')).toBe(true)
  })
})

describe('the download hint names the VAE the model needs', () => {
  it('the wan entry, which the A14B pair now resolves to, offers wan_2.1_vae', () => {
    expect(COMPONENT_REGISTRY[classifyModel(REPORTED)].vae?.downloadFilename).toBe('wan_2.1_vae.safetensors')
  })
})

describe('the built graph (GH #193)', () => {
  beforeEach(() => serveComfy(NODES))

  it('animating with the reported file loads wan_2.1_vae through WanImageToVideo', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: REPORTED, inputImage: 'start.png' } as never)
    expect(nodeOf(wf, 'VAELoader')![1].inputs.vae_name).toBe('wan_2.1_vae.safetensors')
    expect(classTypes(wf)).toContain('WanImageToVideo')
    expect(classTypes(wf)).not.toContain('Wan22ImageToVideoLatent')
  })

  it('a t2v half runs the plain Wan graph with wan_2.1_vae', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: A14B_T2V[0] } as never)
    expect(nodeOf(wf, 'VAELoader')![1].inputs.vae_name).toBe('wan_2.1_vae.safetensors')
    expect(classTypes(wf)).not.toContain('Wan22ImageToVideoLatent')
  })

  it('the TI2V-5B still loads wan2.2_vae (regression guard)', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: 'wan2.2_ti2v_5B_fp16.safetensors', frames: 49, fps: 24 } as never)
    expect(nodeOf(wf, 'VAELoader')![1].inputs.vae_name).toBe('wan2.2_vae.safetensors')
    expect(classTypes(wf)).toContain('Wan22ImageToVideoLatent')
  })
})

describe('wan22LowNoisePartner — the half that finishes the clip', () => {
  const listed = [
    'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
    'Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf',
    'Wan2_2-I2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors',
  ]
  it('finds it for each naming scheme', () => {
    expect(wan22LowNoisePartner(REPORTED, listed)).toBe(listed[0])
    expect(wan22LowNoisePartner('Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf', listed)).toBe(listed[1])
    expect(wan22LowNoisePartner('Wan2_2-I2V-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors', listed)).toBe(listed[2])
  })
  it('none for a low half, a missing partner, another quant or a non-A14B file', () => {
    expect(wan22LowNoisePartner(listed[0], listed)).toBeNull()
    expect(wan22LowNoisePartner(REPORTED, [])).toBeNull()
    expect(wan22LowNoisePartner('wan2.2_i2v_high_noise_14B_fp16.safetensors', listed)).toBeNull()
    expect(wan22LowNoisePartner('wan2.1_t2v_14B_fp8.safetensors', listed)).toBeNull()
  })
})

describe('the A14B pair runs high noise, then low noise', () => {
  beforeEach(() => serveComfy(NODES))

  it('with both halves listed: two KSamplerAdvanced, split at half the steps', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: REPORTED, inputImage: 'start.png' } as never)
    const stages = nodesOf(wf, 'KSamplerAdvanced').map(([, node]) => node)
    expect(stages).toHaveLength(2)
    expect(classTypes(wf)).not.toContain('KSampler')
    const [high, low] = stages
    expect(high.inputs).toMatchObject({ add_noise: 'enable', start_at_step: 0, end_at_step: 10, return_with_leftover_noise: 'enable' })
    expect(low.inputs).toMatchObject({ add_noise: 'disable', start_at_step: 10, return_with_leftover_noise: 'disable' })
    const loaders = nodesOf(wf, 'UNETLoader').map(([, node]) => node.inputs.unet_name)
    expect(loaders).toEqual([REPORTED, 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'])
    // The low stage samples the low half and continues the high stage's latent.
    // Since 3.0.9 (B18) each half goes through the template's sampling shift
    // first (ModelSamplingSD3, 8 for a quality run).
    const lowLoaderId = nodesOf(wf, 'UNETLoader')[1][0]
    const highId = nodesOf(wf, 'KSamplerAdvanced')[0][0]
    const lowShift = wf[(low.inputs.model as [string, number])[0]]
    expect(lowShift.class_type).toBe('ModelSamplingSD3')
    expect(lowShift.inputs).toMatchObject({ model: [lowLoaderId, 0], shift: 8 })
    expect(low.inputs.latent_image).toEqual([highId, 0])
    expect(nodeOf(wf, 'VAEDecode')?.[1].inputs.samples ?? nodeOf(wf, 'VAEDecodeTiled')?.[1].inputs.samples)
      .toEqual([nodesOf(wf, 'KSamplerAdvanced')[1][0], 0])
  })

  it('without the partner the one file runs alone through a plain KSampler', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: 'wan2.2_i2v_high_noise_14B_fp16.safetensors', inputImage: 'start.png' } as never)
    expect(classTypes(wf)).toContain('KSampler')
    expect(classTypes(wf)).not.toContain('KSamplerAdvanced')
  })

  it('a picked low half runs alone', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', inputImage: 'start.png' } as never)
    expect(nodesOf(wf, 'UNETLoader')).toHaveLength(1)
    expect(classTypes(wf)).not.toContain('KSamplerAdvanced')
  })
})
