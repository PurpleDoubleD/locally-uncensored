// @vitest-environment jsdom
/**
 * "Improve my prompt" on a local Qwen-Image 2.1 (GH #148), through the real
 * generate path of useCreate: with an enhancer installed the enhancer writes,
 * after the chat model has left the card and before the picture is built;
 * without one the chat model writes, as before.
 *
 * Nothing is rendered: ComfyUI, the enhancer run and the chat call are mocked,
 * and the run is stopped at the submit of the picture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({
  order: [] as string[],
  enhancer: [] as { file: string; mode: string; prompt: string; images?: string[]; seed: number }[],
  built: [] as { prompt: string; inputImage?: string; referenceImages?: string[] }[],
  chat: [] as { prompt: string; kind: string }[],
  outcome: { status: 'improved', prompt: 'A long rewritten prompt from the enhancer.' } as { status: string; prompt?: string },
  buildError: null as Error | null,
  /** What the stage said while each writer was at work. */
  lineWhileWriting: [] as string[],
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
  evictChatBackendsForRender: vi.fn(async () => { seen.order.push('evict-chat'); return null }),
  restoreChatBackendsAfterRender: vi.fn(),
}))
vi.mock('../../api/dynamic-workflow', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  buildDynamicWorkflow: vi.fn(async (params: { prompt: string; inputImage?: string; referenceImages?: string[] }) => {
    seen.order.push('build-picture')
    seen.built.push({ prompt: params.prompt, inputImage: params.inputImage, referenceImages: params.referenceImages })
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
}))
vi.mock('../../api/qwen-enhancer', () => ({
  buildQwenEnhancerWorkflow: vi.fn(async (req: { file: string; mode: string; prompt: string; images?: string[]; seed: number }) => {
    seen.order.push('build-enhancer')
    if (seen.buildError) throw seen.buildError
    seen.enhancer.push(req)
    return { '4': { class_type: 'TextGenerate', inputs: {} } }
  }),
  runQwenEnhancer: vi.fn(async () => {
    seen.order.push('run-enhancer')
    const { useCreateStore } = await import('../../stores/createStore')
    seen.lineWhileWriting.push(useCreateStore.getState().progressText)
    return seen.outcome
  }),
}))
vi.mock('../../lib/render/improve-prompt-run', () => ({
  improvePrompt: vi.fn(async (prompt: string, target: { kind: string }) => {
    seen.order.push('chat-rewrite')
    seen.chat.push({ prompt, kind: target.kind })
    const { useCreateStore } = await import('../../stores/createStore')
    seen.lineWhileWriting.push(useCreateStore.getState().progressText)
    return { status: 'improved', prompt: 'A rewrite from the chat model.' }
  }),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'
import { QWEN21_WEIGHTS } from '../../api/__tests__/qwen21-weights'

const T2I = 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors'
const I2I = 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'
const T2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors'
const I2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors'

const image = (filename: string) => ({ filename, url: `blob:${filename}`, width: 1024, height: 1024 })

// Every run of the family, once per image model file: the official weights
// and the Noct Q finetune. The type comes from the real classifier.
describe.each(QWEN21_WEIGHTS)('local Qwen-Image 2.1, %s', (_weights, QWEN) => {
  beforeEach(() => {
    seen.order.length = 0
    seen.enhancer.length = 0
    seen.built.length = 0
    seen.chat.length = 0
    seen.outcome = { status: 'improved', prompt: 'A long rewritten prompt from the enhancer.' }
    seen.buildError = null
    seen.lineWhileWriting.length = 0
    useCreateStore.setState({
      backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [],
      improvePrompt: true, improveWith: 'auto',
      cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
      selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42,
      imageModel: QWEN, imageModelList: [{ name: QWEN, type: classifyModel(QWEN) }],
      textEncoderList: ['qwen3vl_8b_int8_convrot.safetensors', T2I, I2I, T2I_FREE, I2I_FREE],
    } as never)
    const s = useCreateStore.getState()
    s.setIntent('image')
    s.setPrompt('a fox in snow')
  })

  async function run() {
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
  }

  describe('Improve my prompt on local Qwen-Image 2.1, enhancer installed', () => {
    it('the enhancer writes, not the chat model, and the picture is built from its prompt', async () => {
      await run()
      expect(seen.chat).toHaveLength(0)
      expect(seen.enhancer).toEqual([{ file: T2I, mode: 't2i', prompt: 'a fox in snow', images: [], seed: 42 }])
      expect(seen.built).toHaveLength(1)
      expect(seen.built[0].prompt).toBe('A long rewritten prompt from the enhancer.')
      // The field keeps the user's own words.
      expect(useCreateStore.getState().prompt).toBe('a fox in snow')
    })

    // The box, 03.10.2026: 70 s for a new picture and 175 s for an edit
    // under a line that did not move. It counts its seconds like every other
    // waiting line.
    it('the waiting line counts its seconds while the enhancer writes', async () => {
      await run()
      expect(seen.lineWhileWriting).toEqual(['Improving your prompt… 0s'])
    })

    it('order on the card: chat model out, enhancer runs, then the picture is built', async () => {
      await run()
      expect(seen.order).toEqual(['evict-chat', 'build-enhancer', 'run-enhancer', 'build-picture', 'submit-picture'])
    })

    it('the user picked the one without refusals', async () => {
      useCreateStore.setState({ improveWith: 'unfiltered' } as never)
      await run()
      expect(seen.enhancer[0].file).toBe(T2I_FREE)
    })

    it('Edit: the edit enhancer gets the instruction, the source and the references in order', async () => {
      useCreateStore.getState().setIntent('edit')
      useCreateStore.setState({
        source: image('street.png'), references: [image('woman.png'), image('hat.png')], improveWith: 'unfiltered',
      } as never)
      useCreateStore.getState().setPrompt('put the woman from image 2 into the street')
      await run()
      expect(seen.chat).toHaveLength(0)
      expect(seen.enhancer).toEqual([{
        file: I2I_FREE, mode: 'i2i', prompt: 'put the woman from image 2 into the street',
        images: ['street.png', 'woman.png', 'hat.png'], seed: 42,
      }])
      expect(seen.built[0]).toEqual({
        prompt: 'A long rewritten prompt from the enhancer.',
        inputImage: 'street.png', referenceImages: ['woman.png', 'hat.png'],
      })
    })

    it('a failed rewrite does not stop the picture: it is built from the user\'s own prompt', async () => {
      seen.outcome = { status: 'failed' }
      await run()
      expect(seen.built[0].prompt).toBe('a fox in snow')
      expect(seen.chat).toHaveLength(0)
    })

    it('a rewrite that breaks the safety rule never runs', async () => {
      seen.outcome = { status: 'improved', prompt: 'a nude child on a beach' }
      await run()
      expect(seen.built[0].prompt).toBe('a fox in snow')
    })

    it('a ComfyUI too old for the enhancer and a no to the update: the run does not start and says why', async () => {
      seen.buildError = Object.assign(new Error('The Qwen prompt enhancer needs ComfyUI 0.37.2 or newer. Update ComfyUI in Settings.'), {
        name: 'WorkflowUnavailableError', needsComfyUpdate: true,
      })
      const { result } = renderHook(() => useCreate())
      const done = result.current.generate()
      await vi.waitFor(() => expect(useCreateStore.getState().fixupPrompt).not.toBeNull())
      expect(useCreateStore.getState().fixupPrompt?.title).toBe('ComfyUI needs an update')
      useCreateStore.getState().fixupPrompt?.resolve(false)
      await done
      expect(seen.built).toHaveLength(0)
      expect(useCreateStore.getState().error).toBe('Not started. The Qwen prompt enhancer needs ComfyUI 0.37.2 or newer. Update ComfyUI in Settings.')
    })

    it('switch off: neither writes', async () => {
      useCreateStore.setState({ improvePrompt: false } as never)
      await run()
      expect(seen.order).toEqual(['evict-chat', 'build-picture', 'submit-picture'])
      expect(seen.built[0].prompt).toBe('a fox in snow')
    })
  })

  describe('falling back to the chat model', () => {
    it('no enhancer installed: the chat model writes, before the card is cleared for the picture', async () => {
      useCreateStore.setState({ textEncoderList: ['qwen3vl_8b_int8_convrot.safetensors'] } as never)
      await run()
      expect(seen.lineWhileWriting).toEqual(['Improving your prompt… 0s'])
      expect(seen.enhancer).toHaveLength(0)
      expect(seen.chat).toEqual([{ prompt: 'a fox in snow', kind: 'image' }])
      expect(seen.order).toEqual(['chat-rewrite', 'evict-chat', 'build-picture', 'submit-picture'])
      expect(seen.built[0].prompt).toBe('A rewrite from the chat model.')
    })

    it('only the edit enhancer installed: a new picture is written by the chat model', async () => {
      useCreateStore.setState({ textEncoderList: [I2I, I2I_FREE] } as never)
      await run()
      expect(seen.enhancer).toHaveLength(0)
      expect(seen.chat).toHaveLength(1)
    })

    it('the user picked the chat model although the enhancer is there', async () => {
      useCreateStore.setState({ improveWith: 'chat' } as never)
      await run()
      expect(seen.enhancer).toHaveLength(0)
      expect(seen.built[0].prompt).toBe('A rewrite from the chat model.')
    })

    it('another local model with the enhancers on disk: the chat model writes', async () => {
      useCreateStore.setState({ imageModel: 'flux-2-klein-4b.safetensors', imageModelList: [{ name: 'flux-2-klein-4b.safetensors', type: 'flux2' }] } as never)
      await run()
      expect(seen.enhancer).toHaveLength(0)
      expect(seen.chat).toHaveLength(1)
    })

    it('Edit without an edit enhancer: nobody rewrites, as before', async () => {
      useCreateStore.getState().setIntent('edit')
      useCreateStore.setState({ source: image('street.png'), textEncoderList: [T2I, T2I_FREE] } as never)
      await run()
      expect(seen.enhancer).toHaveLength(0)
      expect(seen.chat).toHaveLength(0)
      expect(seen.built[0].prompt).toBe('a fox in snow')
    })
  })
})
