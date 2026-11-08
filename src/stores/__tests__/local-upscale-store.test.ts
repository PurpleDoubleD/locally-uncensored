// Local Enhance Image (3.0.7): the store keeps the tab where it runs and
// closes it where it does not.
//
// Windows and Linux run Enhance on local ComfyUI, so a flip from Cloud to
// Local keeps the tab and its source image. A Mac has no ComfyUI: there the
// tab is a cloud teaser, and the flip closes it like Erase.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const host = vi.hoisted(() => ({ mlx: false }))
vi.mock('../../api/mlx-image', () => ({ isMlxImageHost: () => host.mlx, MLX_MODEL_PREFIX: 'MLX ' }))

import { useCreateStore, LOCAL_UTILITY_OPS } from '../createStore'
import { isIntentAvailable, isIntentLocked, INTENT_MAP, visibleIntents } from '../../components/create/experimental/intents'
import { stageShowsSetupCard, laneModelCount } from '../../components/create/experimental/stageGate'

const st = () => useCreateStore.getState()
const ref = { filename: 'photo.png', url: 'data:image/png;base64,AA', width: 640, height: 480 }

beforeEach(() => {
  host.mlx = false
  useCreateStore.setState({ backend: 'cloud', source: null, mask: null, error: null })
  st().setIntent('image')
})

describe('the backend flip', () => {
  it('Windows and Linux: Enhance stays open with its source', () => {
    st().setIntent('upscale')
    st().setSource(ref)
    st().setBackend('local')
    expect(st().intent()).toBe('upscale')
    expect(st().utilityOp).toBe('upscale')
    expect(st().source?.filename).toBe('photo.png')
  })

  it('and back to the cloud it is still Enhance', () => {
    st().setIntent('upscale')
    st().setBackend('local')
    st().setBackend('cloud')
    expect(st().intent()).toBe('upscale')
  })

  it('Erase still closes, it has no local lane', () => {
    st().setIntent('eraser')
    st().setBackend('local')
    expect(st().utilityOp).toBeNull()
  })

  it('a Mac closes Enhance: no ComfyUI there, the bar shows it as a teaser', () => {
    host.mlx = true
    st().setIntent('upscale')
    st().setSource(ref)
    st().setBackend('local')
    expect(st().utilityOp).toBeNull()
    expect(st().intent()).not.toBe('upscale')
    const shown = visibleIntents('local', true, true)
    expect(shown.find((m) => m.id === st().intent()), 'the tab left open is one the Mac bar shows').toBeTruthy()
    expect(isIntentLocked(INTENT_MAP.upscale, 'local', true)).toBe(true)
  })

  it('the rule is one set, and it names upscale only', () => {
    expect([...LOCAL_UTILITY_OPS]).toEqual(['upscale'])
  })
})

describe('the bar', () => {
  it('Enhance is a working local tab on Windows and Linux, not on a Mac', () => {
    expect(isIntentAvailable('upscale', 'local', false)).toBe(true)
    expect(isIntentAvailable('upscale', 'local', true)).toBe(false)
    expect(isIntentAvailable('eraser', 'local', false)).toBe(false)
  })
})

describe('the factor', () => {
  it('starts at 2x and takes any factor from 1x to 8x', () => {
    expect(st().upscaleFactor).toBe(2)
    st().setUpscaleFactor(4)
    expect(st().upscaleFactor).toBe(4)
    st().setUpscaleFactor(3)
    expect(st().upscaleFactor).toBe(3)
    st().setUpscaleFactor(20)
    expect(st().upscaleFactor).toBe(8)
  })
})

describe('the setup card on the Stage', () => {
  const card = (over: { mlx?: boolean; connected?: boolean | null; models?: string[] }) =>
    stageShowsSetupCard({
      backend: 'local',
      requiresModels: INTENT_MAP.upscale.requiresModels,
      mlxMissing: over.mlx ? { image: false, video: false } : null,
      connected: over.connected === undefined ? true : over.connected,
      modelsLoaded: true,
      laneModelCount: laneModelCount('upscale', INTENT_MAP.upscale.requiresModels, {
        image: [{}], video: [], audio: [], lipsync: [], motion: [], upscale: over.models ?? [],
      }),
    })

  it('offers the download while no upscale model is there', () => {
    expect(card({ models: [] })).toBe(true)
    expect(card({ models: ['RealESRGAN_x4plus.safetensors'] })).toBe(false)
  })

  it('offers it with ComfyUI not running too, the same button installs it', () => {
    expect(card({ connected: false, models: [] })).toBe(true)
    expect(card({ connected: null, models: [] })).toBe(false)
  })

  it('never on a Mac', () => {
    expect(card({ mlx: true, models: [] })).toBe(false)
  })
})
