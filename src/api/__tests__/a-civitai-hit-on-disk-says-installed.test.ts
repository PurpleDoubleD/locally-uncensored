/**
 * A feature request (3.0.7): in the CivitAI search of the
 * Model Manager a model that is already on disk still offered Download. A hit
 * counts as installed when its file lies in the folder the download would write
 * it to, under the same name and, where CivitAI states it, with the same size.
 * The same name in another folder, or another size (another version, a
 * different upload), is not this model.
 *
 * Run: npx vitest run src/api/__tests__/a-civitai-hit-on-disk-says-installed.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
const fetchExternal = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  fetchExternal: (...args: unknown[]) => fetchExternal(...args),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

import { searchCivitaiModels, checkCivitaiInstalled, civitaiInstalledInFolder, type CivitAIModelResult } from '../discover'

const hit = (id: number, filename: string, subfolder: string, sizeBytes?: number): CivitAIModelResult => ({
  id, name: `Model ${id}`, description: '', type: 'Checkpoint', sourceUrl: `https://civitai.com/models/${id}`,
  downloadUrl: `https://civitai.com/api/download/models/${id}`, filename, subfolder, sizeBytes,
})

/** What lies on disk, by ComfyUI folder and file name. */
let disk: Record<string, number> = {}

beforeEach(() => {
  disk = {}
  fetchExternal.mockReset()
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string, args: { files: Array<{ subfolder: string; filename: string }> }) => {
    if (cmd !== 'check_model_sizes') throw new Error(`unexpected ${cmd}`)
    return args.files.map((f) => {
      const bytes = disk[`${f.subfolder}/${f.filename}`]
      return { filename: f.filename, exists: bytes != null, actualBytes: bytes ?? 0, complete: bytes != null }
    })
  })
})

describe('the CivitAI search knows the exact size of a hit', () => {
  it('takes the byte count from sizeKB, not only the rounded GB', async () => {
    fetchExternal.mockResolvedValue(JSON.stringify({
      items: [{ id: 3, name: 'Juggernaut XL', stats: {}, modelVersions: [{ downloadUrl: 'https://civitai.com/api/download/models/3', files: [{ name: 'juggernautXL_v9.safetensors', sizeKB: 2082642.3828125 }] }] }],
    }))
    const [m] = await searchCivitaiModels('juggernaut')
    expect(m.sizeBytes).toBe(2_132_625_800)
    expect(m.sizeGB).toBe(2)
  })
})

describe('checkCivitaiInstalled', () => {
  it('marks only the hit whose file lies in its own folder with its own size', async () => {
    const same = hit(1, 'juggernautXL_v9.safetensors', 'checkpoints', 6_938_040_682)
    const otherVersion = hit(2, 'detail_tweaker.safetensors', 'loras', 151_110_000)
    // A27 (3.1.0): checkpoints and diffusion_models count as one place here,
    // since a download from the search moves between them by its header. A
    // LoRA folder is still another place.
    const otherFolder = hit(3, 'flux_dev_fp8.safetensors', 'loras', 11_900_000_000)
    disk['checkpoints/juggernautXL_v9.safetensors'] = 6_938_040_682
    disk['loras/detail_tweaker.safetensors'] = 151_110_000 + 37_000_000
    disk['checkpoints/flux_dev_fp8.safetensors'] = 11_900_000_000

    const installed = await checkCivitaiInstalled([same, otherVersion, otherFolder])

    expect([...installed]).toEqual([1])
    // One question to the existing per-file check, no folder scan of its own.
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(backendCall.mock.calls[0][1].files.map((f: { subfolder: string }) => f.subfolder))
      .toEqual(['checkpoints', 'diffusion_models', 'loras', 'loras'])
  })

  it('takes the name alone where CivitAI states no size', async () => {
    disk['loras/pixel_art.safetensors'] = 9_000_000
    expect([...await checkCivitaiInstalled([hit(4, 'pixel_art.safetensors', 'loras')])]).toEqual([4])
  })

  it('does not count an empty file as installed', async () => {
    disk['loras/pixel_art.safetensors'] = 0
    expect(await checkCivitaiInstalled([hit(4, 'pixel_art.safetensors', 'loras')])).toEqual(new Set())
  })

  it('says nothing is installed when the check cannot run, so Download stays', async () => {
    backendCall.mockRejectedValue(new Error('no ComfyUI'))
    expect(await checkCivitaiInstalled([hit(1, 'a.safetensors', 'checkpoints', 10)])).toEqual(new Set())
  })

  it('asks nothing for an empty list', async () => {
    expect(await checkCivitaiInstalled([])).toEqual(new Set())
    expect(backendCall).not.toHaveBeenCalled()
  })
})

describe('civitaiInstalledInFolder (the Mac LoRA folder, already listed)', () => {
  const lora = hit(7, 'qwen-2.1-detail.safetensors', 'loras', 153_000_000)

  it('marks the hit whose file lies at the top of the folder with its size', () => {
    expect([...civitaiInstalledInFolder([lora], [{ name: 'qwen-2.1-detail.safetensors', sizeBytes: 153_000_000 }])]).toEqual([7])
  })

  it('does not mark a file of the same name with another size', () => {
    expect(civitaiInstalledInFolder([lora], [{ name: 'qwen-2.1-detail.safetensors', sizeBytes: 120_000_000 }])).toEqual(new Set())
  })

  it('does not mark a file of the same name in a subfolder, where the download does not write', () => {
    expect(civitaiInstalledInFolder([lora], [{ name: 'old/qwen-2.1-detail.safetensors', sizeBytes: 153_000_000 }])).toEqual(new Set())
  })
})
