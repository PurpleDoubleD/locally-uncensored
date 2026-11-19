// @vitest-environment jsdom
/**
 * A41 / GitHub #260: Normal training on a 10 GB card ended with "switch to
 * Low VRAM". The run now switches itself; the panel names the switch for
 * the whole run and keeps Low VRAM picked for the next one.
 *
 * The trainer API is mocked: nothing is trained.
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

const run = vi.hoisted(() => ({ notice: 'This card has 10 GB and Normal training needs 11 GB, so this run uses Low VRAM: 512 px, slower steps, slightly softer detail.', started: [] as unknown[][] }))
vi.mock('../../api/trainer', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  clearTrainingSet: vi.fn(async () => {}),
  stageTrainingImage: vi.fn(async () => ({ staged: 'x.png' })),
  startCharacterTraining: vi.fn(async (...a: unknown[]) => { run.started.push(a); return { status: 'running' } }),
  characterTrainingStatus: vi.fn(async () => ({ status: 'complete', phase: 'done', notice: run.notice, logs: [], step: 0, totalSteps: 0 })),
  listLocalCharacters: vi.fn(async () => []),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'

const photo = (name: string) => ({ name, url: 'blob:x', blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })
const state = () => useCreateStore.getState()

beforeEach(() => {
  run.started.length = 0
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], selectedLoras: [], loraStrengths: {},
    imageModelList: [], videoModelList: [], trainKind: 'character', trainSteps: 1200, trainVramPreset: 'standard', trainNotice: null,
  } as never)
  state().setIntent('character')
  state().setCharacterTab('train')
  useCreateStore.setState({ triggerWord: 'mira', trainImages: ['a', 'b', 'c', 'd'].map(photo) } as never)
})
afterEach(() => { vi.useRealTimers() })

describe('a Normal run the card is too small for', () => {
  it('shows the switch and keeps Low VRAM picked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { result } = renderHook(() => useCreate())
    const go = result.current.generate()
    await vi.advanceTimersByTimeAsync(4000)
    await go
    expect(run.started.length).toBe(1)
    expect(state().trainNotice).toMatch(/uses Low VRAM/)
    expect(state().trainVramPreset).toBe('low-vram')
    expect(state().error).toBeNull()
  })

  it('a run without a switch leaves no notice behind', async () => {
    run.notice = ''
    useCreateStore.setState({ trainNotice: 'old sentence' } as never)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { result } = renderHook(() => useCreate())
    const go = result.current.generate()
    await vi.advanceTimersByTimeAsync(4000)
    await go
    expect(state().trainNotice).toBeNull()
    expect(state().trainVramPreset).toBe('standard')
  })
})
