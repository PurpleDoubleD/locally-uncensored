// @vitest-environment jsdom
/**
 * GH #161 (2026-10-12, Windows, 3.0.6): "Use character" with a Z Image
 * character on a Qwen image model rendered an image without the character.
 * The run left the LoRA out with a progress line that was gone a second later.
 *
 * Driven through the real generate path of useCreate: on Qwen the run stops
 * before it builds, with the reason. On Z Image it builds and submits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({ order: [] as string[] }))

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
  getLoraModels: vi.fn(async () => ['char_mira_zimage.safetensors']),
  submitWorkflow: vi.fn(async () => { seen.order.push('submit'); throw new Error('stop here') }),
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
  buildDynamicWorkflow: vi.fn(async () => {
    seen.order.push('build')
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'

const CHAR = 'char_mira_zimage.safetensors'
const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const Z_IMAGE = 'z_image_bf16.safetensors'
const listed = (...names: string[]) => names.map((name) => ({ name, type: classifyModel(name) }))

function useCharacterOn(model: string, installed: string[], id = `local:${CHAR}`) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    hiresFixEnabled: false, transparentBackground: false, seed: 42, batchSources: [],
    imageModel: model, imageModelType: classifyModel(model), imageModelList: listed(...installed),
  } as never)
  useCreateStore.getState().setIntent('character')
  useCreateStore.setState({
    characterTab: 'use',
    selectedLoras: [{ name: CHAR, strength: 1 }],
    selectedCharacter: { id, name: 'mira', triggerWord: 'mira', family: 'z-image' },
  } as never)
  useCreateStore.getState().setPrompt('mira at the beach')
}

beforeEach(() => { seen.order.length = 0 })

describe('Use character, the run', () => {
  it('on a Qwen model it does not start and says which model to pick', async () => {
    useCharacterOn(QWEN, [QWEN, Z_IMAGE])
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.order).toEqual([])
    expect(useCreateStore.getState().error).toBe('This character was trained for Z Image. Pick a Z Image model to use it.')
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('without any Z Image model it says that none is installed', async () => {
    useCharacterOn(QWEN, [QWEN])
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.order).toEqual([])
    expect(useCreateStore.getState().error)
      .toBe('This character was trained for Z Image, and no Z Image model is installed. Get one in the Model Manager to use it.')
  })

  it('on a Z Image model it builds and submits', async () => {
    useCharacterOn(Z_IMAGE, [QWEN, Z_IMAGE])
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.order).toEqual(['build', 'submit'])
  })

  it('a Mac character (mlx: id) on a Qwen model stops the same way', async () => {
    useCharacterOn(QWEN, [QWEN, Z_IMAGE], `mlx:${CHAR}`)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.order).toEqual([])
    expect(useCreateStore.getState().error).toBe('This character was trained for Z Image. Pick a Z Image model to use it.')
  })
})
