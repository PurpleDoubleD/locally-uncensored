// @vitest-environment jsdom
/**
 * W32 follow-up (Zentrale, 15.11.2026): in the first real run (test build "LU
 * w32", 11:23Z) the app stood about 10 minutes after batch 2 of 3 without
 * sending batch 3, while ComfyUI had finished both and its queue was empty.
 *
 * How a batch is known to be done: the WebSocket event execution_complete for
 * its prompt_id, and a heartbeat every 10 s that reads /history/<id>. A missed
 * event alone is caught by the heartbeat. But the heartbeat asked ComfyUI's
 * /system_stats FIRST, and that check had no limit of its own (the proxy's
 * default is five minutes; a failed proxy call then tries a direct fetch), so
 * one check that did not come back held the history read behind it: the batch
 * was done in ComfyUI and nobody looked. The check before each batch had the
 * same unbounded wait.
 *
 * Now the history is read first, on its own limit; the checks have a limit
 * of 15 s; ticks do not stack; a ComfyUI that does not answer within the
 * limit is said on the line, one that refuses ends the run with a message.
 *
 * Reproduced here with the completion event missed and the unbounded check
 * never answering. Before the fix: batch 1 never ends (red). After: green.
 *
 * Run: npx vitest run src/hooks/__tests__/useCreate-a-missed-completion-does-not-hold-the-batches.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({
  builds: [] as Record<string, unknown>[],
  lanes: [] as Record<string, unknown>[],
  submits: 0,
  freed: 0,
  onBuild: null as null | (() => void),
  historyGone: false,
  mode: 'hangs' as 'hangs' | 'healthy' | 'gone',
  calls: 0,
}))
/** The connection check. 'hangs': the first check answers, every later one
 *  without a limit of its own never comes back (the proxy's five minutes);
 *  one asked with a limit answers within it. 'gone': refused at once after
 *  the first. */
function probe(limitMs?: number): Promise<boolean> {
  seen.calls++
  if (seen.calls === 1 || seen.mode === 'healthy') return Promise.resolve(true)
  if (seen.mode === 'gone') return Promise.resolve(false)
  return limitMs ? Promise.resolve(true) : new Promise<boolean>(() => {})
}

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
  checkComfyConnection: vi.fn((limitMs?: number) => probe(limitMs)),
  listedLoras: vi.fn(async () => ['char_mira_zimage.safetensors', 'film_grain.safetensors']),
  uploadMediaFile: vi.fn(async (_b: Blob, name: string) => `up_${name}`),
  freeMemory: vi.fn(async () => { seen.freed++ }),
  submitWorkflow: vi.fn(async () => `p${++seen.submits}`),
  getHistory: vi.fn(async (id: string) => seen.historyGone ? null : ({
    status: { status_str: 'success', completed: true },
    outputs: { '9': { images: [{ filename: isVideoRun(id) ? `clip_${id}.mp4` : `img_${id}.png`, subfolder: '', type: 'output' }] } },
  })),
}))
// A run's file is a clip when its build was a video one.
const videoRuns = vi.hoisted(() => new Set<string>())
function isVideoRun(id: string) { return videoRuns.has(id) }
vi.mock('../../api/comfyui-ws', () => ({
  CLIENT_ID: 'lu-test',
  comfyWS: {
    connect: vi.fn(async () => {}),
    mark: () => 0,
    onPreview: () => () => {},
    // W32 follow-up: the completion event never arrives (missed).
    on: () => () => {},
  },
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))
vi.mock('../../api/dynamic-workflow', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkVideoOutputCapability: vi.fn(async () => ({ webpOnly: false, mp4Capable: true })),
  buildDynamicWorkflow: vi.fn(async (params: Record<string, unknown>) => {
    seen.builds.push(params)
    seen.onBuild?.()
    if (typeof params.frames === 'number') videoRuns.add(`p${seen.submits + 1}`)
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
  buildLocalOpWorkflow: vi.fn(async (params: Record<string, unknown>) => {
    seen.lanes.push(params)
    videoRuns.add(`p${seen.submits + 1}`)
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
}))
vi.mock('../../components/create/experimental/galleryUrl', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchGalleryItemBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))
vi.mock('../../components/create/experimental/loadImage', () => ({
  loadImageRef: vi.fn(async () => ({ filename: 'char-start.png', url: 'blob:start', width: 1024, height: 576 })),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'

const QWEN = 'qwen_image_2512_fp8_e4m3fn.safetensors'
const listed = (...names: string[]) => names.map((name) => ({ name, type: classifyModel(name) }))

function arrange() {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    hiresFixEnabled: false, transparentBackground: false, seed: 7, batchSources: [], videoShots: [],
    imageModel: QWEN, imageModelType: classifyModel(QWEN), imageModelList: listed(QWEN),
    videoModelList: [], lipsyncModelList: [], motionModelList: [], localOpModel: '',
    selectedLoras: [], loraStrengths: {}, selectedCharacter: null,
  } as never)
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setBatchSize(3)
  useCreateStore.getState().setBatchPacket(2)
  useCreateStore.getState().setPrompt('a lighthouse at dusk')
}

/** Runs Create on fake time, at most `ms`; true when it ended. */
async function createFor(ms: number): Promise<boolean> {
  const { result } = renderHook(() => useCreate())
  let ended = false
  void result.current.generate().then(() => { ended = true })
  for (let t = 0; t < ms && !ended; t += 1000) await vi.advanceTimersByTimeAsync(1000)
  return ended
}

beforeEach(() => {
  vi.useFakeTimers()
  seen.builds.length = 0
  seen.submits = 0
  seen.calls = 0
  seen.historyGone = false
  seen.onBuild = null
  videoRuns.clear()
})
afterEach(() => { vi.useRealTimers() })

describe('a missed completion event does not hold the batches', () => {
  it('the event is missed and the check never answers: the heartbeat still finds both batches done (red before the fix)', async () => {
    seen.mode = 'hangs'
    arrange()
    expect(await createFor(120_000)).toBe(true)
    expect(seen.builds.map((b) => b.batchSize)).toEqual([2, 1])
    expect(useCreateStore.getState().gallery).toHaveLength(2)
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('the event is missed on a healthy ComfyUI: done from /history within a heartbeat or two', async () => {
    seen.mode = 'healthy'
    arrange()
    expect(await createFor(60_000)).toBe(true)
    expect(seen.builds.map((b) => b.batchSize)).toEqual([2, 1])
  })

  it('NEGATIVE CONTROL: a ComfyUI that is gone ends the run with a message, the rest is not started', async () => {
    seen.mode = 'gone'
    seen.historyGone = true
    arrange()
    expect(await createFor(120_000)).toBe(true)
    expect(seen.builds.map((b) => b.batchSize)).toEqual([2])
    expect(useCreateStore.getState().error).toMatch(/ComfyUI stopped responding/)
  })
})
