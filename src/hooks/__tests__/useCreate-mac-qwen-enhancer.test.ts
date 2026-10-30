// @vitest-environment jsdom
/**
 * "Improve my prompt" with Qwen-Image 2.1 on a Mac (GH #148). With the MLX
 * prompt enhancer installed it writes instead of the chat model, for a new
 * picture and for an edit: after the chat model is out of memory, before the
 * image model loads, with the images of the edit. Without one, a new picture
 * is rewritten by the chat model as before.
 *
 * Nothing is loaded: the MLX modules and the chat rewrite are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({
  order: [] as string[],
  runs: [] as Array<Record<string, unknown>>,
  enhancer: [] as Array<Record<string, unknown>>,
  chat: [] as string[],
  outcome: { status: 'improved', prompt: 'A long rewritten prompt from the enhancer.' } as Record<string, unknown>,
  /** Set to hold the enhancer open until it is aborted. */
  wait: false,
  ids: { 'MLX Qwen-Image 2.1 8-bit': 'qwen-image-2.1-8bit', 'MLX Z-Image Turbo 8-bit': 'z-image-turbo-8bit' } as Record<string, string>,
}))
vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: (name: string) => name.startsWith('MLX '),
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn((name: string) => seen.ids[name] ?? 'sd-turbo'),
  generateMlxImageDataUrl: vi.fn(async (args: Record<string, unknown>) => {
    seen.order.push('image')
    seen.runs.push(args)
    return { dataUrl: 'data:image/png;base64,AAAA', width: 1024, height: 1024, localPath: '/i/mlx-1.png' }
  }),
}))
vi.mock('../../api/mlx-enhancer', () => ({
  enhancePromptOnMac: vi.fn(async (req: Record<string, unknown>, signal?: AbortSignal) => {
    seen.order.push('enhancer')
    seen.enhancer.push(req)
    if (seen.wait) {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
      return { status: 'failed' }
    }
    return seen.outcome
  }),
}))
vi.mock('../../lib/render/improve-prompt-run', () => ({
  improvePrompt: vi.fn(async (prompt: string) => {
    seen.order.push('chat')
    seen.chat.push(prompt)
    return { status: 'improved', prompt: 'A rewrite from the chat model.' }
  }),
}))
vi.mock('../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: false, installedModels: [] })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
  stageStartImage: vi.fn(async () => '/data/videos/start-images/late.png'),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => false),
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => {
    seen.order.push('free-chat')
    return null
  }),
  restoreChatBackendsAfterRender: vi.fn(),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import type { ClassifiedModel } from '../../api/comfyui'
import { listMlxImageModels, mlxStatus } from '../../api/mlx-image'

const T2I = 'qwen-image-2.1-pe-t2i-4bit'
const I2I = 'qwen-image-2.1-pe-i2i-4bit'
const QWEN: ClassifiedModel = { name: 'MLX Qwen-Image 2.1 8-bit', type: 'qwenimage', source: 'checkpoint', editImages: 10 }
const ZIMAGE: ClassifiedModel = { name: 'MLX Z-Image Turbo 8-bit', type: 'zimage', source: 'checkpoint', editImages: 0 }
const img = (name: string) => ({ filename: `/data/videos/start-images/${name}.png`, url: 'data:image/png;base64,AA', width: 1600, height: 900 })

function arrange(intent: 'image' | 'edit', enhancers: string[], pick: ClassifiedModel = QWEN) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], improvePrompt: true, improveWith: 'auto',
    cloudOp: null, utilityOp: null, removebg: false, mask: null, references: [], batchSources: [], source: null,
    mode: 'image', imageSubMode: 'text2img', transparentBackground: false, batchSize: 1, seed: 7, negativePrompt: '',
    imageModelList: [QWEN, ZIMAGE], videoModelList: [], mlxEnhancerList: enhancers,
    // ComfyUI's list is not the Mac's: an enhancer file named there is not installed here.
    textEncoderList: ['qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors'],
  } as never)
  const s = useCreateStore.getState()
  s.setImageModel(pick.name, pick.type)
  s.setIntent(intent)
  s.setPrompt('a fox')
}
const state = () => useCreateStore.getState()

beforeEach(() => {
  seen.order.length = 0
  seen.runs.length = 0
  seen.enhancer.length = 0
  seen.chat.length = 0
  seen.wait = false
  seen.outcome = { status: 'improved', prompt: 'A long rewritten prompt from the enhancer.' }
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['12345'], { type: 'image/png' }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('a new picture with Qwen-Image 2.1 on a Mac', () => {
  it('the enhancer writes after the chat model has left the memory and before the image, and the image takes its prompt', async () => {
    arrange('image', [T2I, I2I])
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.order).toEqual(['free-chat', 'enhancer', 'image'])
    expect(seen.enhancer).toEqual([{ model: T2I, mode: 't2i', prompt: 'a fox', images: [], seed: 7 }])
    expect(seen.runs[0].prompt).toBe('A long rewritten prompt from the enhancer.')
    expect(seen.chat).toEqual([])
    expect(state().gallery[0]).toMatchObject({
      prompt: 'A long rewritten prompt from the enhancer.', promptOriginal: 'a fox', rewrittenBy: 'Qwen enhancer',
    })
    expect(state().error).toBeNull()
  })

  it('a rewrite that fails leaves the user its prompt, and the picture is made', async () => {
    arrange('image', [T2I])
    seen.outcome = { status: 'failed' }
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.runs[0].prompt).toBe('a fox')
    expect(state().gallery[0]).toMatchObject({ prompt: 'a fox', improveFailed: true })
    expect(state().gallery[0].promptOriginal).toBeUndefined()
  })

  it('the chat model picked in the row writes instead', async () => {
    arrange('image', [T2I])
    useCreateStore.setState({ improveWith: 'chat' } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.enhancer).toEqual([])
    expect(seen.chat).toEqual(['a fox'])
    expect(seen.runs[0].prompt).toBe('A rewrite from the chat model.')
  })

  it('without an enhancer installed the chat model writes, as before', async () => {
    arrange('image', [])
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.enhancer).toEqual([])
    expect(seen.order).toEqual(['chat', 'free-chat', 'image'])
    expect(seen.runs[0].prompt).toBe('A rewrite from the chat model.')
  })

  it('another model takes no enhancer', async () => {
    arrange('image', [T2I, I2I], ZIMAGE)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.enhancer).toEqual([])
    expect(seen.chat).toEqual(['a fox'])
  })

  it('switched off, nobody rewrites', async () => {
    arrange('image', [T2I, I2I])
    useCreateStore.setState({ improvePrompt: false } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.enhancer).toEqual([])
    expect(seen.chat).toEqual([])
    expect(seen.runs[0].prompt).toBe('a fox')
  })
})

describe('an edit with Qwen-Image 2.1 on a Mac', () => {
  it('the edit enhancer reads the images of the edit, in the order the edit reads them', async () => {
    arrange('edit', [T2I, I2I])
    useCreateStore.setState({ source: img('a'), references: [img('b')] } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.enhancer).toEqual([{
      model: I2I, mode: 'i2i', prompt: 'a fox', seed: 7,
      images: ['/data/videos/start-images/a.png', '/data/videos/start-images/b.png'],
    }])
    expect(seen.runs[0]).toMatchObject({
      prompt: 'A long rewritten prompt from the enhancer.',
      images: ['/data/videos/start-images/a.png', '/data/videos/start-images/b.png'],
    })
  })

  it('without the edit enhancer the chat model rewrites an edit as an instruction (B48)', async () => {
    arrange('edit', [T2I])
    useCreateStore.setState({ source: img('a') } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.enhancer).toEqual([])
    expect(seen.chat).toHaveLength(1)
    expect(seen.runs[0].prompt).not.toBe('a fox')
  })

  it('Cancel while the enhancer writes starts no image and shows no error', async () => {
    arrange('edit', [I2I])
    useCreateStore.setState({ source: img('a') } as never)
    seen.wait = true
    const { result } = renderHook(() => useCreate())
    const pending = result.current.generate()
    await vi.waitFor(() => expect(seen.enhancer).toHaveLength(1))
    result.current.cancel()
    await pending
    expect(seen.runs).toEqual([])
    expect(state().gallery).toEqual([])
    expect(state().error).toBeNull()
    expect(state().isGenerating).toBe(false)
  })
})

describe('the model lists bring the installed enhancers along', () => {
  const row = (id: string, installed: boolean, family: string, enhancer?: 't2i' | 'i2i') => ({
    id, name: id, repo: 'r/' + id, sizeGB: 6, minRamGB: 16, steps: 0, guidance: 0, defaultSize: 0,
    unfiltered: false, description: '', installed, family, editImages: 0, ...(enhancer ? { enhancer } : {}),
  })

  it('the installed ones of the catalogue, and none after a read that finds no engine', async () => {
    arrange('image', [])
    vi.mocked(mlxStatus).mockResolvedValueOnce({ installed: true } as never)
    vi.mocked(listMlxImageModels).mockResolvedValueOnce([
      row(T2I, true, 'enhancer', 't2i'), row(I2I, false, 'enhancer', 'i2i'), row('qwen-image-2.1-4bit', true, 'mflux'),
    ] as never)
    const { result } = renderHook(() => useCreate())
    await result.current.fetchModels()
    expect(state().mlxEnhancerList).toEqual([T2I])
    // Removed since, or the engine gone: the last list is not kept.
    vi.mocked(mlxStatus).mockResolvedValueOnce({ installed: false } as never)
    await result.current.fetchModels()
    expect(state().mlxEnhancerList).toEqual([])
  })
})
