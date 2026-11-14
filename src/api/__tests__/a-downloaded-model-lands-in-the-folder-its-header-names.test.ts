/**
 * A27 (3.1.0, GitHub #234, Kubuntu, RTX 5090): diffusion and video models
 * downloaded through the CivitAI search landed in models/checkpoints. The
 * folder came from the title alone; only flux, wan, hunyuan and .gguf went
 * to diffusion_models. LTX, MiniMax H3, Qwen-Image, Z-Image, Chroma, Krea,
 * Mochi, CogVideoX and Wan offshoots went to checkpoints, where ComfyUI's
 * checkpoint loader cannot load a bare diffusion model.
 *
 * The fix is in Rust (model_sniff.rs settle_by_header, tested there against
 * real headers): after the transfer the file's header names its folder and
 * the file moves there. This side only has to ask for it on every download
 * whose folder is a guess, and on no other one.
 *
 * Run: npx vitest run src/api/__tests__/a-downloaded-model-lands-in-the-folder-its-header-names.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  fetchExternal: vi.fn(),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

import {
  civitaiSubfolder, checkCivitaiInstalled, folderIsAGuess, resumeDownload, startChatLinkDownload,
  startCivitaiDownload, startModelDownload, type CivitAIModelResult,
} from '../discover'
import { wrongFolderNote } from '../../components/models/ModelFileInfo'

const callsTo = (cmd: string) => backendCall.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>)

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockImplementation(async () => ({ status: 'started', id: 'x' }))
})

describe('the bug: the title alone picks the folder', () => {
  it.each([
    'LTX Video 2B distilled', 'MiniMax H3', 'Qwen-Image 2512', 'Z-Image Turbo', 'Chroma1-HD',
    'Krea 2', 'Mochi 1 preview', 'CogVideoX 5B', 'Rapid AIO Mega v12',
  ])('%s goes to checkpoints by its title', (title) => {
    expect(civitaiSubfolder('Checkpoint', title, 'model.safetensors')).toBe('checkpoints')
  })

  it('which is why a title guess is marked for the header to decide', () => {
    expect(folderIsAGuess('checkpoints')).toBe(true)
    expect(folderIsAGuess('diffusion_models')).toBe(true)
    expect(folderIsAGuess('unet')).toBe(true)
    for (const f of ['loras', 'vae', 'embeddings', 'text_encoders', 'upscale_models']) expect(folderIsAGuess(f)).toBe(false)
  })
})

describe('which downloads ask the header', () => {
  it('a CivitAI checkpoint hit does', async () => {
    await startCivitaiDownload({ downloadUrl: 'https://civitai.com/api/download/models/1', filename: 'ltx.safetensors', subfolder: 'checkpoints' })
    expect(callsTo('download_model')[0]).toMatchObject({ subfolder: 'checkpoints', filename: 'ltx.safetensors', sniffFolder: true })
  })

  it('a CivitAI LoRA does not: its search type says what it is', async () => {
    await startCivitaiDownload({ downloadUrl: 'https://civitai.com/api/download/models/2', filename: 'style.safetensors', subfolder: 'loras' })
    expect(callsTo('download_model')[0]).not.toHaveProperty('sniffFolder')
  })

  it('a link the chat agent downloads into a main model folder does', async () => {
    await startChatLinkDownload('https://huggingface.co/a/b/resolve/main/m.safetensors', 'diffusion_models', 'm.safetensors')
    await startChatLinkDownload('https://huggingface.co/a/b/resolve/main/l.safetensors', 'loras', 'l.safetensors')
    const [main, lora] = callsTo('download_model')
    expect(main).toMatchObject({ chatOrigin: true, sniffFolder: true })
    expect(lora).not.toHaveProperty('sniffFolder')
  })

  it('NEGATIVE CONTROL: a catalog bundle file does not; its folder is the catalog\'s and its install check looks there', async () => {
    await startModelDownload('https://huggingface.co/Comfy-Org/x/resolve/main/m.safetensors', 'checkpoints', 'm.safetensors', 1000, 'a'.repeat(64))
    expect(callsTo('download_model')[0]).not.toHaveProperty('sniffFolder')
  })

  it('a resume keeps asking', async () => {
    await resumeDownload('ltx.safetensors', 'https://civitai.com/api/download/models/1', 'checkpoints', undefined, undefined, true)
    await resumeDownload('m.safetensors', 'https://huggingface.co/x/m.safetensors', 'checkpoints')
    const [civitai, catalog] = callsTo('resume_download')
    expect(civitai).toMatchObject({ sniffFolder: true })
    expect(catalog).not.toHaveProperty('sniffFolder')
  })
})

describe('after the move', () => {
  const hit = (subfolder: string): CivitAIModelResult => ({
    id: 7, name: 'LTX distilled', description: '', type: 'Checkpoint', sourceUrl: 'https://civitai.com/models/7',
    downloadUrl: 'https://civitai.com/api/download/models/7', filename: 'ltx.safetensors', subfolder, sizeBytes: 2048,
  })

  it('the hit still shows as installed when its file now sits in diffusion_models', async () => {
    backendCall.mockImplementation(async (cmd: string, args: { files: Array<{ subfolder: string; filename: string }> }) => {
      if (cmd !== 'check_model_sizes') throw new Error(cmd)
      return args.files.map((f) => ({ filename: f.filename, exists: f.subfolder === 'diffusion_models', actualBytes: f.subfolder === 'diffusion_models' ? 2048 : 0 }))
    })
    expect(await checkCivitaiInstalled([hit('checkpoints')])).toEqual(new Set([7]))
  })

  it('NEGATIVE CONTROL: a LoRA hit is looked for in loras only', async () => {
    backendCall.mockImplementation(async (_cmd: string, args: { files: Array<{ subfolder: string; filename: string }> }) =>
      args.files.map((f) => ({ filename: f.filename, exists: f.subfolder !== 'loras', actualBytes: 2048 })))
    const lora = { ...hit('loras'), type: 'LORA' }
    expect(await checkCivitaiInstalled([lora])).toEqual(new Set())
    expect(callsTo('check_model_sizes')[0].files).toEqual([{ subfolder: 'loras', filename: 'ltx.safetensors', expectedBytes: 2048 }])
  })
})

describe('a file that already sits in the wrong folder', () => {
  it('is named in Details, with where it belongs and why, and never moved', () => {
    const note = wrongFolderNote('checkpoints', 'diffusion_models')
    expect(note).toContain('belongs in diffusion_models, not checkpoints')
    expect(note).toContain('Move it there by hand')
    expect(wrongFolderNote('diffusion_models', 'checkpoints')).toContain('its own VAE')
  })
})
