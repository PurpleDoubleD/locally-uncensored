// @vitest-environment jsdom
/**
 * Discord, thread "I can't launch Wan2.2" (15.10.2026): Motion Control never
 * ran a workflow of the user's own. useCreate skipped the workflow lookup for
 * every lane with its own graph, so the Workflow picker of Advanced settings
 * could say a workflow was picked and the run still went out as LU's graph.
 * Driven through the real generate path: the submitted graph is the user's
 * workflow, filled with the picked model, picture and clip.
 *
 * Run: npx vitest run src/hooks/__tests__/useCreate-motion-runs-the-own-workflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import example from '../../api/__tests__/fixtures/wan-animate/quantstack-example.api.json'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const seen = vi.hoisted(() => ({ submitted: null as ComfyApiGraph | null, built: 0, laneNegative: undefined as string | undefined }))

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
  submitWorkflow: vi.fn(async (wf: ComfyApiGraph) => { seen.submitted = wf; throw new Error('stop here') }),
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
    buildLocalOpWorkflow: vi.fn(async (p: { negativePrompt?: string }) => {
      seen.built++
      seen.laneNegative = p.negativePrompt
      return { '1': { class_type: 'LUsOwnMotionGraph', inputs: {} } }
    }),
  }
})

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { parseImportedWorkflow } from '../../api/workflows'

const MOTION = 'Wan2.2-Animate-14B-Q4_K_M.gguf'
const picture = { filename: 'me.png', url: 'blob:me', width: 832, height: 480 }
const clip = { blob: new Blob(['x']), name: 'flip.mp4', url: 'blob:flip' }

beforeEach(() => {
  seen.submitted = null
  seen.built = 0
  seen.laneNegative = undefined
  useWorkflowStore.setState({
    installedWorkflows: [], modelTypeAssignments: {}, modelNameAssignments: {},
    tags: [], workflowTags: {}, modelTags: {},
  } as never)
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], fixupPrompt: null,
    improvePrompt: false, cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
    selectedLoras: [], hiresFixEnabled: false, transparentBackground: false, seed: 42, batchSources: [],
    motionModelList: [{ name: MOTION, type: 'wananimate' }],
  } as never)
  useCreateStore.getState().setIntent('motion')
  useCreateStore.setState({ localOpModel: MOTION, source: picture, videoInput: clip } as never)
  useCreateStore.getState().setPrompt('a man doing a backflip')
})

function pickOwnWorkflow() {
  const s = useWorkflowStore.getState()
  s.installWorkflow({ ...parseImportedWorkflow('Wan animate native', example as unknown as ComfyApiGraph), id: 'wf1', installedAt: 1 })
  const tag = s.createTag('Wan Animate')!
  s.setWorkflowTags('wf1', [tag])
  s.setModelTags(MOTION, 'video', [tag])
  s.assignToModelName(MOTION, 'wf1')
}

describe('Motion Control with a workflow of the user\'s own', () => {
  it('THE REPORT: the run goes out as that workflow, filled from the tab', async () => {
    pickOwnWorkflow()
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.built).toBe(0)
    const wf = seen.submitted!
    expect(wf['51'].class_type).toBe('WanAnimateToVideo')
    expect(wf['85'].inputs?.unet_name).toBe(MOTION)
    expect(wf['78'].inputs?.image).toBe('me.png')
    expect(wf['79'].inputs?.video).toBe('flip.mp4')
    // Motion Control has no prompt field, so nothing typed on another tab
    // reaches the run, and the workflow keeps its own prompt.
    expect(wf['6'].inputs?.text).toBe('a girl is dancing')
    expect(wf['3'].inputs?.steps).toBe(6)
  })

  it('LU\'s own Motion graph gets no negative prompt typed on another tab', async () => {
    // Motion Control has no prompt field and so no negative field either; a
    // negative left from Image or Video went into its graph unseen (3.0.7).
    useCreateStore.getState().setNegativePrompt('blurry hands, extra fingers')
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.built).toBe(1)
    expect(seen.laneNegative ?? '').toBe('')
  })

  it('without a picked workflow LU builds its own graph as before', async () => {
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(seen.built).toBe(1)
    expect(seen.submitted?.['1'].class_type).toBe('LUsOwnMotionGraph')
  })
})
