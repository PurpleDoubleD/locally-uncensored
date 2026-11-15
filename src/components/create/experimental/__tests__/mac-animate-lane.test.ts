// @vitest-environment jsdom
/**
 * Animate Image on the Mac (08.10.2026). Local video there was text to video
 * only, while the catalogue carried models that start from an image, and one
 * that cannot run without it. The lane is the one Windows and the cloud have:
 * the same tab, the same drop area on the Stage. What differs is below it,
 * and that is what these cases hold:
 *
 *   the tab is local on a Mac only while an installed model takes an image,
 *   the Stage's image is written to disk instead of uploaded to ComfyUI,
 *   a Video lane with nothing that runs from text shows the setup card,
 *   and the Create button says which image it waits for.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/mac-animate-lane.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const io = vi.hoisted(() => ({
  mac: true,
  uploadImage: vi.fn(async () => 'input.png'),
  stageStartImage: vi.fn(async () => '/data/videos/start-images/abc.png'),
}))
vi.mock('../../../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  uploadImage: io.uploadImage,
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => io.mac, MLX_MODEL_PREFIX: 'MLX ' }))
vi.mock('../../../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  stageStartImage: io.stageStartImage,
}))

import { isIntentAvailable, isIntentLocked, visibleIntents, INTENT_MAP } from '../intents'
import { missingSourceHint } from '../laneHint'
import { laneModelCount, stageShowsSetupCard } from '../stageGate'
import { ensureLocalFilename, loadImageRef } from '../loadImage'
import { useCreateStore, deriveIntent } from '../../../../stores/createStore'
import type { ClassifiedModel } from '../../../../api/comfyui'

const model = (name: string, startImage: ClassifiedModel['startImage']): ClassifiedModel =>
  ({ name, type: 'wan', source: 'checkpoint', startImage })
const WAN21 = model('MLX Wan 2.1 T2V 1.3B', 'none')
const TI2V = model('MLX Wan 2.2 TI2V 5B 8-bit', 'optional')
const I2V = model('MLX Wan 2.2 I2V A14B', 'required')

const PNG_URL = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  io.mac = true
  io.uploadImage.mockClear()
  io.stageStartImage.mockClear()
  class FakeImage {
    onload: (() => void) | null = null
    naturalWidth = 640
    naturalHeight = 480
    set src(_url: string) { queueMicrotask(() => this.onload?.()) }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['png'], { type: 'image/png' }) })))
  useCreateStore.setState({ backend: 'local', videoModelList: [], cloudOp: null, utilityOp: null } as never)
  useCreateStore.getState().setIntent('image')
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the Animate tab on the Mac', () => {
  const ids = (mlxAnimate: boolean) => visibleIntents('local', true, true, mlxAnimate).map((m) => m.id)

  it('is not there while no installed model takes a start image', () => {
    expect(ids(false)).not.toContain('animate')
    expect(isIntentAvailable('animate', 'local', true, false)).toBe(false)
  })

  it('is a plain local tab once one does, and Edit stays out', () => {
    expect(ids(true)).toContain('animate')
    expect(isIntentLocked(INTENT_MAP.animate, 'local', true, true)).toBe(false)
    expect(isIntentAvailable('animate', 'local', true, true)).toBe(true)
    expect(ids(true)).not.toContain('edit')
    // With the cloud teasers off it is still there: it is no teaser. The
    // cutout is there on every Mac (Vision, commands/mlx_cutout.rs), and so
    // is Character Studio. Extend Video runs on the same models as Animate
    // since 14.10.2026 (M1), so it comes with it.
    expect(visibleIntents('local', true, false, true).map((m) => m.id)).toEqual(['image', 'removebg', 'video', 'animate', 'character', 'extend', '3d'])
  })

  it('changes nothing on a ComfyUI host, with or without the flag', () => {
    expect(visibleIntents('local', false, true, true)).toEqual(visibleIntents('local', false, true))
  })

  it('survives the switch to local while a model takes an image, and falls back to Video without one', () => {
    const toLocalWith = (list: ClassifiedModel[]) => {
      useCreateStore.setState({ backend: 'cloud', videoModelList: list } as never)
      useCreateStore.getState().setIntent('animate')
      useCreateStore.getState().setBackend('local')
      return deriveIntent(useCreateStore.getState())
    }
    expect(toLocalWith([WAN21, TI2V])).toBe('animate')
    expect(toLocalWith([WAN21])).toBe('video')
  })

  it('falls back to Video when the last such model is removed', () => {
    useCreateStore.setState({ backend: 'local', videoModelList: [WAN21, TI2V] } as never)
    useCreateStore.getState().setIntent('animate')
    useCreateStore.getState().setVideoModelList([WAN21, I2V])
    expect(deriveIntent(useCreateStore.getState())).toBe('animate')
    useCreateStore.getState().setVideoModelList([WAN21])
    expect(deriveIntent(useCreateStore.getState())).toBe('video')
  })

  it('leaves Animate alone on a ComfyUI host, whose list carries no such word', () => {
    io.mac = false
    useCreateStore.setState({ backend: 'local' } as never)
    useCreateStore.getState().setIntent('animate')
    useCreateStore.getState().setVideoModelList([{ name: 'wan2.1_t2v.safetensors', type: 'wan', source: 'checkpoint' }])
    expect(deriveIntent(useCreateStore.getState())).toBe('animate')
  })
})

describe('the image on the Stage', () => {
  it('is written to disk on the Mac, and its path is what the run reads', async () => {
    const ref = await loadImageRef(new File(['raw'], 'photo.png', { type: 'image/png' }))
    expect(ref.filename).toBe('/data/videos/start-images/abc.png')
    expect(io.stageStartImage).toHaveBeenCalledTimes(1)
    expect(io.uploadImage).not.toHaveBeenCalled()
  })

  it('still goes to ComfyUI on a ComfyUI host', async () => {
    io.mac = false
    const ref = await loadImageRef(new File(['raw'], 'photo.png', { type: 'image/png' }))
    expect(ref.filename).toBe('input.png')
    expect(io.stageStartImage).not.toHaveBeenCalled()
  })

  it('is not staged at all while the cloud renders', async () => {
    useCreateStore.setState({ backend: 'cloud' } as never)
    const ref = await loadImageRef(new File(['raw'], 'photo.png', { type: 'image/png' }))
    expect(ref.filename).toBe('')
    expect(io.stageStartImage).not.toHaveBeenCalled()
  })

  it('picked in cloud mode is staged on the Mac when the local run needs it', async () => {
    const ref = await ensureLocalFilename({ filename: '', url: PNG_URL, width: 1, height: 1 }, 'source.png')
    expect(ref.filename).toBe('/data/videos/start-images/abc.png')
  })
})

describe('a Video lane with nothing that runs from text', () => {
  const gate = (list: ClassifiedModel[], intent: 'video' | 'animate') => stageShowsSetupCard({
    backend: 'local', requiresModels: 'video', mlxMissing: { image: false, video: list.length === 0 },
    connected: null, modelsLoaded: true,
    laneModelCount: laneModelCount(intent, 'video', { image: [], video: list, audio: [], lipsync: [], motion: [] }),
  })

  it('shows the setup card on the Mac when the only video model needs a start image', () => {
    expect(gate([I2V], 'video')).toBe(true)
    expect(gate([I2V], 'animate')).toBe(false)
  })

  it('shows nothing of the kind while a model runs the lane', () => {
    expect(gate([WAN21], 'video')).toBe(false)
    expect(gate([TI2V], 'video')).toBe(false)
    expect(gate([TI2V], 'animate')).toBe(false)
  })

  it('waits for the list before it judges an empty lane', () => {
    expect(stageShowsSetupCard({
      backend: 'local', requiresModels: 'video', mlxMissing: { image: false, video: false },
      connected: null, modelsLoaded: false, laneModelCount: 0,
    })).toBe(false)
  })
})

describe('what the Create button says while the image is missing', () => {
  it('names the start image on Animate', () => {
    expect(missingSourceHint({ intent: 'animate', needsSource: true, hasSource: false })).toBe('Add a start image first.')
  })

  it('says nothing once the image is there, or on a lane without one', () => {
    expect(missingSourceHint({ intent: 'animate', needsSource: true, hasSource: true })).toBeNull()
    expect(missingSourceHint({ intent: 'video', needsSource: false, hasSource: false })).toBeNull()
  })

  it('names the image on the other lanes with a source', () => {
    expect(missingSourceHint({ intent: 'edit', needsSource: true, hasSource: false })).toBe('Add an image first.')
  })
})
