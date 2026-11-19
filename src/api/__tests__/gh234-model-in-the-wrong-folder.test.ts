/**
 * GitHub #234: a bare video model in models/checkpoints was offered by Create
 * and ended in ComfyUI's raw "Node 1 (UNETLoader): Value not in list". Now the
 * rejection is read, the file is found in the other folder, and the user is
 * told where it is, where it belongs and what to do.
 *
 * Run: npx vitest run src/api/__tests__/gh234-model-in-the-wrong-folder.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { misplacedModelMessage, missedModelsOf } from '../../lib/misplaced-model'

const FILE = 'ltx-2.5-22b-distilled-transformer-fp8_e4m3fn.safetensors'
const folders = vi.hoisted(() => ({ checkpoints: [] as string[], unets: [] as string[], rejection: {} as unknown, status: 400 }))

/** ComfyUI's answer, as server.py post_prompt sends it (validate_inputs). */
function rejection(classType: string, field: string, file: string) {
  return {
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
    node_errors: {
      '1': {
        errors: [{
          type: 'value_not_in_list',
          message: 'Value not in list',
          details: `${field}: '${file}' not in (list of length 22)`,
          extra_info: { input_name: field, received_value: file },
        }],
        dependent_outputs: ['9'],
        class_type: classType,
      },
    },
  }
}

vi.mock('../backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isTauri: () => false,
  localFetch: vi.fn(async (url: string) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (url.includes('/object_info/CheckpointLoaderSimple')) return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [folders.checkpoints] } } } })
    if (url.includes('/object_info/UNETLoader')) return json({ UNETLoader: { input: { required: { unet_name: [folders.unets, {}] } } } })
    if (url.endsWith('/prompt')) return json(folders.rejection, folders.status)
    return json({}, 404)
  }),
}))
vi.mock('../comfy-split', () => ({ withComfySplit: async (w: unknown) => w }))

import { submitWorkflow } from '../comfyui'

beforeEach(() => {
  folders.checkpoints = ['sdxl.safetensors', FILE]
  folders.unets = ['wan.safetensors']
  folders.rejection = rejection('UNETLoader', 'unet_name', FILE)
  folders.status = 400
})

describe('reading the rejection', () => {
  it('finds the file the loader missed, from extra_info or from the details', () => {
    expect(missedModelsOf(rejection('UNETLoader', 'unet_name', FILE))).toEqual([{ loader: 'UNETLoader', file: FILE, folder: 'diffusion_models' }])
    const older = rejection('CheckpointLoaderSimple', 'ckpt_name', 'x.safetensors')
    delete (older.node_errors['1'].errors[0] as Record<string, unknown>).extra_info
    expect(missedModelsOf(older)).toEqual([{ loader: 'CheckpointLoaderSimple', file: 'x.safetensors', folder: 'checkpoints' }])
  })
  it('leaves every other rejection alone', () => {
    expect(missedModelsOf(rejection('VAELoader', 'vae_name', 'v.safetensors'))).toEqual([])
    expect(missedModelsOf({ error: 'boom' })).toEqual([])
    expect(missedModelsOf(null)).toEqual([])
  })
  it('names a file in the other folder, and stays quiet for a file in neither', () => {
    const missed = { loader: 'UNETLoader', file: FILE, folder: 'diffusion_models' as const }
    const msg = misplacedModelMessage(missed, { checkpoints: [FILE], diffusionModels: [] })
    expect(msg).toContain('is in models/checkpoints')
    expect(msg).toContain('Move the file to models/diffusion_models')
    expect(misplacedModelMessage(missed, { checkpoints: [], diffusionModels: [] })).toBeNull()
  })
})

describe('the Create run', () => {
  it('THE REPORT: says where the file is and where it belongs, not ComfyUI\'s raw line', async () => {
    const err = (await submitWorkflow({ '1': { class_type: 'UNETLoader', inputs: { unet_name: FILE } } } as never).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain(FILE)
    expect(err.message).toContain('models/checkpoints')
    expect(err.message).toContain('models/diffusion_models')
    expect(err.message).not.toContain('Value not in list')
  })

  it('the same for a half rejection (HTTP 200 with node_errors)', async () => {
    folders.status = 200
    folders.rejection = { prompt_id: 'p1', ...rejection('UNETLoader', 'unet_name', FILE) }
    const err = (await submitWorkflow({} as never).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('Move the file to models/diffusion_models')
  })

  it('NEGATIVE CONTROL: a file in no folder keeps ComfyUI\'s own line', async () => {
    folders.checkpoints = ['sdxl.safetensors']
    const err = (await submitWorkflow({} as never).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/ComfyUI rejected workflow: .*UNETLoader.*Value not in list/)
  })
})
