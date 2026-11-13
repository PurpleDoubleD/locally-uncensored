// @vitest-environment jsdom
/**
 * B46 (3.0.9): the Edit strength of a local Qwen edit, through the real
 * generate path of useCreate up to the builder. What the builder does with it
 * is api/__tests__/qwen-edit-strength.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

type Built = { prompt: string; inputImage?: string; denoise?: number; editStrength?: number }
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
    seen.built.push({ prompt: params.prompt, inputImage: params.inputImage, denoise: params.denoise, editStrength: params.editStrength })
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
import { QWEN21_OFFICIAL_MODEL } from '../../api/__tests__/qwen21-weights'

const image = (filename: string) => ({ filename, url: `blob:${filename}`, width: 1024, height: 1024 })

function setup(model: string) {
  seen.order.length = 0
  seen.built.length = 0
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [],
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42,
    imageModel: model, imageModelList: [{ name: model, type: classifyModel(model) }],
    denoise: 0.7, editStrength: 1,
  } as never)
  const s = useCreateStore.getState()
  s.setIntent('edit')
  s.setPrompt('make the jacket red')
  useCreateStore.setState({ source: image('jacket.png') } as never)
}

async function run() {
  const { result } = renderHook(() => useCreate())
  await result.current.generate()
}

describe('B46: the Edit strength of a local Qwen edit reaches the builder', () => {
  beforeEach(() => setup(QWEN21_OFFICIAL_MODEL))

  it('0.4 set on the slider is sent as editStrength', async () => {
    useCreateStore.getState().setEditStrength(0.4)
    await run()
    expect(seen.built).toHaveLength(1)
    expect(seen.built[0]).toMatchObject({ inputImage: 'jacket.png', editStrength: 0.4 })
  })

  it('COUNTER-CHECK: at 1 (the default) nothing is sent, the run is the one of today', async () => {
    await run()
    expect(seen.built[0].editStrength).toBeUndefined()
  })

  it('COUNTER-CHECK: a new picture never carries it', async () => {
    useCreateStore.getState().setEditStrength(0.4)
    useCreateStore.getState().setIntent('image')
    await run()
    expect(seen.built[0].editStrength).toBeUndefined()
  })
})
