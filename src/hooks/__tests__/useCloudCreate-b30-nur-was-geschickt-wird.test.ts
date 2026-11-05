/**
 * @vitest-environment jsdom
 *
 * B30-Rest (3.0.9, Q1): the store keeps lyrics and trigger word across modes.
 * The desktop cloud Create read them on every run, so a word typed in Music or
 * Training blocked an image run that never sends it. Same rule as the web fix
 * fb714de4: only what the run sends is checked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const hoisted = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    code?: string
    retryAfterMs?: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    policySnapshot: 'strict' as 'strict' | 'soft' | 'off' | null,
    submitCloudJob: vi.fn(async () => ({ id: 'job-1' })),
    uploadInput: vi.fn(async () => 'uploaded/path'),
    getJob: vi.fn(),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    // 'canceled' short-circuits the post-submit result handling in both
    // generate() and makeVoice() cleanly, this test only cares about what
    // happens BEFORE submitCloudJob, not the full success path.
    pollJob: vi.fn(async () => ({ id: 'job-1', status: 'canceled' as const })),
    FakeCloudJobError,
  }
})
const { submitCloudJob, uploadInput } = hoisted

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => hoisted.policySnapshot,
  loadContentPolicy: async () => hoisted.policySnapshot ?? 'soft',
}))

vi.mock('../../api/cloud/jobs', () => ({
  submitCloudJob: (...a: Parameters<typeof hoisted.submitCloudJob>) => hoisted.submitCloudJob(...a),
  uploadInput: (...a: Parameters<typeof hoisted.uploadInput>) => hoisted.uploadInput(...a),
  getJob: (...a: Parameters<typeof hoisted.getJob>) => hoisted.getJob(...a),
  cancelJob: (...a: Parameters<typeof hoisted.cancelJob>) => hoisted.cancelJob(...a),
  pollJob: (...a: Parameters<typeof hoisted.pollJob>) => hoisted.pollJob(...a),
  CloudJobError: hoisted.FakeCloudJobError,
}))

vi.mock('../../stores/cloudCatalogStore', () => ({
  defaultCloudModel: () => ({ id: 'test-model' }),
  modelForOp: () => 'test-model',
  resolveOpPick: () => 'test-model',
  cloudModelById: () => undefined,
  cloudMediaLive: () => true,
  // No rule by length for the test model: the start sends no ceiling.
  lengthPrice: () => undefined,
  lengthCredits: () => 0,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { blockMessageFor } from '../../lib/render/safety'

beforeEach(() => {
  submitCloudJob.mockClear()
  uploadInput.mockClear()
  hoisted.policySnapshot = 'off'
  useCreateStore.setState({
    prompt: '',
    negativePrompt: '',
    musicLyrics: '',
    triggerWord: '',
    removebg: false,
    utilityOp: null,
    cloudOp: null,
    mode: 'image',
    imageSubMode: 'text2img',
    isGenerating: false,
    error: null,
  } as Partial<ReturnType<typeof useCreateStore.getState>>)
})

describe('B30-Rest: the desktop cloud check reads only what this run sends', () => {
  it('lyrics left from the music tab do not block an image run', async () => {
    useCreateStore.setState({ prompt: 'a nude woman on a beach at sunset', musicLyrics: 'back to the schoolgirl days' })
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => { await result.current.generate() })
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitCloudJob).toHaveBeenCalledOnce()
  })

  it('a trigger word left from training does not block an image run', async () => {
    useCreateStore.setState({ prompt: 'a nude woman on a beach at sunset', triggerWord: 'teen' })
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => { await result.current.generate() })
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitCloudJob).toHaveBeenCalledOnce()
  })

  it('the prompt itself is still read: a minor + sexual prompt stays blocked', async () => {
    useCreateStore.setState({ prompt: 'a nude teen on a beach', musicLyrics: 'la la' })
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => { await result.current.generate() })
    expect(useCreateStore.getState().error).toBe(blockMessageFor('csam'))
    expect(submitCloudJob).not.toHaveBeenCalled()
  })

  it('a trigger word a training run sends is still read', async () => {
    useCreateStore.setState({ cloudOp: 'character', characterTab: 'train', triggerWord: 'nude teen' } as Partial<ReturnType<typeof useCreateStore.getState>>)
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => { await result.current.generate() })
    expect(useCreateStore.getState().error).toBe(blockMessageFor('csam'))
    expect(submitCloudJob).not.toHaveBeenCalled()
  })
})
