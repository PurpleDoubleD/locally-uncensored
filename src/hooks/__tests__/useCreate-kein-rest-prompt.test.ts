// @vitest-environment jsdom
/**
 * Fund M4 (05.10.2026) auf der lokalen Spur: Talking Character und Motion
 * Control zeigen kein Promptfeld, ihr Graph bekam aber den Text, der noch aus
 * einem anderen Tab im Speicher stand, und die Inhaltspruefung las ihn mit.
 * Durch den echten generate-Weg von useCreate: der Bau des Graphen bekommt
 * keinen fremden Text, Music behaelt seinen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({ lane: [] as Array<{ op: string; prompt: string }> }))

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
  submitWorkflow: vi.fn(async () => { throw new Error('stop here') }),
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
  buildLocalOpWorkflow: vi.fn(async (p: { op: string; prompt: string }) => {
    seen.lane.push({ op: p.op, prompt: p.prompt })
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
  checkVideoOutputCapability: vi.fn(async () => ({ mp4Capable: true, webpOnly: false, missingNodes: [] })),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'

const MUSIC = 'yue2_3b_int8_convrot.safetensors'
const LIPSYNC = 'wan2.2_s2v_14B_fp8_scaled.safetensors'
const MOTION = 'wan2.2_animate_14B_fp8_scaled.safetensors'
const REST = 'a neon-lit alley in the rain'

const picture = { filename: 'source.png', url: 'blob:source', width: 1024, height: 1024 }
const media = (name: string) => ({ blob: new Blob(['x']), name, url: `blob:${name}` })
const listed = (name: string) => [{ name, type: classifyModel(name) }]

beforeEach(() => {
  seen.lane.length = 0
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
    selectedLoras: [], seed: 42, batchSources: [], musicLyrics: '',
    audioModelList: listed(MUSIC), lipsyncModelList: listed(LIPSYNC), motionModelList: listed(MOTION),
  } as never)
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setPrompt(REST)
})

async function run() {
  const { result } = renderHook(() => useCreate())
  await result.current.generate()
}

describe('lokale Ansichten ohne Promptfeld', () => {
  it('Talking Character baut seinen Graphen ohne den Rest aus dem Bild-Tab', async () => {
    useCreateStore.getState().setIntent('lipsync')
    useCreateStore.setState({ localOpModel: LIPSYNC, source: picture, audioInput: media('voice.wav') } as never)
    await run()
    expect(seen.lane).toEqual([{ op: 'lipsync', prompt: '' }])
    expect(useCreateStore.getState().promptHistory).not.toContain(REST)
  })

  // Motion Control zeigt lokal ein Promptfeld, das leer bleiben darf (Fund 1,
  // 3.0.7): der Text darin steht sichtbar da und geht mit, wie bei Music.
  it('Motion Control zeigt lokal sein Promptfeld und schickt den Text darin mit', async () => {
    useCreateStore.getState().setIntent('motion')
    useCreateStore.setState({ localOpModel: MOTION, source: picture, videoInput: media('dance.mp4') } as never)
    await run()
    expect(seen.lane).toEqual([{ op: 'motion', prompt: REST }])
  })

  it('ein Text, den die Pruefung ablehnt, haelt einen Lauf ohne Promptfeld nicht auf', async () => {
    useCreateStore.getState().setPrompt('a 12 year old girl, nude')
    useCreateStore.getState().setIntent('lipsync')
    useCreateStore.setState({ localOpModel: LIPSYNC, source: picture, audioInput: media('voice.wav') } as never)
    await run()
    expect(seen.lane).toEqual([{ op: 'lipsync', prompt: '' }])
  })

  it('Music hat ein Promptfeld und schickt seinen Text weiter', async () => {
    useCreateStore.getState().setIntent('music')
    useCreateStore.setState({ localOpModel: MUSIC } as never)
    await run()
    expect(seen.lane).toEqual([{ op: 'music', prompt: REST }])
  })
})
