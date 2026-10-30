// @vitest-environment jsdom
/**
 * D27: Settings has had "Image generation timeout" (1 to 480 min) since
 * 2.4.7, but the Create tab's stall watchdog ignored it and always waited a
 * fixed 20 min (60 for video). Through the real generate path of useCreate:
 * ComfyUI goes silent, the prompt has left its queue, and the run must be
 * called stalled after the minutes the user set, not after 20.
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
  isPromptQueued: vi.fn(async () => false),
  getHistory: vi.fn(async () => null),
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
import { renderStallLimitMs, renderStallMessage } from '../../lib/tool-timeout'

const MODEL = 'sd_turbo.safetensors'
const MIN = 60_000

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] })
  ws.listener = null
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
  // Wrapped, or awaiting this helper would wait for the whole run.
  return { done }
}

/** Let `minutes` of silence pass in watchdog-sized steps. */
async function silence(minutes: number) {
  for (let t = 0; t < minutes * MIN; t += 15_000) {
    await vi.advanceTimersByTimeAsync(15_000)
  }
}

describe('the Create stall watchdog', () => {
  it('a lower setting (2 min) ends a silent run after 2 minutes, not 20', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: 2 } }))
    const { done } = await startAndGoSilent()
    await silence(3)
    expect(useCreateStore.getState().error ?? '').toMatch(/Generation stalled: no progress from ComfyUI for 2 minutes/)
    await done
  }, 30_000)

  it('a higher setting (45 min) keeps a silent run alive past the old 20 minutes', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: 45 } }))
    const { done } = await startAndGoSilent()
    await silence(25)
    expect(useCreateStore.getState().error).toBeNull()
    expect(useCreateStore.getState().isGenerating).toBe(true)
    await silence(21)
    expect(useCreateStore.getState().error ?? '').toMatch(/for 45 minutes/)
    await done
  }, 60_000)
})

describe('a run ComfyUI still holds (d308-a)', () => {
  it('is not called stalled at a 1 minute limit while it sits in the queue, and the message says "1 minute"', async () => {
    const comfy = await import('../../api/comfyui')
    const queued = vi.mocked(comfy.isPromptQueued)
    // A long VAE decode on the Windows box: no event for 100 s, the prompt
    // still running in ComfyUI. At a 1 minute limit it was dropped.
    queued.mockResolvedValue(true)
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, imageGenTimeoutMinutes: 1 } }))
    const { done } = await startAndGoSilent()
    await silence(4)
    expect(useCreateStore.getState().error).toBeNull()
    expect(useCreateStore.getState().isGenerating).toBe(true)
    // Then ComfyUI loses it: gone from the queue, no event, no history.
    queued.mockResolvedValue(false)
    await silence(2)
    expect(useCreateStore.getState().error ?? '').toMatch(/Generation stalled: no progress from ComfyUI for 1 minute\./)
    await done
    queued.mockResolvedValue(false)
  }, 60_000)
})

describe('renderStallMessage', () => {
  it('says minute for one and minutes for more', () => {
    expect(renderStallMessage(MIN)).toBe('Generation stalled: no progress from ComfyUI for 1 minute.')
    expect(renderStallMessage(20 * MIN)).toBe('Generation stalled: no progress from ComfyUI for 20 minutes.')
  })
})

describe('renderStallLimitMs', () => {
  it('defaults stay 20 min for images and 60 for video', () => {
    expect(renderStallLimitMs('image', {})).toBe(20 * MIN)
    expect(renderStallLimitMs('video', {})).toBe(60 * MIN)
  })
  it('follows the settings', () => {
    expect(renderStallLimitMs('image', { imageGenTimeoutMinutes: 90 })).toBe(90 * MIN)
    expect(renderStallLimitMs('video', { videoGenTimeoutMinutes: 240 })).toBe(240 * MIN)
  })
})
