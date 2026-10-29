/**
 * Qwen-Image 2.1 Turbo on ComfyUI (Discord, 28.10.2026): picking the file
 * puts the sliders at what its official template runs, 8 steps, CFG 1, euler.
 * The full 2.1 model keeps its own 25 steps.
 *
 * Run: npx vitest run src/stores/__tests__/qwen21-turbo-starts-at-eight-steps.test.ts
 */
import { describe, it, expect } from 'vitest'
import { useCreateStore, MODEL_TYPE_DEFAULTS, imageQualityLadder } from '../createStore'

const TURBO = 'qwen_image_2.1_turbo_int8_convrot.safetensors'
const NORMAL = 'qwen_image_2.1_int8_convrot.safetensors'

describe('picking Qwen-Image 2.1 Turbo', () => {
  it('sets 8 steps, CFG 1, euler', () => {
    useCreateStore.setState({ backend: 'local', steps: 30, cfgScale: 5, sampler: 'dpmpp_2m' } as never)
    useCreateStore.getState().setImageModel(TURBO, 'qwenimage')
    expect(useCreateStore.getState()).toMatchObject({ steps: 8, cfgScale: 1, sampler: 'euler', width: 1024, height: 1024 })
  })

  it('the community spelling too', () => {
    useCreateStore.getState().setImageModel('Qwen-Image-2.1-Turbo-Q8_0.gguf', 'qwenimage')
    expect(useCreateStore.getState()).toMatchObject({ steps: 8, cfgScale: 1, sampler: 'euler' })
  })

  it('back to the full model, its own 25 steps', () => {
    useCreateStore.getState().setImageModel(TURBO, 'qwenimage')
    useCreateStore.getState().setImageModel(NORMAL, 'qwenimage')
    const d = MODEL_TYPE_DEFAULTS.qwenimage
    expect(useCreateStore.getState()).toMatchObject({ steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler, scheduler: d.scheduler })
    expect(d.steps).toBe(25)
  })

  it('Reset to model defaults goes back to 8 steps and CFG 1', () => {
    useCreateStore.setState({ backend: 'local', mode: 'image' } as never)
    useCreateStore.getState().setImageModel(TURBO, 'qwenimage')
    useCreateStore.setState({ steps: 40, cfgScale: 4, sampler: 'dpmpp_2m' })
    useCreateStore.getState().resetParamsToModelDefaults()
    expect(useCreateStore.getState()).toMatchObject({ steps: 8, cfgScale: 1, sampler: 'euler' })
  })

  it('the Quality buttons measure from 8 and hold CFG at 1', () => {
    const ladder = imageQualityLadder({ backend: 'local', imageModel: TURBO, imageModelType: 'qwenimage' })
    expect(ladder.steps.Standard).toBe(8)
    expect(ladder.cfgScale).toBe(1)
  })

  it('COUNTER-CHECK: the Mac pack of the same name keeps the family values', () => {
    useCreateStore.getState().setImageModel('MLX Qwen-Image 2.1 Turbo 8-bit', 'qwenimage')
    expect(useCreateStore.getState().steps).toBe(MODEL_TYPE_DEFAULTS.qwenimage.steps)
  })
})
