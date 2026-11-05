// @vitest-environment jsdom
/**
 * The box, 03.10.2026: before a run the stage stood 25 to 30 s on "Preparing
 * workflow..." with no counter. That time is the hand-over of the graphics
 * card (api/vram-handoff), most of it waiting for the chat model the previous
 * render brought back. The stage says so and counts the seconds, through the
 * real generate path of useCreate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const seen = vi.hoisted(() => ({ lines: [] as string[], atBuild: '' }))

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
  submitWorkflow: vi.fn(async () => { throw new Error('stop here') }),
}))
vi.mock('../../api/comfyui-ws', () => ({
  CLIENT_ID: 'lu-test',
  comfyWS: { connect: vi.fn(async () => { throw new Error('no socket') }), mark: () => 0, onPreview: () => () => {} },
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async (onPhase?: (phase: string) => void) => {
    const { useCreateStore } = await import('../../stores/createStore')
    const line = () => useCreateStore.getState().progressText
    seen.lines.push(line())
    onPhase?.('waiting-for-chat-model')
    seen.lines.push(line())
    await new Promise((r) => setTimeout(r, 2100))
    seen.lines.push(line())
    onPhase?.('freeing')
    seen.lines.push(line())
    return null
  }),
  restoreChatBackendsAfterRender: vi.fn(),
}))
vi.mock('../../api/dynamic-workflow', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  buildDynamicWorkflow: vi.fn(async () => {
    const { useCreateStore } = await import('../../stores/createStore')
    seen.atBuild = useCreateStore.getState().progressText
    return { '1': { class_type: 'SaveImage', inputs: {} } }
  }),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'

const MODEL = 'sd_turbo.safetensors'

beforeEach(() => {
  seen.lines.length = 0
  seen.atBuild = ''
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [],
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42,
    imageModel: MODEL, imageModelList: [{ name: MODEL, type: 'sd15' }],
  } as never)
  const s = useCreateStore.getState()
  s.setIntent('image')
  s.setPrompt('a lighthouse at dusk')
})

describe('the wait before a local run', () => {
  it('names the hand-over of the graphics card and counts its seconds', async () => {
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.lines).toEqual([
      'Freeing graphics memory... 0s',
      'Waiting for the chat model to finish loading... 0s',
      'Waiting for the chat model to finish loading... 2s',
      'Freeing graphics memory... 2s',
    ])
  }, 15_000)

  it('stops counting when the hand-over is done: the next line is not painted over', async () => {
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.atBuild).toBe('Building workflow...')
    const after = useCreateStore.getState().progressText
    await new Promise((r) => setTimeout(r, 1200))
    expect(useCreateStore.getState().progressText).toBe(after)
    expect(after).not.toMatch(/Freeing|Waiting for the chat model/)
  }, 15_000)
})
