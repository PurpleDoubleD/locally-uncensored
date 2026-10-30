// @vitest-environment jsdom
/**
 * The box, 03.10.2026 (RTX 3060, ComfyUI 0.33.0): YuE2 in Music ended with
 * "Generation failed: YuE2 needs ComfyUI 0.36.0 or newer. Update ComfyUI in
 * Settings." while Image and Video ask once and update. The lanes with their
 * own graph (Music, Talking Character, Motion Control) built outside the
 * question. Every lane that can meet a version gate is driven here through the
 * real generate path of useCreate: the build fails with the gate, the question
 * appears, a yes updates and the same build runs again and reaches the submit.
 *
 * Character training is not in the table: it is the Rust trainer and never
 * builds a ComfyUI graph. Using a trained character is the Character lane
 * below. The prompt enhancer has its own run of this in
 * useCreate-qwen-enhancer.test.ts, the agent's tool in vram-handoff.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({
  order: [] as string[],
  gate: true,
}))

const GATE = 'YuE2 needs ComfyUI 0.36.0 or newer. Update ComfyUI in Settings.'

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
  uploadMediaFile: vi.fn(async (_blob: Blob, name: string) => name),
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
vi.mock('../../api/dynamic-workflow', async (orig) => {
  const actual = (await orig()) as typeof import('../../api/dynamic-workflow')
  // The first build meets the gate, the build after the update goes through.
  const build = (name: string) => vi.fn(async () => {
    seen.order.push(name)
    if (seen.gate) throw new actual.WorkflowUnavailableError(GATE, 'unavailable', undefined, { needsComfyUpdate: true })
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  })
  return {
    ...actual,
    buildDynamicWorkflow: build('build'),
    buildLocalOpWorkflow: build('build'),
    checkVideoOutputCapability: vi.fn(async () => ({ mp4Capable: true, webpOnly: false, missingNodes: [] })),
  }
})
// The real question, the real retry. Only the update itself is replaced: it
// would run git and pip.
vi.mock('../../api/render-fixup-deps', async (orig) => {
  const actual = (await orig()) as typeof import('../../api/render-fixup-deps')
  return {
    renderFixupDeps: (...args: Parameters<typeof actual.renderFixupDeps>) => ({
      ...actual.renderFixupDeps(...args),
      updateComfy: async () => { seen.order.push('update'); seen.gate = false },
      refresh: async () => { seen.order.push('refresh') },
    }),
  }
})

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'
import type { CreateIntent } from '../../stores/createStore'

const IMAGE = 'qwen_image_2.1_int8_convrot.safetensors'
const VIDEO = 'wan2.2_ti2v_5B_fp16.safetensors'
const MUSIC = 'yue2_3b_int8_convrot.safetensors'
const LIPSYNC = 'wan2.2_s2v_14B_fp8_scaled.safetensors'
const MOTION = 'wan2.2_animate_14B_fp8_scaled.safetensors'

const picture = { filename: 'source.png', url: 'blob:source', width: 1024, height: 1024 }
const media = (name: string) => ({ blob: new Blob(['x']), name, url: `blob:${name}` })
const listed = (name: string) => [{ name, type: classifyModel(name) }]

interface Lane {
  lane: string
  intent: CreateIntent
  /** Applied after setIntent: the inputs this lane needs before it builds. */
  inputs?: Record<string, unknown>
}

const LANES: Lane[] = [
  { lane: 'Image', intent: 'image' },
  { lane: 'Edit', intent: 'edit', inputs: { source: picture } },
  { lane: 'Character (use a trained one)', intent: 'character', inputs: { characterTab: 'use' } },
  { lane: 'Video', intent: 'video' },
  { lane: 'Animate', intent: 'animate', inputs: { source: picture } },
  { lane: 'Extend', intent: 'extend', inputs: { source: picture } },
  { lane: 'Music', intent: 'music', inputs: { localOpModel: MUSIC, musicLyrics: '[Verse]\nSnow is falling' } },
  { lane: 'Talking Character', intent: 'lipsync', inputs: { localOpModel: LIPSYNC, source: picture, audioInput: media('voice.wav') } },
  { lane: 'Motion Control', intent: 'motion', inputs: { localOpModel: MOTION, source: picture, videoInput: media('dance.mp4') } },
]

beforeEach(() => {
  seen.order.length = 0
  seen.gate = true
  // jsdom never loads media, so the voice length probe would wait for ever.
  vi.stubGlobal('Audio', class {
    onerror: (() => void) | null = null
    set src(_value: string) { queueMicrotask(() => this.onerror?.()) }
  })
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:probe'
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => undefined
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42, batchSources: [],
    imageModel: IMAGE, imageModelList: listed(IMAGE),
    videoModel: VIDEO, videoModelList: listed(VIDEO),
    audioModelList: listed(MUSIC), lipsyncModelList: listed(LIPSYNC), motionModelList: listed(MOTION),
  } as never)
})

function enter(lane: Lane) {
  useCreateStore.getState().setIntent(lane.intent)
  if (lane.inputs) useCreateStore.setState(lane.inputs as never)
  useCreateStore.getState().setPrompt('acoustic folk, female vocal, slow')
}

describe.each(LANES)('a ComfyUI too old for the model, $lane', (lane) => {
  it('asks once, updates on yes, builds again and starts the run', async () => {
    enter(lane)
    const { result } = renderHook(() => useCreate())
    const done = result.current.generate()
    await vi.waitFor(() => expect(useCreateStore.getState().fixupPrompt).not.toBeNull())
    expect(useCreateStore.getState().fixupPrompt?.title).toBe('ComfyUI needs an update')
    expect(seen.order).toEqual(['build'])
    useCreateStore.getState().fixupPrompt?.resolve(true)
    await done
    expect(seen.order).toEqual(['build', 'update', 'refresh', 'build', 'submit'])
    expect(useCreateStore.getState().fixupPrompt).toBeNull()
  })

  it('a no ends the run as not started, with the reason', async () => {
    enter(lane)
    const { result } = renderHook(() => useCreate())
    const done = result.current.generate()
    await vi.waitFor(() => expect(useCreateStore.getState().fixupPrompt).not.toBeNull())
    useCreateStore.getState().fixupPrompt?.resolve(false)
    await done
    expect(seen.order).toEqual(['build'])
    expect(useCreateStore.getState().error).toBe(`Not started. ${GATE}`)
  })
})
