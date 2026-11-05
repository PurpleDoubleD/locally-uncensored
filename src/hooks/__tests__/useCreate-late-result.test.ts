// @vitest-environment jsdom
/**
 * I1 on the 12 GB box (30.10.2026): a second Z-Image bf16 run took 22 min.
 * Its VAE decode went through shared memory and ComfyUI left HTTP unanswered
 * for all of it; LU called the run stalled at 20 min and the four finished
 * pictures never reached the gallery. Through the real generate path, with
 * ComfyUI simulated at the HTTP level (so the test reads the same before and
 * after the fix):
 *  - a ComfyUI that does not answer is busy, not stalled;
 *  - a run LU did give up on still lands in the gallery when ComfyUI
 *    finishes it later, and its prompt is not taken off ComfyUI's queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type Listener = (event: { type: string; data: Record<string, unknown> }) => void
const ws = vi.hoisted(() => ({ listener: null as Listener | null }))

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
  cutoutDownloadLine: vi.fn(async () => null),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => true),
  submitWorkflow: vi.fn(async () => 'p1'),
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
import { useSettingsStore } from '../../stores/settingsStore'

const MODEL = 'sd_turbo.safetensors'
const MIN = 60_000

/** What the simulated ComfyUI does with /queue and /history. */
type Comfy = 'busy' | 'lost' | 'done'
const comfy = { mode: 'busy' as Comfy, queueDeletes: 0 }

const DONE = {
  p1: {
    status: { status_str: 'success', completed: true, messages: [] },
    outputs: { '3': { images: [{ filename: 'late_00001_.png', subfolder: '', type: 'output' }] } },
  },
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200 }))
  if (url.includes('/queue')) {
    if (init?.method === 'POST') { comfy.queueDeletes += 1; return json({}) }
    // A ComfyUI deep in a VAE decode through shared memory: no answer.
    if (comfy.mode === 'busy') return Promise.reject(new TypeError('timed out'))
    return json({ queue_running: [], queue_pending: [] })
  }
  if (url.includes('/history/')) {
    if (comfy.mode === 'busy') return Promise.reject(new TypeError('timed out'))
    return json(comfy.mode === 'done' ? DONE : {})
  }
  return json({})
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  ws.listener = null
  comfy.mode = 'busy'
  comfy.queueDeletes = 0
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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function startAndGoSilent() {
  const { result } = renderHook(() => useCreate())
  const done = result.current.generate()
  await waitFor(() => {
    const st = useCreateStore.getState()
    if (st.error) throw new Error(`run ended: ${st.error}`)
    expect(ws.listener).not.toBeNull()
  })
  return { done }
}

async function silence(minutes: number) {
  for (let t = 0; t < minutes * MIN; t += 15_000) {
    await vi.advanceTimersByTimeAsync(15_000)
  }
}

const lateFiles = () => useCreateStore.getState().gallery.map((g) => g.filename)

describe('a ComfyUI too busy to answer (I1, 22 min Z-Image on 12 GB)', () => {
  it('is not called stalled at the 20 minute limit, and its pictures arrive when it answers again', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: 20 } }))
    const { done } = await startAndGoSilent()
    await silence(23)
    expect(useCreateStore.getState().error).toBeNull()
    expect(useCreateStore.getState().isGenerating).toBe(true)
    // The decode ends at 22-23 min and ComfyUI answers again.
    comfy.mode = 'done'
    await silence(0.5)
    await done
    expect(lateFiles()).toEqual(['late_00001_.png'])
    expect(useCreateStore.getState().error).toBeNull()
  }, 60_000)
})

describe('a run LU gave up on', () => {
  it('still lands in the gallery when ComfyUI finishes it later, and its prompt is left alone', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: 2 } }))
    comfy.mode = 'lost'
    const { done } = await startAndGoSilent()
    await silence(3)
    await done
    const error = useCreateStore.getState().error ?? ''
    expect(error).toMatch(/Generation stalled: no progress from ComfyUI for 2 minutes\./)
    expect(error).toMatch(/lands in your gallery/)
    expect(comfy.queueDeletes).toBe(0)
    expect(lateFiles()).toEqual([])
    // ComfyUI finishes it after all.
    comfy.mode = 'done'
    await silence(1)
    expect(lateFiles()).toEqual(['late_00001_.png'])
    expect(useCreateStore.getState().error).toBeNull()
  }, 60_000)
})
