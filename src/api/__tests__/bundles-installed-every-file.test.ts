/**
 * B1, GH #113 back on 2.6.6: "unfiltered models doesn't shown as installed".
 *
 * Blahx (2026-08-23, screenshot) and lapbo (2026-08-25, "The model is not
 * visible, although it is downloaded"). The screenshot is the whole bug in one
 * frame: the Video / Unfiltered grid shows Wan 2.2 TI2V 5B and Wan 2.2 Rapid
 * AIO both reading Installed, over a rail counter that says 1.
 *
 * The card and the counter ask different sources. The counter is
 * getVideoModels, which enumerates what the running ComfyUI can actually
 * serve. The card is checkBundlesInstalled: files complete on disk, confirmed
 * against ComfyUI. That confirmation accepted ANY ONE enumerable file of the
 * bundle, and this catalogue shares files on purpose. Seven of the thirteen
 * video bundles carry the same umt5_xxl_fp8_e4m3fn_scaled text encoder and six
 * the same wan_2.1_vae, so one neighbour that installed cleanly leaves those
 * two listed for good. A bundle whose own main model ComfyUI cannot serve then
 * passed the gate on somebody else's file, and the gate that was built for
 * exactly this (pnwpdr4519: LU and ComfyUI reading different model folders)
 * could never fire for a Wan bundle at all.
 *
 * The engine state below is the real one behind the screenshot: the .gguf is on
 * disk at full size, and ComfyUI lists nothing through UnetLoaderGGUF because
 * the ComfyUI-GGUF pack is not loaded. Same shape for a second copy of ComfyUI,
 * a moved install, or a scan that never reached the file.
 *
 * Run: npx vitest run src/api/__tests__/bundles-installed-every-file.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ModelBundle } from '../discover'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const diffusionModels = vi.fn<() => Promise<string[]>>(async () => [])
const ggufUnets = vi.fn<() => Promise<string[]>>(async () => [])
const vaes = vi.fn<() => Promise<string[]>>(async () => [])
const clips = vi.fn<() => Promise<string[]>>(async () => [])
const loras = vi.fn<() => Promise<string[]>>(async () => [])

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  fetchExternal: vi.fn(),
}))

vi.mock('../comfyui', () => ({
  getCheckpoints: async () => [],
  getDiffusionModels: () => diffusionModels(),
  getGgufUnetModels: () => ggufUnets(),
  // Sixth loader (2026-08-29): the AnimateDiff pack lists its motion modules
  // itself. No motion module in these fixtures, so it answers empty.
  getAnimateDiffModels: async () => [],
  getVAEModels: () => vaes(),
  getCLIPModels: () => clips(),
  // Seventh loader (2026-08-29, abnahme counter-check): LoraLoader has always
  // enumerated the loras folder and nothing here ever asked it, so a LoRA was
  // the one installed file no surface could reason about.
  getLoraModels: () => loras(),
  filterPartialFiles: async (names: string[]) => new Set(names),
  refreshComfyModels: vi.fn(async () => true),
}))

const { checkBundlesInstalled, normalizeModelBase, ENUM_SUBFOLDERS } = await import('../discover')

const GGUF = 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'
const VAE = 'wan_2.1_vae.safetensors'
const CLIP = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'

const RAPID_AIO = {
  name: 'Wan 2.2 Rapid AIO (Uncensored I2V, GGUF)',
  description: '',
  tags: [],
  totalSizeGB: 16.6,
  vramRequired: '10-12 GB',
  files: [
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: GGUF, subfolder: 'diffusion_models', sizeGB: 10.1 },
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: VAE, subfolder: 'vae', sizeGB: 0.24 },
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: CLIP, subfolder: 'text_encoders', sizeGB: 6.27 },
  ],
} as unknown as ModelBundle

/** A LoRA bundle. Since 2026-08-29 the loras folder IS enumerated, so this
 *  bundle is judged like every other one: the counter-check found Pixel Art XL
 *  reading Installed on its card while no list and no counter knew the file. */
const LORA_ONLY = {
  name: 'Character LoRA',
  description: '', tags: [], totalSizeGB: 0.2, vramRequired: '4 GB',
  files: [
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: 'mychar.safetensors', subfolder: 'loras', sizeGB: 0.2 },
  ],
} as unknown as ModelBundle

/** An upscale model: still nothing any of these loaders enumerates, so the
 *  gate still has no business judging it either way. */
const UPSCALE_ONLY = {
  name: 'Upscaler',
  description: '', tags: [], totalSizeGB: 0.07, vramRequired: '4 GB',
  files: [
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: '4x-UltraSharp.pth', subfolder: 'upscale_models', sizeGB: 0.07 },
  ],
} as unknown as ModelBundle

describe('a bundle counts as installed only when ComfyUI lists every file it enumerates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The disk says every file of every bundle asked about is there at full size.
    backendCall.mockImplementation(async (cmd, args) => {
      if (cmd !== 'check_model_sizes') return undefined
      const files = (args as { files: Array<{ filename: string }> }).files
      return files.map((f) => ({ filename: f.filename, exists: true, actualBytes: 1, complete: true }))
    })
    // The neighbour bundle (Wan 2.2 TI2V 5B) installed cleanly, so the two
    // shared helper files are listed. The GGUF pack is not loaded.
    vaes.mockResolvedValue([VAE])
    clips.mockResolvedValue([CLIP])
    diffusionModels.mockResolvedValue([])
    ggufUnets.mockResolvedValue([])
  })

  it('the main model ComfyUI cannot serve is not covered by the shared helper files', async () => {
    const out = await checkBundlesInstalled([RAPID_AIO])
    expect(out[RAPID_AIO.name]).toBe(false)
  })

  it('NEGATIVE CONTROL: the old "at least one" expression calls the same state installed', async () => {
    // The exact gate that shipped in 2.6.6, replayed against the same engine
    // and the same disk. It is satisfied by wan_2.1_vae alone, which belongs to
    // a different bundle's install, and the card it drives says Installed for a
    // model that is in no picker and in no Installed tab. This is the assertion
    // the fix has to make impossible, so it must read `true` here.
    const visible = new Set(
      [...(await vaes()), ...(await clips()), ...(await diffusionModels()), ...(await ggufUnets())]
        .map(normalizeModelBase),
    )
    const enumFiles = RAPID_AIO.files.filter((f) => f.subfolder && ENUM_SUBFOLDERS.has(f.subfolder))
    const oldGatePasses = enumFiles.some((f) => visible.has(normalizeModelBase(f.filename!)))
    expect(oldGatePasses).toBe(true)
    // Same files, same engine, asked properly.
    const newGatePasses = enumFiles.every((f) => visible.has(normalizeModelBase(f.filename!)))
    expect(newGatePasses).toBe(false)
  })

  it('the GGUF pack loaded, so the quant is listed, puts the bundle back to installed', async () => {
    ggufUnets.mockResolvedValue([GGUF])
    const out = await checkBundlesInstalled([RAPID_AIO])
    expect(out[RAPID_AIO.name]).toBe(true)
  })

  it('a bundle whose files ComfyUI never enumerates is left to the disk check', async () => {
    const out = await checkBundlesInstalled([UPSCALE_ONLY])
    expect(out[UPSCALE_ONLY.name]).toBe(true)
  })

  it('a LoRA the running ComfyUI lists counts as installed', async () => {
    loras.mockResolvedValue(['mychar.safetensors'])
    const out = await checkBundlesInstalled([LORA_ONLY])
    expect(out[LORA_ONLY.name]).toBe(true)
  })

  it('NEGATIVE CONTROL: a LoRA on disk the running ComfyUI does not list is not installed', async () => {
    // The counter-check case, from the other end: the card used to trust the
    // disk alone here, which is how it read Installed over a list that had
    // never heard of the file.
    loras.mockResolvedValue([])
    const out = await checkBundlesInstalled([LORA_ONLY])
    expect(out[LORA_ONLY.name]).toBe(false)
  })

  it('an engine that cannot be reached leaves the disk verdict standing', async () => {
    vaes.mockRejectedValue(new Error('ECONNREFUSED'))
    const out = await checkBundlesInstalled([RAPID_AIO])
    expect(out[RAPID_AIO.name]).toBe(true)
  })
})

describe('the row a user actually reads names the cause that fits the file', () => {
  it('a GGUF names the node pack that reads GGUF, not a folder mismatch', async () => {
    const { invisibleFileMessage } = await import('../../stores/downloadStore')
    const msg = invisibleFileMessage(GGUF)
    expect(msg).toContain('ComfyUI-GGUF')
    expect(msg).toContain(GGUF)
  })

  it('a safetensors file still names the folder mismatch', async () => {
    const { invisibleFileMessage } = await import('../../stores/downloadStore')
    const msg = invisibleFileMessage(VAE)
    expect(msg).toContain('different model folders')
    expect(msg).not.toContain('ComfyUI-GGUF')
  })

  it('no dashes in either text (house rule) and both stay English', () => {
    // eslint-disable-next-line no-misleading-character-class
    const dash = /[\u2013\u2014]/
    return import('../../stores/downloadStore').then(({ invisibleFileMessage }) => {
      expect(invisibleFileMessage(GGUF)).not.toMatch(dash)
      expect(invisibleFileMessage(VAE)).not.toMatch(dash)
    })
  })
})
