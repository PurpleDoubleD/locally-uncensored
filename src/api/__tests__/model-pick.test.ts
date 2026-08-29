/**
 * Model-Picker gate (v2.5.3) — executor-side behaviour of
 * pickModelForGeneration: explicit model wins, saved preference is silent,
 * otherwise the pick request goes through useModelPickStore and the save
 * icon persists the choice. Filtering mirrors the decide phase (I2V vs T2V).
 *
 * Run: npx vitest run src/api/__tests__/model-pick.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return { ...actual, getImageModels: vi.fn(), getVideoModels: vi.fn() }
})

import { pickModelForGeneration, chooseFromUserSelection } from '../model-pick'
import { getImageModels, getVideoModels } from '../comfyui'
import { useModelPickStore } from '../../stores/modelPickStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCreateStore } from '../../stores/createStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'

const IMAGE_MODELS = [
  { name: 'Juggernaut-XL_v9.safetensors', type: 'sdxl', source: 'checkpoint' },
  { name: 'RealVisXL_V5.safetensors', type: 'sdxl', source: 'checkpoint' },
] as never

const VIDEO_MODELS = [
  { name: 'svd_xt_1_1.safetensors', type: 'svd', source: 'checkpoint' },
  { name: 'wan2.1_t2v_1.3B_bf16.safetensors', type: 'wan', source: 'diffusion_model' },
  { name: 'FramePackI2V_HY_fp8_e4m3fn.safetensors', type: 'framepack', source: 'diffusion_model' },
  // Dual T2V/I2V (live find 2026-06-11: the old !isI2VModel negation hid it
  // from the T2V picker even though it text-to-videos natively).
  { name: 'wan2.2_ti2v_5B_fp16.safetensors', type: 'wan22', source: 'diffusion_model' },
] as never

/** Resolve the pending pick from the "UI side" as soon as it appears. */
async function answerPick(choice: { model: string; save: boolean } | null) {
  await vi.waitFor(() => {
    if (!useModelPickStore.getState().pending) throw new Error('no pending pick yet')
  })
  if (choice) useModelPickStore.getState().choose(choice)
  else useModelPickStore.getState().cancel()
}

beforeEach(() => {
  vi.mocked(getImageModels).mockResolvedValue(IMAGE_MODELS)
  vi.mocked(getVideoModels).mockResolvedValue(VIDEO_MODELS)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  // The Create tab selection is the first source the gate reads, so every
  // pre-existing case has to start from "nothing chosen in Create".
  useCreateStore.setState({ imageModel: '', imageModelType: 'unknown', videoModel: '' })
  // No pending pick leaks between tests.
  if (useModelPickStore.getState().pending) useModelPickStore.getState().cancel()
})

describe('pickModelForGeneration — image', () => {
  it('explicit model arg wins: no picker, returns null', async () => {
    const result = await pickModelForGeneration('image', { model: 'RealVisXL_V5.safetensors' })
    expect(result).toBeNull()
    expect(useModelPickStore.getState().pending).toBeNull()
  })

  it('saved + installed preference is used silently (no picker)', async () => {
    useSettingsStore.getState().updateSettings({ preferredImageModel: 'RealVisXL_V5.safetensors' })
    const result = await pickModelForGeneration('image', {})
    expect(result).toBe('RealVisXL_V5.safetensors')
    expect(useModelPickStore.getState().pending).toBeNull()
  })

  it('no saved preference → picker; choice without save is NOT persisted', async () => {
    const p = pickModelForGeneration('image', {})
    await answerPick({ model: 'RealVisXL_V5.safetensors', save: false })
    expect(await p).toBe('RealVisXL_V5.safetensors')
    expect(useSettingsStore.getState().settings.preferredImageModel).toBe('')
  })

  it('save icon persists the choice for future prompts', async () => {
    const p = pickModelForGeneration('image', {})
    await answerPick({ model: 'Juggernaut-XL_v9.safetensors', save: true })
    expect(await p).toBe('Juggernaut-XL_v9.safetensors')
    expect(useSettingsStore.getState().settings.preferredImageModel).toBe('Juggernaut-XL_v9.safetensors')
  })

  it('saved-but-uninstalled preference re-opens the picker', async () => {
    useSettingsStore.getState().updateSettings({ preferredImageModel: 'gone.safetensors' })
    const p = pickModelForGeneration('image', {})
    await answerPick({ model: 'Juggernaut-XL_v9.safetensors', save: false })
    expect(await p).toBe('Juggernaut-XL_v9.safetensors')
  })

  it('timeout/cancel falls back to the pre-selection (first installed)', async () => {
    const p = pickModelForGeneration('image', {})
    await answerPick(null)
    expect(await p).toBe('Juggernaut-XL_v9.safetensors')
  })

  it('ComfyUI unreachable → null (existing pipeline reports)', async () => {
    vi.mocked(getImageModels).mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await pickModelForGeneration('image', {})).toBeNull()
  })

  it('no models installed → null (existing no-model error path)', async () => {
    vi.mocked(getImageModels).mockResolvedValue([] as never)
    expect(await pickModelForGeneration('image', {})).toBeNull()
  })
})

describe('pickModelForGeneration — video T2V vs I2V', () => {
  it('text-to-video offers T2V-capable models (incl. dual Wan 2.2) and uses the T2V pref key', async () => {
    const p = pickModelForGeneration('video', {})
    await vi.waitFor(() => {
      if (!useModelPickStore.getState().pending) throw new Error('no pending')
    })
    const pending = useModelPickStore.getState().pending!
    expect(pending.kind).toBe('video-t2v')
    // Wan 2.2 TI2V is dual-capable → it belongs in the T2V list too; the
    // I2V-only checkpoints (SVD/FramePack) stay excluded.
    expect(pending.models.sort()).toEqual(['wan2.1_t2v_1.3B_bf16.safetensors', 'wan2.2_ti2v_5B_fp16.safetensors'])
    useModelPickStore.getState().choose({ model: 'wan2.1_t2v_1.3B_bf16.safetensors', save: true })
    expect(await p).toBe('wan2.1_t2v_1.3B_bf16.safetensors')
    expect(useSettingsStore.getState().settings.preferredVideoT2VModel).toBe('wan2.1_t2v_1.3B_bf16.safetensors')
    expect(useSettingsStore.getState().settings.preferredVideoI2VModel).toBe('')
  })

  it('image-to-video offers I2V-capable models (SVD/FramePack/Wan 2.2) and the I2V pref key', async () => {
    const p = pickModelForGeneration('video', { inputImage: 'ComfyUI_0001.png' })
    await vi.waitFor(() => {
      if (!useModelPickStore.getState().pending) throw new Error('no pending')
    })
    const pending = useModelPickStore.getState().pending!
    expect(pending.kind).toBe('video-i2v')
    expect(pending.models.sort()).toEqual(['FramePackI2V_HY_fp8_e4m3fn.safetensors', 'svd_xt_1_1.safetensors', 'wan2.2_ti2v_5B_fp16.safetensors'])
    useModelPickStore.getState().choose({ model: 'svd_xt_1_1.safetensors', save: true })
    expect(await p).toBe('svd_xt_1_1.safetensors')
    expect(useSettingsStore.getState().settings.preferredVideoI2VModel).toBe('svd_xt_1_1.safetensors')
  })

  it('the snake_case input_image alias classifies as I2V too', async () => {
    const p = pickModelForGeneration('video', { input_image: 'x.png' })
    await vi.waitFor(() => {
      if (!useModelPickStore.getState().pending) throw new Error('no pending')
    })
    expect(useModelPickStore.getState().pending!.kind).toBe('video-i2v')
    useModelPickStore.getState().cancel()
    await p
  })

  it('separate saved T2V/I2V preferences never cross', async () => {
    useSettingsStore.getState().updateSettings({
      preferredVideoT2VModel: 'wan2.1_t2v_1.3B_bf16.safetensors',
      preferredVideoI2VModel: 'svd_xt_1_1.safetensors',
    })
    expect(await pickModelForGeneration('video', {})).toBe('wan2.1_t2v_1.3B_bf16.safetensors')
    expect(await pickModelForGeneration('video', { inputImage: 'a.png' })).toBe('svd_xt_1_1.safetensors')
  })
})

/**
 * Runde 4, Nebenbefund N1 of the D1 counter-check (Windows build 2026-08-29):
 * `image_generate` with an empty `model` argument built a Realistic Vision
 * graph while the Create tab was set to Z-Image. The Create tab is the model
 * choice the user can see, so it is the first source now.
 */
describe('pickModelForGeneration, the Create tab selection is the default', () => {
  beforeEach(() => {
    useCreateStore.setState({ imageModel: '', imageModelType: 'unknown', videoModel: '' })
  })

  it('image: the Create tab model wins over the automatic pick, no picker card', async () => {
    useCreateStore.getState().setImageModel('RealVisXL_V5.safetensors', 'sdxl')
    const result = await pickModelForGeneration('image', {})
    expect(result).toBe('RealVisXL_V5.safetensors')
    expect(useModelPickStore.getState().pending).toBeNull()
  })

  it('image: the Create tab model also wins over the saved picker preference', async () => {
    useSettingsStore.getState().updateSettings({ preferredImageModel: 'Juggernaut-XL_v9.safetensors' })
    useCreateStore.getState().setImageModel('RealVisXL_V5.safetensors', 'sdxl')
    expect(await pickModelForGeneration('image', {})).toBe('RealVisXL_V5.safetensors')
  })

  it('image: an explicit model argument still beats the Create tab', async () => {
    useCreateStore.getState().setImageModel('RealVisXL_V5.safetensors', 'sdxl')
    const result = await pickModelForGeneration('image', { model: 'Juggernaut-XL_v9.safetensors' })
    expect(result).toBeNull()
    expect(useModelPickStore.getState().pending).toBeNull()
  })

  it('video: the Create tab model answers a text-to-video call', async () => {
    useCreateStore.getState().setVideoModel('wan2.1_t2v_1.3B_bf16.safetensors')
    expect(await pickModelForGeneration('video', {})).toBe('wan2.1_t2v_1.3B_bf16.safetensors')
  })

  // ── Negative controls: nothing chosen, or a choice that cannot serve this
  //    call, and the old automation has to run untouched. ──
  it('negative control: no Create selection leaves the saved preference in charge', async () => {
    useSettingsStore.getState().updateSettings({ preferredImageModel: 'Juggernaut-XL_v9.safetensors' })
    expect(await pickModelForGeneration('image', {})).toBe('Juggernaut-XL_v9.safetensors')
  })

  it('negative control: an uninstalled Create selection re-opens the picker', async () => {
    useCreateStore.getState().setImageModel('deleted-last-week.safetensors', 'sdxl')
    const p = pickModelForGeneration('image', {})
    await answerPick({ model: 'Juggernaut-XL_v9.safetensors', save: false })
    expect(await p).toBe('Juggernaut-XL_v9.safetensors')
  })

  it('negative control: a T2V-only Create selection does not hijack image-to-video', async () => {
    useCreateStore.getState().setVideoModel('wan2.1_t2v_1.3B_bf16.safetensors')
    const p = pickModelForGeneration('video', { inputImage: 'a.png' })
    await answerPick({ model: 'svd_xt_1_1.safetensors', save: false })
    expect(await p).toBe('svd_xt_1_1.safetensors')
  })

  it('negative control: nothing chosen anywhere still ends at the picker card', async () => {
    const p = pickModelForGeneration('image', {})
    await answerPick({ model: 'RealVisXL_V5.safetensors', save: false })
    expect(await p).toBe('RealVisXL_V5.safetensors')
  })
})

describe('chooseFromUserSelection', () => {
  const names = ['a.safetensors', 'b.safetensors']

  it('prefers the Create tab choice', () => {
    expect(chooseFromUserSelection(names, 'b.safetensors', 'a.safetensors')).toBe('b.safetensors')
  })

  it('falls back to the saved preference when Create has none', () => {
    expect(chooseFromUserSelection(names, '', 'a.safetensors')).toBe('a.safetensors')
  })

  it('falls back to the saved preference when the Create choice is not installed', () => {
    expect(chooseFromUserSelection(names, 'gone.safetensors', 'a.safetensors')).toBe('a.safetensors')
  })

  it('returns null when neither choice is usable', () => {
    expect(chooseFromUserSelection(names, 'gone.safetensors', 'also-gone.safetensors')).toBeNull()
    expect(chooseFromUserSelection(names, undefined, undefined)).toBeNull()
    expect(chooseFromUserSelection([], 'a.safetensors', 'b.safetensors')).toBeNull()
  })
})
