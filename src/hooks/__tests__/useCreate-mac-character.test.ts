// @vitest-environment jsdom
/**
 * Character Studio on the Mac (14.10.2026): "Use character" runs the
 * character's LoRA from the Mac's LoRA folder on the second image engine, the
 * way the local Use tab runs it in ComfyUI on Windows. Train new trains on
 * the Mac with its own engine (api/mlx-train.ts, since 3.0.8).
 *
 * Nothing is generated: the MLX modules are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mlx = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  staged: [] as number[],
  ids: {
    'MLX SD Turbo': 'sd-turbo',
    'MLX Qwen-Image 2.1 8-bit': 'qwen-image-2.1-8bit',
    'MLX Qwen-Image 2.1 Turbo 8-bit': 'qwen-image-2.1-turbo',
    'MLX Z-Image Turbo 4-bit': 'z-image-turbo-4bit',
  } as Record<string, string>,
  /** Set to hold a run open until it is aborted. */
  wait: false,
  made: { dataUrl: 'data:image/png;base64,AAAA', width: 1376, height: 768, localPath: '/i/mlx-1.png', steps: 30, guidance: 4 } as Record<string, unknown>,
}))
vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: (name: string) => name.startsWith('MLX '),
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn((name: string) => mlx.ids[name] ?? 'sd-turbo'),
  generateMlxImageDataUrl: vi.fn(async (args: Record<string, unknown>, watch: { signal?: AbortSignal; onStep?: (a: number, b: number) => void }) => {
    mlx.runs.push(args)
    watch?.onStep?.(3, 30)
    if (mlx.wait) {
      await new Promise((_resolve, reject) => {
        watch.signal?.addEventListener('abort', () => reject(new Error('The image was not finished because the app stopped the engine.')))
      })
    }
    return mlx.made
  }),
}))
vi.mock('../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: false, installedModels: [] })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
  stageStartImage: vi.fn(async (b: Blob) => { mlx.staged.push(b.size); return '/data/videos/start-images/late.png' }),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => false),
}))
// The hand-over of memory asks the chat backends what is loaded. That is not
// what these tests are about, and its requests must not count as theirs.
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))

vi.mock('../../api/mlx-loras', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  listMlxLoras: vi.fn(async () => ({ loras: mlxLoras.files.map((name) => ({ name, bytes: 1 })), folder: '/loras' })),
}))
const mlxLoras = vi.hoisted(() => ({ files: [] as string[] }))

// The Mac trainer (api/mlx-train.ts): what reaches it, in order. Its start
// refuses, so the run ends before any polling.
const train = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../../api/mlx-train', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  clearMacTrainSet: vi.fn(async () => { train.calls.push(['clear']) }),
  stageMacTrainPhoto: vi.fn(async (set: string, _bytes: unknown, caption: string) => { train.calls.push(['stage', set, caption]); return { staged: 'x.png' } }),
  startMacTraining: vi.fn(async (set: string, trigger: string, steps?: number) => {
    train.calls.push(['start', set, trigger, steps])
    throw new Error('Training a character on a Mac needs Z-Image Turbo. Install it in the Model Manager first.')
  }),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { useTrainReplaceStore } from '../../stores/trainReplaceStore'
import type { ClassifiedModel } from '../../api/comfyui'

const model = (name: string, type: ClassifiedModel['type'], extra: Partial<ClassifiedModel> = {}): ClassifiedModel =>
  ({ name, type, source: 'checkpoint', editImages: 0, mlxLoras: true, ...extra })
const ZIMAGE = model('MLX Z-Image Turbo 4-bit', 'zimage', { ownSampling: true })
const QWEN = model('MLX Qwen-Image 2.1 8-bit', 'qwenimage', { editImages: 10 })
const CHAR = 'char_davechar_zimage.safetensors'

function arrange(pick: ClassifiedModel, tab: 'use' | 'train' = 'use') {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], improvePrompt: false,
    cloudOp: null, utilityOp: null, removebg: false, mask: null, references: [], batchSources: [], source: null,
    mode: 'image', imageSubMode: 'text2img', transparentBackground: false, batchSize: 1, seed: 7, negativePrompt: '',
    imageModelList: [QWEN, ZIMAGE], videoModelList: [], selectedLoras: [], loraStrengths: {},
  } as never)
  const s = useCreateStore.getState()
  s.setImageModel(pick.name, pick.type)
  s.setIntent('character')
  s.setCharacterTab(tab)
  s.setPrompt('davechar on a beach at sunset')
}
const state = () => useCreateStore.getState()

beforeEach(() => {
  mlx.runs.length = 0
  train.calls.length = 0
  mlxLoras.files = [CHAR]
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['12345'], { type: 'image/png' }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Use character on the Mac', () => {
  it('runs the character LoRA on Z-Image through the second engine', async () => {
    arrange(ZIMAGE)
    state().toggleLora(CHAR)
    state().setSelectedCharacter({ id: `local:${CHAR}`, name: 'davechar', triggerWord: 'davechar', family: 'z-image' })
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(state().error).toBeNull()
    expect(mlx.runs).toHaveLength(1)
    expect(mlx.runs[0]).toMatchObject({ model: 'z-image-turbo-4bit', prompt: 'davechar on a beach at sunset' })
    expect(mlx.runs[0].loras).toEqual([expect.objectContaining({ name: CHAR })])
    expect(state().gallery[0]).toMatchObject({ intent: 'character' })
  })

  it('stops with the reason on a model the character was not trained for', async () => {
    arrange(QWEN)
    state().toggleLora(CHAR)
    state().setSelectedCharacter({ id: `local:${CHAR}`, name: 'davechar', triggerWord: 'davechar', family: 'z-image' })
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toHaveLength(0)
    expect(state().error).toMatch(/trained for Z.Image/)
  })

  it('trains on the Mac through the Mac trainer, never the image engine', async () => {
    arrange(ZIMAGE, 'train')
    // A new character: none of this name is on the Mac yet (C8 asks otherwise).
    mlxLoras.files = []
    const photo = (name: string) => ({ name, url: 'blob:x', blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })
    useCreateStore.setState({ triggerWord: 'davechar', trainImages: ['a', 'b', 'c', 'd'].map(photo) } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toHaveLength(0)
    expect(train.calls.map((c) => c[0])).toEqual(['clear', 'stage', 'stage', 'stage', 'stage', 'start'])
    expect(train.calls[1]).toEqual(['stage', 'davechar', 'davechar, a photo of davechar'])
    expect(train.calls[5]).toEqual(['start', 'davechar', 'davechar', state().trainSteps])
    // The refusal of the backend is what the user reads.
    expect(state().error).toBe('Training a character on a Mac needs Z-Image Turbo. Install it in the Model Manager first.')
    expect(state().isGenerating).toBe(false)
  })

  // C8: davechar is on the Mac already (char_davechar_zimage.safetensors).
  // A new run with that trigger would write over it at the end.
  it('C8: never trains over an existing character without a yes', async () => {
    arrange(ZIMAGE, 'train')
    const photo = (name: string) => ({ name, url: 'blob:x', blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })
    useCreateStore.setState({ triggerWord: 'davechar', trainImages: ['a', 'b', 'c', 'd'].map(photo) } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(train.calls).toEqual([])
    expect(state().error).toMatch(/“davechar” already exists/)
    expect(state().isGenerating).toBe(false)
  })

  it('C8: asks, and "Replace" goes on with the run', async () => {
    arrange(ZIMAGE, 'train')
    const photo = (name: string) => ({ name, url: 'blob:x', blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })
    useCreateStore.setState({ triggerWord: 'davechar', trainImages: ['a', 'b', 'c', 'd'].map(photo) } as never)
    const unmount = useTrainReplaceStore.getState().mount()
    const asked: (string | null)[] = []
    const stop = useTrainReplaceStore.subscribe((s) => {
      if (s.pending) { asked.push(s.pending); queueMicrotask(() => useTrainReplaceStore.getState().answer('replace')) }
    })
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    stop(); unmount()
    expect(asked).toEqual(['davechar'])
    expect(train.calls.map((c) => c[0])).toEqual(['clear', 'stage', 'stage', 'stage', 'stage', 'start'])
  })
})
