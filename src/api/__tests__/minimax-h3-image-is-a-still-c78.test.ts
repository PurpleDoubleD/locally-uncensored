/**
 * C78 (Discord feature-requests, 11.11.2026): a local MiniMax H3 Image file
 * landed in the video lane, because every "minimax_h3" name was taken for the
 * H3 video model. The image variant (Comfy-Org/MiniMax-H3-Image, 08.11.2026)
 * is a still model on the H3 layout without the sound half. The name says so
 * where it can; the header (model_sniff.rs) says so where it cannot.
 *
 * Run: npx vitest run src/api/__tests__/minimax-h3-image-is-a-still-c78.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backend = vi.hoisted(() => ({ call: vi.fn(), tauri: vi.fn(() => true) }))
vi.mock('../backend', async (o) => ({ ...(await o<typeof import('../backend')>()), backendCall: backend.call, isTauri: backend.tauri }))

import { applyHeaderSniff, classifyModel, isImageModelType, isVideoModelType, type ClassifiedModel } from '../comfyui'
import { determineStrategy, MINIMAX_H3_IMAGE_NEEDS_UPDATE } from '../dynamic-workflow'

const sniffs = (arch: Record<string, string | null>) =>
  backend.call.mockReset().mockImplementation(async (_cmd: string, args: { files: Array<{ folder: string; name: string }> }) =>
    args.files.map((f) => ({ ...f, arch: arch[f.name] ?? null, hasTextEncoder: false, hasVae: false })))

beforeEach(() => backend.tauri.mockReturnValue(true))

describe('MiniMax H3 Image is a still model', () => {
  it('the official names go to the image lane, the video names stay video', () => {
    for (const n of ['minimax_h3_image_pruned_w4a8.safetensors', 'minimax_h3_image_pruned_int8_convrot.safetensors', 'MiniMax-H3-Image-Q8_0.gguf', 'minimaxh3image_v1.safetensors']) {
      expect(classifyModel(n), n).toBe('minimaxh3image')
      expect(isImageModelType(classifyModel(n))).toBe(true)
      expect(isVideoModelType(classifyModel(n))).toBe(false)
    }
    for (const n of ['minimax_h3_ref2va_pruned_w6a8.safetensors', 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors', 'fastvideo_fasth3_8step_v2_bf16.safetensors']) {
      expect(classifyModel(n), n).toBe('minimaxh3')
    }
  })

  it('a name that says only "minimax_h3" is moved to the image lane by its header', async () => {
    sniffs({ 'minimax_h3_nsfw_v2.safetensors': 'minimaxh3image', 'minimax_h3_ref2va_pruned_w6a8.safetensors': 'minimaxh3' })
    const models: ClassifiedModel[] = [
      { name: 'minimax_h3_nsfw_v2.safetensors', type: classifyModel('minimax_h3_nsfw_v2.safetensors'), source: 'diffusion_model' },
      { name: 'minimax_h3_ref2va_pruned_w6a8.safetensors', type: 'minimaxh3', source: 'diffusion_model' },
    ]
    expect(models[0].type).toBe('minimaxh3')
    await applyHeaderSniff(models)
    expect(models.map((m) => m.type)).toEqual(['minimaxh3image', 'minimaxh3'])
    // The video file is as it was: no parts recorded for it.
    expect(models[1].parts).toBeUndefined()
  })

  it('a name of no family is placed by the header as well', async () => {
    sniffs({ 'h3img_realism.safetensors': 'minimaxh3image' })
    const models: ClassifiedModel[] = [{ name: 'h3img_realism.safetensors', type: 'unknown', source: 'diffusion_model' }]
    await applyHeaderSniff(models)
    expect(models[0].type).toBe('minimaxh3image')
  })

  it('the header never turns an H3 video name into another video family', async () => {
    sniffs({ 'minimax_h3_odd.safetensors': 'wan' })
    const models: ClassifiedModel[] = [{ name: 'minimax_h3_odd.safetensors', type: 'minimaxh3', source: 'diffusion_model' }]
    await applyHeaderSniff(models)
    expect(models[0].type).toBe('minimaxh3')
  })

  // 3.1.3: LU builds the graph itself (minimax-h3-image-builtin.test.ts). An
  // older ComfyUI without the node gets the update sentence.
  it('LU\'s own builder runs it from ComfyUI 0.45.0 and asks an older one to update', () => {
    const base = { loaders: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CheckpointLoaderSimple'], samplers: ['KSampler'], latentInit: [] as string[], textEncoders: [], decoders: [], savers: [], motion: [], other: [] }
    const old = determineStrategy('minimaxh3image', false, base as never, {} as never)
    expect(old).toEqual({ strategy: 'unavailable', reason: MINIMAX_H3_IMAGE_NEEDS_UPDATE })
    expect(old.reason).toMatch(/update comfyui/i)
    const now = determineStrategy('minimaxh3image', false, { ...base, latentInit: ['MiniMaxH3ImageConditioning'] } as never, {} as never)
    expect(now.strategy).toBe('minimaxh3image')
  })
})
