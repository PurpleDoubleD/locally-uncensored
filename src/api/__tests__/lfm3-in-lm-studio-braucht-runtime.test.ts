/**
 * N1, 30.10.2026: LFM3 in LM Studio needs its llama.cpp runtime 2.65.1 or
 * newer. On the Mac LM Studio ran 2.55.0, and a load of LFM3 there fails
 * without a word about why. LU reads the runtime (read only, never changes it)
 * and says what to do instead of asking LM Studio for a load that cannot work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Args = Record<string, unknown> | undefined
const backendCall = vi.fn(async (_command: string, _args?: Args): Promise<unknown> => ({}))
vi.mock('../backend', () => ({ backendCall: (command: string, args?: Args) => backendCall(command, args) }))

import { loadLmStudioModel, LmStudioSwitchError, __stopEndedLmStudioLoadWatchForTests } from '../lmstudio'
import { __resetEndedLmStudioLoadsForTests } from '../../lib/lmstudio-ended-loads'
import { compareVersions, isLfm3Model, lmStudioRuntimeNote } from '../../lib/lmstudio-runtime'

function lmStudio(runtime: string | null) {
  backendCall.mockImplementation(async (command) => {
    if (command === 'lmstudio_gguf_runtime') return runtime
    if (command === 'lmstudio_list_loaded') return { models: [] }
    return {}
  })
}

beforeEach(() => { backendCall.mockReset(); __resetEndedLmStudioLoadsForTests() })
afterEach(() => __stopEndedLmStudioLoadWatchForTests())

describe('LFM3 in LM Studio', () => {
  it('mit Runtime 2.55.0 sagt LU, was zu tun ist, und fragt LM Studio gar nicht erst', async () => {
    lmStudio('2.55.0')
    const err = await loadLmStudioModel('liquidai/lfm3-1.7b').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LmStudioSwitchError)
    expect((err as LmStudioSwitchError).reason).toContain("Update LM Studio's runtime to 2.65.1 or newer for LFM3")
    expect((err as LmStudioSwitchError).reason).toContain('2.55.0')
    expect(backendCall.mock.calls.some(([c]) => c === 'lmstudio_load_model')).toBe(false)
  })

  it('mit 2.66.0 wird geladen', async () => {
    lmStudio('2.66.0')
    await loadLmStudioModel('liquidai/lfm3-vl-2b')
    expect(backendCall.mock.calls.some(([c]) => c === 'lmstudio_load_model')).toBe(true)
  })

  it('unbekannte Runtime: kein Satz, LM Studio entscheidet', async () => {
    lmStudio(null)
    await loadLmStudioModel('liquidai/lfm3-1.7b')
    expect(backendCall.mock.calls.some(([c]) => c === 'lmstudio_load_model')).toBe(true)
  })

  it('andere Modelle fragen nicht nach der Runtime', async () => {
    lmStudio('2.0.0')
    await loadLmStudioModel('qwen/qwen3.8-27b')
    expect(backendCall.mock.calls.some(([c]) => c === 'lmstudio_gguf_runtime')).toBe(false)
  })
})

describe('Versionen und Namen', () => {
  it('vergleicht Teil fuer Teil, nicht als Text', () => {
    expect(compareVersions('2.65.1', '2.65.1')).toBe(0)
    expect(compareVersions('2.9.0', '2.65.1')).toBe(-1)
    expect(compareVersions('2.100.0', '2.65.1')).toBe(1)
    expect(compareVersions('3.0', '2.65.1')).toBe(1)
  })
  it('LFM3 ja, LFM2 und LFM 2.5 nicht', () => {
    for (const id of ['liquidai/lfm3-1.7b', 'LFM3-VL-2B-Q4_K_M', 'lfm3-omni-2b']) expect(isLfm3Model(id)).toBe(true)
    for (const id of ['liquidai/lfm2.5-2.6b', 'lfm2-8b', 'xlfm3y']) expect(isLfm3Model(id)).toBe(false)
    expect(lmStudioRuntimeNote('lfm2-8b', '2.0.0')).toBeNull()
  })
})
