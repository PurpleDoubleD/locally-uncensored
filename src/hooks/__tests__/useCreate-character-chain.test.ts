// @vitest-environment jsdom
/**
 * Characters everywhere (3.0.7): with a character on the chip, every video
 * lane runs the one chain. Step 1 renders the character's start image on the
 * normal image path (Z Image, the character's LoRA, its trigger word), step 2
 * runs the video from it. Image and Edit carry the LoRA in the run itself.
 *
 * Driven through the real generate path of useCreate with ComfyUI played:
 * the builders record what each run asked for, the socket answers "done" at
 * once and the history hands back one file per run.
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
import { CHAIN_STEP_IMAGE, CHAIN_STEP_VIDEO } from '../../lib/characters'
import { EDIT_MASK_NO_CHARACTER } from '../../lib/character-run'
import type { CreateIntent } from '../../stores/createStore'

const CHAR = 'char_mira_zimage.safetensors'
const Z_IMAGE = 'z_image_bf16.safetensors'
const QWEN = 'qwen_image_2512_fp8_e4m3fn.safetensors'
const WAN_TI2V = 'wan2.2_ti2v_5B_fp16.safetensors'
const WAN_T2V = 'wan2.1_t2v_1.3B_fp16.safetensors'
const LTX25 = 'ltx-2.5-distilled.safetensors'
const H3 = 'minimax_h3_bf16.safetensors'
const S2V = 'wan2.2_s2v_14B_fp8_scaled.safetensors'
const ANIMATE = 'wan2.2_animate_14B_bf16.safetensors'
const listed = (...names: string[]) => names.map((name) => ({ name, type: classifyModel(name) }))
const MIRA = { id: `local:${CHAR}`, name: 'mira', triggerWord: 'mira', family: 'zimage' }
const SOURCE = { filename: 'mine.png', url: 'blob:mine', width: 512, height: 512 }

const lines: string[] = []
useCreateStore.subscribe((s, prev) => { if (s.progressText && s.progressText !== prev.progressText) lines.push(s.progressText) })

function on(intent: CreateIntent, extra: Record<string, unknown> = {}) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    hiresFixEnabled: false, transparentBackground: false, seed: 42, batchSources: [], videoShots: [],
    imageModel: QWEN, imageModelType: classifyModel(QWEN), imageModelList: listed(QWEN, Z_IMAGE),
    videoModel: WAN_TI2V, videoModelList: listed(WAN_TI2V, WAN_T2V, LTX25, H3),
    lipsyncModelList: listed(S2V), motionModelList: listed(ANIMATE), localOpModel: '',
    selectedLoras: [{ name: 'film_grain.safetensors', strength: 0.5 }], loraStrengths: {},
  } as never)
  useCreateStore.getState().setIntent(intent)
  // B24: the LoRA picks belong to the task and model, so they are picked on
  // the lane the run is on (a model in `extra` is a lane change).
  useCreateStore.setState({ selectedCharacter: MIRA, ...extra } as never)
  useCreateStore.setState({ selectedLoras: [{ name: 'film_grain.safetensors', strength: 0.5 }] })
  useCreateStore.getState().setPrompt('walking through the rain')
}

async function run() {
  const { result } = renderHook(() => useCreate())
  await result.current.generate()
  return result
}

const imageBuild = () => seen.builds.find((b) => typeof b.frames !== 'number')
const videoBuild = () => seen.builds.find((b) => typeof b.frames === 'number')

beforeEach(() => {
  seen.builds.length = 0
  seen.lanes.length = 0
  seen.submits = 0
  seen.freed = 0
  seen.onBuild = null
  videoRuns.clear()
  lines.length = 0
})

function expectStartImage() {
  const img = imageBuild()
  expect(img).toBeDefined()
  expect(img?.model).toBe(Z_IMAGE)
  expect(img?.lora).toEqual([CHAR])
  expect(String(img?.prompt)).toMatch(/^mira, /)
  expect(img?.inputImage).toBeUndefined()
}

describe('the character chain on every video lane', () => {
  it('Video: the start image first, then the video from it, with both in the gallery', async () => {
    on('video')
    await run()
    expectStartImage()
    expect(imageBuild()?.prompt).toBe('mira, walking through the rain')
    const vid = videoBuild()
    expect(vid?.model).toBe(WAN_TI2V)
    expect(vid?.inputImage).toBe('char-start.png')
    expect(vid?.lora).toEqual(['film_grain.safetensors'])
    expect(seen.builds.indexOf(imageBuild()!)).toBeLessThan(seen.builds.indexOf(vid!))
    expect(seen.freed).toBe(1)
    const gallery = useCreateStore.getState().gallery
    expect(gallery.map((g) => g.type)).toEqual(['video', 'image'])
    expect(useCreateStore.getState().error).toBeNull()
    expect(lines.some((l) => l.startsWith(CHAIN_STEP_IMAGE))).toBe(true)
    expect(lines.some((l) => l.startsWith(CHAIN_STEP_VIDEO))).toBe(true)
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('Video on a text only model says so and renders nothing', async () => {
    on('video')
    useCreateStore.setState({ videoModel: WAN_T2V } as never)
    await run()
    expect(seen.builds).toEqual([])
    expect(useCreateStore.getState().error).toMatch(/makes video from text only/)
  })

  it('Multishot (LTX 2.5): the shots stay and the clip starts from the character', async () => {
    on('video')
    useCreateStore.setState({ videoModel: LTX25, videoShots: ['she turns around'] } as never)
    await run()
    expectStartImage()
    expect(videoBuild()?.inputImage).toBe('char-start.png')
    expect(String(videoBuild()?.prompt)).toMatch(/she turns around/)
  })

  it('MiniMax H3 starts from the character', async () => {
    on('video')
    useCreateStore.setState({ videoModel: H3 } as never)
    await run()
    expectStartImage()
    expect(videoBuild()?.model).toBe(H3)
    expect(videoBuild()?.inputImage).toBe('char-start.png')
  })

  it('Animate without a start image starts from the character', async () => {
    on('animate')
    await run()
    expectStartImage()
    expect(videoBuild()?.inputImage).toBe('char-start.png')
  })

  it('Animate with an image of the user keeps that image and renders no character image', async () => {
    on('animate', { source: SOURCE })
    await run()
    expect(imageBuild()).toBeUndefined()
    expect(videoBuild()?.inputImage).toBe('mine.png')
  })

  it('Extend without a clip starts from the character, with a clip it continues the clip', async () => {
    on('extend')
    await run()
    expectStartImage()
    expect(videoBuild()?.inputImage).toBe('char-start.png')

    seen.builds.length = 0
    on('extend', { source: SOURCE })
    await run()
    expect(imageBuild()).toBeUndefined()
    expect(videoBuild()?.inputImage).toBe('mine.png')
  })

  it('Talking Character speaks from a portrait of the character', async () => {
    vi.stubGlobal('Audio', class { onerror: null | (() => void) = null; onloadedmetadata = null; preload = ''; duration = 0; set src(_v: string) { setTimeout(() => this.onerror?.(), 0) } })
    on('lipsync', { audioInput: { name: 'voice.wav', url: 'blob:v', blob: new Blob(['a']) }, localOpModel: S2V })
    await run()
    expectStartImage()
    expect(String(imageBuild()?.prompt)).toMatch(/^mira, portrait photo/)
    expect(seen.lanes[0]?.refImage).toBe('char-start.png')
    vi.unstubAllGlobals()
  })

  it('Motion Control drives a full body image of the character', async () => {
    on('motion', { videoInput: { name: 'dance.mp4', url: 'blob:d', blob: new Blob(['v']) }, localOpModel: ANIMATE })
    await run()
    expectStartImage()
    expect(String(imageBuild()?.prompt)).toMatch(/^mira, full body photo/)
    expect(seen.lanes[0]?.refImage).toBe('char-start.png')
  })

  it('Stop during the character image ends the whole chain', async () => {
    on('video')
    const { result } = renderHook(() => useCreate())
    seen.onBuild = () => {
      seen.onBuild = null
      void result.current.cancel()
      throw new Error('Cancelled')
    }
    await result.current.generate()
    expect(seen.builds).toHaveLength(1)
    expect(videoBuild()).toBeUndefined()
    expect(useCreateStore.getState().gallery).toEqual([])
    expect(useCreateStore.getState().error).toBeNull()
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('a failed character image leaves the video out and keeps the reason', async () => {
    on('video')
    seen.onBuild = () => { seen.onBuild = null; throw new Error('out of memory') }
    await run()
    expect(videoBuild()).toBeUndefined()
    expect(useCreateStore.getState().error).toMatch(/out of memory/)
  })
})

describe('the character in Image and Edit', () => {
  it('Image: the LoRA rides, the trigger word goes in front once', async () => {
    on('image', { imageModel: Z_IMAGE, imageModelType: 'zimage' })
    await run()
    expect(seen.builds).toHaveLength(1)
    expect(imageBuild()?.lora).toEqual(['film_grain.safetensors', CHAR])
    expect(imageBuild()?.prompt).toBe('mira, walking through the rain')
    // B40: the picture remembers the LoRAs it was made with.
    expect(useCreateStore.getState().gallery[0].loras?.map((l) => l.name)).toEqual(['film_grain.safetensors', CHAR])

    seen.builds.length = 0
    on('image', { imageModel: Z_IMAGE, imageModelType: 'zimage' })
    useCreateStore.getState().setPrompt('Mira walking through the rain')
    await run()
    expect(imageBuild()?.prompt).toBe('Mira walking through the rain')
  })

  it('Image on another model stops with the reason', async () => {
    on('image')
    await run()
    expect(seen.builds).toEqual([])
    expect(useCreateStore.getState().error).toBe('This character was trained for Z Image. Pick a Z Image model to use it.')
  })

  it('Edit with a mask says the character needs none', async () => {
    on('edit', { imageModel: Z_IMAGE, imageModelType: 'zimage', source: SOURCE, mask: { ...SOURCE, filename: 'mask.png' } })
    await run()
    expect(seen.builds).toEqual([])
    expect(useCreateStore.getState().error).toBe(EDIT_MASK_NO_CHARACTER)
  })

  it('Edit without a mask edits with the character', async () => {
    on('edit', { imageModel: Z_IMAGE, imageModelType: 'zimage', source: SOURCE })
    await run()
    expect(imageBuild()?.inputImage).toBe('mine.png')
    expect(imageBuild()?.lora).toEqual(['film_grain.safetensors', CHAR])
  })
})
