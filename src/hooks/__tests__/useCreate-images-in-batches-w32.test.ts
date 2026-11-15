// @vitest-environment jsdom
/**
 * W32 (Discord, 15.11.2026): "Images per run" and "Batch size" were one
 * field, and a local run put every image into one ComfyUI batch, more than a
 * small card holds. Now the chip next to Create says how many images, Batch
 * size in Advanced settings how many of them one ComfyUI run makes, and LU
 * runs the batches one after another, each with its own seed, into the same
 * gallery. Stop ends the batches still to come.
 *
 * Driven through the real generate path of useCreate with ComfyUI played (the
 * harness of useCreate-character-chain.test.ts).
 *
 * Run: npx vitest run src/hooks/__tests__/useCreate-images-in-batches-w32.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({
  builds: [] as Record<string, unknown>[],
  lanes: [] as Record<string, unknown>[],
  submits: 0,
  freed: 0,
  onBuild: null as null | (() => void),
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
  listedLoras: vi.fn(async () => ['char_mira_zimage.safetensors', 'film_grain.safetensors']),
  uploadMediaFile: vi.fn(async (_b: Blob, name: string) => `up_${name}`),
  freeMemory: vi.fn(async () => { seen.freed++ }),
  submitWorkflow: vi.fn(async () => `p${++seen.submits}`),
  getHistory: vi.fn(async (id: string) => ({
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
    on: (cb: (e: unknown) => void) => {
      const id = `p${seen.submits}`
      setTimeout(() => cb({ type: 'execution_complete', data: { prompt_id: id } }), 0)
      return () => {}
    },
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
import { batchPlan, batchSeed } from '../../lib/render/image-count'

const QWEN = 'qwen_image_2512_fp8_e4m3fn.safetensors'
const listed = (...names: string[]) => names.map((name) => ({ name, type: classifyModel(name) }))
const lines: string[] = []
useCreateStore.subscribe((s, prev) => { if (s.progressText && s.progressText !== prev.progressText) lines.push(s.progressText) })

function arrange(images: number, packet: number, seed = 42) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    hiresFixEnabled: false, transparentBackground: false, seed, batchSources: [], videoShots: [],
    imageModel: QWEN, imageModelType: classifyModel(QWEN), imageModelList: listed(QWEN),
    videoModelList: [], lipsyncModelList: [], motionModelList: [], localOpModel: '',
    selectedLoras: [], loraStrengths: {}, selectedCharacter: null,
  } as never)
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setBatchSize(images)
  useCreateStore.getState().setBatchPacket(packet)
  useCreateStore.getState().setPrompt('a lighthouse at dusk')
}

beforeEach(() => {
  seen.builds.length = 0
  seen.submits = 0
  seen.onBuild = null
  videoRuns.clear()
  lines.length = 0
})

describe('the plan', () => {
  it('5 images in batches of 2 are 2, 2, 1; the default is one batch', () => {
    expect(batchPlan(5, 2)).toEqual([2, 2, 1])
    expect(batchPlan(5, 8)).toEqual([5])
    expect(batchPlan(4, 4)).toEqual([4])
    expect(batchPlan(3, 1)).toEqual([1, 1, 1])
  })
  it('a fixed seed moves on by the images before, a random one stays random', () => {
    expect([0, 2, 4].map((b) => batchSeed(42, b))).toEqual([42, 44, 46])
    expect(batchSeed(-1, 4)).toBe(-1)
  })
  it('NEGATIVE CONTROL: an existing user keeps one batch (the stored value has no Batch size yet)', () => {
    expect(useCreateStore.getState().batchPacket).toBe(8)
  })
})

describe('Create runs the batches one after another', () => {
  it('5 images in batches of 2: three ComfyUI runs, own seeds, all in the gallery', async () => {
    arrange(5, 2)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.builds.map((b) => b.batchSize)).toEqual([2, 2, 1])
    expect(seen.builds.map((b) => b.seed)).toEqual([42, 44, 46])
    expect(seen.submits).toBe(3)
    expect(useCreateStore.getState().gallery).toHaveLength(3)
    expect(useCreateStore.getState().error).toBeNull()
    expect(lines.some((l) => l.startsWith('Batch 2 of 3'))).toBe(true)
    expect(useCreateStore.getState().isGenerating).toBe(false)
    // The chip keeps its number; only the runs were split.
    expect(useCreateStore.getState().batchSize).toBe(5)
  })

  it('Stop during the second batch ends the third', async () => {
    arrange(5, 2)
    const { result } = renderHook(() => useCreate())
    seen.onBuild = () => { if (seen.builds.length === 2) void result.current.cancel() }
    await result.current.generate()
    expect(seen.builds.map((b) => b.batchSize)).toEqual([2, 2])
  })

  it('NEGATIVE CONTROL: with the default Batch size it is one run of 5, as before', async () => {
    arrange(5, 8)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.builds.map((b) => b.batchSize)).toEqual([5])
    expect(seen.submits).toBe(1)
  })
})
