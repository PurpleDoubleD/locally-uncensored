// @vitest-environment jsdom
/**
 * Local Enhance Image (3.0.7), through the real generate path of useCreate:
 * the source and the upscale model go to ComfyUI as a core-node graph, and the
 * result lands in the gallery as an Enhance result at the size it has.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type Listener = (event: { type: string; data: Record<string, unknown> }) => void
const ws = vi.hoisted(() => ({ listener: null as Listener | null }))
const sent = vi.hoisted(() => ({ graphs: [] as Array<Record<string, { class_type: string; inputs: Record<string, unknown> }>> }))

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
vi.mock('../../api/comfyui-nodes', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getAllNodeInfo: vi.fn(async () => ({
    LoadImage: {}, ImageUpscaleWithModel: {}, SaveImage: {}, ImageScale: {},
    UpscaleModelLoader: { input: { required: { model_name: [['RealESRGAN_x4plus.safetensors']] } } },
    ImageScaleBy: { input: { required: { upscale_method: [['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos']] } } },
  })),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => true),
  submitWorkflow: vi.fn(async (g: never) => { sent.graphs.push(g); return 'p1' }),
  isPromptQueued: vi.fn(async () => true),
  listedLoras: vi.fn(async () => { throw new Error('the LoRA stack has no say in an Enhance run') }),
  getHistory: vi.fn(async () => ({
    status: { status_str: 'success', completed: true, messages: [] },
    outputs: { '5': { images: [{ filename: 'locally_uncensored_enhanced_00001_.png', subfolder: '', type: 'output' }] } },
  })),
}))
vi.mock('../../api/comfyui-ws', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  CLIENT_ID: 'lu-test',
  comfyWS: {
    connect: vi.fn(async () => {}),
    mark: () => 0,
    onPreview: () => () => {},
    on: (l: Listener) => { ws.listener = l; return () => { ws.listener = null } },
  },
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'

const UPSCALER = 'RealESRGAN_x4plus.safetensors'

beforeEach(() => {
  ws.listener = null
  sent.graphs = []
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [],
    improvePrompt: false, cloudOp: null, utilityOp: null, mask: null, references: [],
    selectedLoras: [{ name: 'style.safetensors', strength: 0.8 }], hiresFixEnabled: false, transparentBackground: false, seed: 42,
    imageModel: 'sd_turbo.safetensors', imageModelList: [{ name: 'sd_turbo.safetensors', type: 'sd15' }],
    upscaleModelList: [UPSCALER], upscaleFactor: 2, prompt: 'left over from the Image tab',
  } as never)
  const s = useCreateStore.getState()
  s.setIntent('upscale')
  s.setSource({ filename: 'photo.png', url: 'data:image/png;base64,AA', width: 640, height: 480 } as never)
})

async function run() {
  const { result } = renderHook(() => useCreate())
  const done = result.current.generate()
  await waitFor(() => {
    const st = useCreateStore.getState()
    if (st.error) throw new Error(`run ended: ${st.error}`)
    expect(ws.listener).not.toBeNull()
  })
  ws.listener!({ type: 'executing', data: { node: '3', prompt_id: 'p1' } })
  expect(useCreateStore.getState().progressText).toMatch(/^Enhancing the image\.\.\. \d+s$/)
  ws.listener!({ type: 'progress', data: { value: 2, max: 6, prompt_id: 'p1' } })
  expect(useCreateStore.getState().progressText).toMatch(/^Enhancing part 2 of 6\.\.\. \d+s$/)
  ws.listener!({ type: 'execution_complete', data: { prompt_id: 'p1' } })
  await done
}

describe('a local Enhance', () => {
  it('sends the source through the upscale model, scaled to 2x', async () => {
    await run()
    const [g] = sent.graphs
    const byClass = (c: string) => Object.values(g).find((n) => n.class_type === c)
    expect(byClass('LoadImage')?.inputs.image).toBe('photo.png')
    expect(byClass('UpscaleModelLoader')?.inputs.model_name).toBe(UPSCALER)
    expect(byClass('ImageScaleBy')?.inputs.scale_by).toBe(0.5)
    expect(Object.values(g).some((n) => /Checkpoint|KSampler|Lora/.test(n.class_type))).toBe(false)
  }, 15_000)

  it('the gallery holds an Enhance result at its real size, without the old prompt', async () => {
    await run()
    const [made] = useCreateStore.getState().gallery
    expect(made.intent).toBe('upscale')
    expect(made.toolModel).toBe('RealESRGAN_x4plus')
    expect([made.width, made.height]).toEqual([1280, 960])
    expect(made.prompt).toBe('')
    expect(made.filename).toBe('locally_uncensored_enhanced_00001_.png')
  }, 15_000)

  it('4x goes straight through a 4x model', async () => {
    useCreateStore.getState().setUpscaleFactor(4)
    await run()
    expect(Object.values(sent.graphs[0]).map((n) => n.class_type)).not.toContain('ImageScaleBy')
    expect(useCreateStore.getState().gallery[0].width).toBe(2560)
  }, 15_000)

  it('without an upscale model nothing is sent, and the line points at the download', async () => {
    useCreateStore.setState({ upscaleModelList: [] })
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(sent.graphs).toEqual([])
    expect(useCreateStore.getState().error).toMatch(/No upscale model installed\. Use Download & install above/)
  })

  it('a result too large to save is refused before ComfyUI is asked', async () => {
    useCreateStore.getState().setUpscaleFactor(4)
    useCreateStore.getState().setSource({ filename: 'big.png', url: 'data:image/png;base64,AA', width: 3000, height: 2000 } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(sent.graphs).toEqual([])
    expect(useCreateStore.getState().error).toMatch(/Try 2x or a smaller image/)
  })
})
