// @vitest-environment jsdom
/**
 * 3.0.9 P8 (Discord, 28.10.2026: "can the trainer do styles, concepts,
 * poses?"): the Train tab has a Style / concept mode next to Character. The
 * run is the character run with other captions, its own training set and a
 * `style_<name>_zimage` file that lands switched on in the Image tab's LoRA
 * stack, not on the character shelf.
 *
 * Runs through the Mac trainer, mocked: nothing is trained.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: (name: string) => name.startsWith('MLX '),
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn(() => 'z-image-turbo-4bit'),
  generateMlxImageDataUrl: vi.fn(async () => { throw new Error('no image in a training test') }),
}))
vi.mock('../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: false, installedModels: [] })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => false),
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))
vi.mock('../../api/mlx-loras', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  listMlxLoras: vi.fn(async () => ({ loras: [], folder: '/loras' })),
}))

const train = vi.hoisted(() => ({ calls: [] as unknown[][], finish: false }))
vi.mock('../../api/mlx-train', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getMacTrainStatus: vi.fn(async () => ({ engineReady: true, base: 'z-image-turbo-4bit', adapterReady: true, adapterBytes: 1, minRamGB: 24, memoryRefusal: null, running: false })),
  clearMacTrainSet: vi.fn(async (set: string) => { train.calls.push(['clear', set]) }),
  stageMacTrainPhoto: vi.fn(async (set: string, _bytes: unknown, caption: string) => { train.calls.push(['stage', set, caption]); return { staged: 'x.png' } }),
  startMacTraining: vi.fn(async (set: string, trigger: string, steps?: number, kind?: string) => {
    train.calls.push(['start', set, trigger, steps, kind])
    if (!train.finish) throw new Error('stopped here')
    return { status: 'started' }
  }),
  getMacTrainProgress: vi.fn(async () => ({
    job: 'j', status: 'complete', phase: 'done', percent: 100, step: 600, steps: 600,
    trigger: 'inkwash', error: null, output: '/loras/style_inkwash_zimage.safetensors', logs: [], running: false,
  })),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'

const photo = (name: string) => ({ name, url: 'blob:x', blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })
const state = () => useCreateStore.getState()

function arrange(kind: 'character' | 'style', trigger = true) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], selectedLoras: [], loraStrengths: {},
    imageModelList: [], videoModelList: [], trainKind: 'character', trainSteps: 1200,
  } as never)
  const s = state()
  s.setIntent('character')
  s.setCharacterTab('train')
  s.setTrainKind(kind)
  s.setTrainStyleTrigger(trigger)
  useCreateStore.setState({ triggerWord: 'inkwash', trainImages: ['a', 'b', 'c', 'd'].map(photo) } as never)
  s.setTrainCaption('a', 'a fox in a forest')
}

beforeEach(() => {
  train.calls.length = 0
  train.finish = false
})
afterEach(() => { vi.useRealTimers() })

describe('a style / concept training run', () => {
  it('captions by content, keeps its own set and tells the trainer it is a style', async () => {
    arrange('style')
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(train.calls[0]).toEqual(['clear', 'style-inkwash'])
    const stages = train.calls.filter((c) => c[0] === 'stage')
    expect(stages[0]).toEqual(['stage', 'style-inkwash', 'inkwash, a fox in a forest'])
    expect(stages[1]).toEqual(['stage', 'style-inkwash', 'inkwash'])
    for (const c of stages) expect(String(c[2])).not.toContain('a photo of')
    // The mode brought its own Standard (1600), not the character's 1200.
    expect(train.calls.at(-1)).toEqual(['start', 'style-inkwash', 'inkwash', 1600, 'style'])
  })

  it('without a trigger word the caption is only what is in the picture', async () => {
    arrange('style', false)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    const stages = train.calls.filter((c) => c[0] === 'stage')
    expect(stages[0][2]).toBe('a fox in a forest')
    expect(stages[1][2]).toBe('')
  })

  it('a character run is what it was', async () => {
    arrange('character')
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(train.calls[0]).toEqual(['clear', 'inkwash'])
    expect(train.calls[1]).toEqual(['stage', 'inkwash', 'inkwash, a photo of inkwash, a fox in a forest'])
    expect(train.calls.at(-1)).toEqual(['start', 'inkwash', 'inkwash', 1200, 'character'])
  })

  it('an empty name names what is missing for a style', async () => {
    arrange('style')
    useCreateStore.setState({ triggerWord: '' } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(train.calls).toHaveLength(0)
    expect(state().error).toMatch(/Give the style a name first/)
  })

  it('a finished style lands switched on in the Image tab, not on the character shelf', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    arrange('style')
    train.finish = true
    const { result } = renderHook(() => useCreate())
    const run = result.current.generate()
    await vi.advanceTimersByTimeAsync(4000)
    await run
    expect(state().intent()).toBe('image')
    expect(state().selectedLoras).toEqual([expect.objectContaining({ name: 'style_inkwash_zimage.safetensors' })])
    expect(state().error).toBeNull()
  })
})
