// @vitest-environment jsdom
/**
 * The text encoder picked for a local Qwen-Image 2.1, through the real
 * generate path of useCreate: the pick from the advanced settings reaches the
 * builder on every kind of run the family has (new picture, edit, edit with
 * references, transparent background, one image after the other as the batch
 * does it, and behind the prompt enhancer).
 *
 * Nothing is rendered: ComfyUI and the enhancer run are mocked, and the run is
 * stopped at the submit of the picture. Which file the pick loads is the
 * builder's part (api/__tests__/qwen-image-21-no-refusals.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

type Built = { prompt: string; inputImage?: string; referenceImages?: string[]; transparent?: boolean; qwenTextEncoder?: string }
const seen = vi.hoisted(() => ({
  order: [] as string[],
  built: [] as Built[],
  enhancer: [] as { file: string; mode: string }[],
}))

vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => false,
  isMlxImageModel: () => false,
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn(() => ''),
  generateMlxImageDataUrl: vi.fn(),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => true),
  submitWorkflow: vi.fn(async () => { seen.order.push('submit-picture'); throw new Error('stop here') }),
}))
vi.mock('../../api/comfyui-ws', () => ({
  CLIENT_ID: 'lu-test',
  comfyWS: { connect: vi.fn(async () => { throw new Error('no socket') }), mark: () => 0, onPreview: () => () => {} },
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))
vi.mock('../../api/dynamic-workflow', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  buildDynamicWorkflow: vi.fn(async (params: Built) => {
    seen.order.push('build-picture')
    seen.built.push({
      prompt: params.prompt, inputImage: params.inputImage, referenceImages: params.referenceImages,
      transparent: params.transparent, qwenTextEncoder: params.qwenTextEncoder,
    })
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
}))
vi.mock('../../api/qwen-enhancer', () => ({
  buildQwenEnhancerWorkflow: vi.fn(async (req: { file: string; mode: string }) => {
    seen.order.push('build-enhancer')
    seen.enhancer.push({ file: req.file, mode: req.mode })
    return { '4': { class_type: 'TextGenerate', inputs: {} } }
  }),
  runQwenEnhancer: vi.fn(async () => ({ status: 'improved', prompt: 'A long rewritten prompt from the enhancer.' })),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'
import { QWEN21_WEIGHTS } from '../../api/__tests__/qwen21-weights'

const OFFICIAL = 'qwen3vl_8b_int8_convrot.safetensors'
const FREE = 'qwen3vl_8b_int8_convrot_heretic.safetensors'
const T2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors'
const I2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors'

const image = (filename: string) => ({ filename, url: `blob:${filename}`, width: 1024, height: 1024 })

// Every run of the family, once per image model file: the official weights
// and the Noct Q finetune. The type comes from the real classifier.
describe.each(QWEN21_WEIGHTS)('local Qwen-Image 2.1, %s', (_weights, QWEN) => {
  beforeEach(() => {
    seen.order.length = 0
    seen.built.length = 0
    seen.enhancer.length = 0
    useCreateStore.setState({
      backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [],
      improvePrompt: false, improveWith: 'auto', qwenTextEncoder: 'unfiltered',
      cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
      selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42,
      imageModel: QWEN, imageModelList: [{ name: QWEN, type: classifyModel(QWEN) }],
      textEncoderList: [OFFICIAL, FREE],
    } as never)
    const s = useCreateStore.getState()
    s.setIntent('image')
    s.setPrompt('a fox in snow')
  })

  async function run() {
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
  }

  describe('the picked text encoder reaches the builder', () => {
    it('Image: a new picture', async () => {
      await run()
      expect(seen.built).toHaveLength(1)
      expect(seen.built[0].qwenTextEncoder).toBe('unfiltered')
      expect(seen.built[0].prompt).toBe('a fox in snow')
    })

    it('the default sends no pick, the builder then takes the official one first', async () => {
      useCreateStore.setState({ qwenTextEncoder: 'auto' } as never)
      await run()
      expect(seen.built[0].qwenTextEncoder).toBeUndefined()
    })

    it('the official one picked by hand is sent as such', async () => {
      useCreateStore.setState({ qwenTextEncoder: 'official' } as never)
      await run()
      expect(seen.built[0].qwenTextEncoder).toBe('official')
    })

    it('Edit without a mask, with the source', async () => {
      useCreateStore.getState().setIntent('edit')
      useCreateStore.setState({ source: image('street.png') } as never)
      await run()
      expect(seen.built[0]).toMatchObject({ inputImage: 'street.png', qwenTextEncoder: 'unfiltered' })
    })

    it('Edit with three more reference images', async () => {
      useCreateStore.getState().setIntent('edit')
      useCreateStore.setState({ source: image('street.png'), references: [image('a.png'), image('b.png'), image('c.png')] } as never)
      await run()
      expect(seen.built[0]).toMatchObject({
        inputImage: 'street.png', referenceImages: ['a.png', 'b.png', 'c.png'], qwenTextEncoder: 'unfiltered',
      })
    })

    it('Transparent background', async () => {
      useCreateStore.setState({ transparentBackground: true } as never)
      await run()
      expect(seen.built[0]).toMatchObject({ transparent: true, qwenTextEncoder: 'unfiltered' })
    })

    // The batch runs the normal single run once per image, with that image as
    // the source (batchRun.ts). Two runs in a row are what it does.
    it('several images edited one after the other: every run carries the pick', async () => {
      useCreateStore.getState().setIntent('edit')
      for (const name of ['one.png', 'two.png']) {
        useCreateStore.setState({ source: image(name), isGenerating: false, error: null } as never)
        await run()
      }
      expect(seen.built.map((b) => [b.inputImage, b.qwenTextEncoder])).toEqual([['one.png', 'unfiltered'], ['two.png', 'unfiltered']])
    })
  })

  describe('together with Improve my prompt', () => {
    beforeEach(() => {
      useCreateStore.setState({ improvePrompt: true, improveWith: 'unfiltered', textEncoderList: [OFFICIAL, FREE, T2I_FREE, I2I_FREE] } as never)
    })

    it('new picture: the enhancer writes, then the picture is built with the picked encoder', async () => {
      await run()
      expect(seen.enhancer).toEqual([{ file: T2I_FREE, mode: 't2i' }])
      expect(seen.order).toEqual(['build-enhancer', 'build-picture', 'submit-picture'])
      expect(seen.built[0]).toMatchObject({ prompt: 'A long rewritten prompt from the enhancer.', qwenTextEncoder: 'unfiltered' })
    })

    it('edit: the edit enhancer writes, the encoder pick rides along', async () => {
      useCreateStore.getState().setIntent('edit')
      useCreateStore.setState({ source: image('street.png') } as never)
      await run()
      expect(seen.enhancer).toEqual([{ file: I2I_FREE, mode: 'i2i' }])
      expect(seen.built[0]).toMatchObject({ inputImage: 'street.png', qwenTextEncoder: 'unfiltered' })
    })

    it('the text encoder is never offered to the enhancer as its file', async () => {
      useCreateStore.setState({ textEncoderList: [OFFICIAL, FREE] } as never)
      await run()
      expect(seen.enhancer).toHaveLength(0)
    })
  })
})
