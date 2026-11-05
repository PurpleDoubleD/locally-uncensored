// @vitest-environment jsdom
/**
 * The box, 04.10.2026, the first cutout after the node pack install: the node
 * fetched its 885 MB model for 160 s inside the run and the Stage said
 * "Queued... Ns". And the result read "512×512 · seed 697334996 · sd turbo".
 * Through the real generate path of useCreate: the wait names the download
 * when the model is not on the drive, and the result records the cutout model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type Listener = (event: { type: string; data: Record<string, unknown> }) => void
const ws = vi.hoisted(() => ({ listener: null as Listener | null }))
const disk = vi.hoisted(() => ({ modelThere: false }))

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
vi.mock('../../api/cutout-model', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  cutoutDownloadLine: vi.fn(async () => (disk.modelThere ? null : 'Downloading the cutout model (885 MB), first run only...')),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => true),
  submitWorkflow: vi.fn(async () => 'p1'),
  isPromptQueued: vi.fn(async () => true),
  getHistory: vi.fn(async () => ({
    status: { status_str: 'success', completed: true, messages: [] },
    outputs: { '3': { images: [{ filename: 'cut_00001_.png', subfolder: '', type: 'output' }] } },
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
vi.mock('../../api/dynamic-workflow', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  buildDynamicWorkflow: vi.fn(async () => ({
    '1': { class_type: 'LoadImage', inputs: { image: 'woman-b.png' } },
    '2': { class_type: 'RMBG', inputs: { image: ['1', 0], model: 'RMBG-2.0' } },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
  })),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'

const MODEL = 'sd_turbo.safetensors'
const line = () => useCreateStore.getState().progressText

beforeEach(() => {
  ws.listener = null
  disk.modelThere = false
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [],
    improvePrompt: false, cloudOp: null, utilityOp: null, mask: null, references: [],
    selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42,
    imageModel: MODEL, imageModelList: [{ name: MODEL, type: 'sd15' }],
    caps: { rmbg: true },
  } as never)
  const s = useCreateStore.getState()
  s.setIntent('removebg')
  s.setSource({ filename: 'woman-b.png', url: 'data:image/png;base64,AA', width: 512, height: 512 } as never)
})

async function runUntilNode() {
  const { result } = renderHook(() => useCreate())
  const done = result.current.generate()
  await waitFor(() => {
    const st = useCreateStore.getState()
    if (st.error) throw new Error(`run ended: ${st.error}`)
    expect(ws.listener).not.toBeNull()
  })
  expect(line()).toMatch(/^Queued\.\.\. \d+s$/)
  ws.listener!({ type: 'executing', data: { node: '2', prompt_id: 'p1' } })
  return { done }
}

describe('a local cutout', () => {
  it('first run, model not on the drive: the wait says the download and its size', async () => {
    const { done } = await runUntilNode()
    expect(line()).toMatch(/^Downloading the cutout model \(885 MB\), first run only\.\.\. \d+s$/)
    ws.listener!({ type: 'execution_complete', data: { prompt_id: 'p1' } })
    await done
  }, 15_000)

  it('model on the drive: the wait says what the node does, not "Queued"', async () => {
    disk.modelThere = true
    const { done } = await runUntilNode()
    expect(line()).toMatch(/^Removing the background\.\.\. \d+s$/)
    ws.listener!({ type: 'execution_complete', data: { prompt_id: 'p1' } })
    await done
  }, 15_000)

  it('the result records the cutout model and that it is a cutout', async () => {
    const { done } = await runUntilNode()
    ws.listener!({ type: 'execution_complete', data: { prompt_id: 'p1' } })
    await done
    const [made] = useCreateStore.getState().gallery
    expect(made.filename).toBe('cut_00001_.png')
    expect(made.toolModel).toBe('RMBG-2.0')
    expect(made.intent).toBe('removebg')
  }, 15_000)
})
