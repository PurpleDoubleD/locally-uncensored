// @vitest-environment jsdom
/**
 * The box, 03.10.2026: the first video stood on "Building workflow..." for ten
 * minutes. Nothing was building: the dialog "Install MP4 support?" was waiting
 * for an answer. While a question waits, the stage says so. The dialog also
 * promised "about 30 seconds" for an install that took a good two minutes on
 * the box, so it names no number any more.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, screen, cleanup } from '@testing-library/react'

const seen = vi.hoisted(() => ({ webpOnly: true, tooOld: false }))

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
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))
vi.mock('../../api/dynamic-workflow', async (orig) => {
  const actual = (await orig()) as typeof import('../../api/dynamic-workflow')
  return {
    ...actual,
    buildDynamicWorkflow: vi.fn(async () => {
      if (seen.tooOld) throw new actual.WorkflowUnavailableError(actual.LTX25_NEEDS_UPDATE, 'ltx25', undefined, { needsComfyUpdate: true })
      return { '1': { class_type: 'SaveAnimatedWEBP', inputs: {} } }
    }),
    checkVideoOutputCapability: vi.fn(async () => ({ mp4Capable: !seen.webpOnly, webpOnly: seen.webpOnly, missingNodes: [] })),
  }
})

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { classifyModel } from '../../api/comfyui'
import { WAITING_FOR_ANSWER } from '../../lib/render-fixups'
import { VhsInstallModal } from '../../components/create/experimental/VhsInstallModal'

const VIDEO = 'wan2.1_t2v_1.3B_bf16.safetensors'

beforeEach(() => {
  seen.webpOnly = true
  seen.tooOld = false
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null, vhsInstallPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    selectedLoras: [], hiresFixEnabled: false, seed: 42, batchSources: [], progressText: '',
    videoModel: VIDEO, videoModelList: [{ name: VIDEO, type: classifyModel(VIDEO) }],
  } as never)
  useCreateStore.getState().setIntent('video')
  useCreateStore.getState().setPrompt('a woman walking in a park')
})
afterEach(() => cleanup())

describe('a question that waits for the user', () => {
  it('"Install MP4 support?": the stage says a question is waiting, not "Building workflow..."', async () => {
    const { result } = renderHook(() => useCreate())
    const done = result.current.generate()
    await vi.waitFor(() => expect(useCreateStore.getState().vhsInstallPrompt).not.toBeNull())
    expect(useCreateStore.getState().progressText).toBe(WAITING_FOR_ANSWER)
    useCreateStore.getState().vhsInstallPrompt?.('cancel')
    await done
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('"ComfyUI needs an update": the stage says the same while that question waits', async () => {
    seen.tooOld = true
    const { result } = renderHook(() => useCreate())
    const done = result.current.generate()
    await vi.waitFor(() => expect(useCreateStore.getState().fixupPrompt).not.toBeNull())
    expect(useCreateStore.getState().progressText).toBe(WAITING_FOR_ANSWER)
    useCreateStore.getState().fixupPrompt?.resolve(false)
    await done
  })

  it('the wording names the dialog and carries no dash', () => {
    expect(WAITING_FOR_ANSWER).toBe('Waiting for your answer in the dialog…')
  })
})

describe('the MP4 support dialog', () => {
  it('promises no number of seconds', () => {
    useCreateStore.setState({ vhsInstallPrompt: () => undefined } as never)
    render(<VhsInstallModal />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Install MP4 support?')
    expect(text).not.toMatch(/\d+\s*seconds/)
    expect(text).toContain('This can take a few minutes.')
    expect(screen.getByText('Install VHS_VideoCombine + continue')).toBeTruthy()
  })
})
