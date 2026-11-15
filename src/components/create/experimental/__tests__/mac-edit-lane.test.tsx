// @vitest-environment jsdom
/**
 * Edit / Image to Image on the Mac (08.10.2026). Windows edits with
 * Qwen-Image 2.1: the image on the Stage, up to nine references under it and
 * a prompt, no mask. The Mac runs the same model on its second image engine,
 * so it gets the same tab with the same surface. What these cases hold:
 *
 *   the tab is local on a Mac only while an installed model takes an image,
 *   Edit lists those models and switches a pick that cannot edit,
 *   the reference strip is the one Windows shows,
 *   and what the engine cannot do is not on the surface: no mask, no edit
 *   strength, and no steps or CFG for a pack that runs at its own.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/mac-edit-lane.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const io = vi.hoisted(() => ({ mac: true }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => io.mac, MLX_MODEL_PREFIX: 'MLX ' }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), connected: true, modelsLoaded: true,
    cloudAvailable: true, uploadImage: vi.fn(), installCapability: vi.fn(),
  }),
}))

import { isIntentAvailable, isIntentLocked, visibleIntents, INTENT_MAP } from '../intents'
import { laneModelCount } from '../stageGate'
import { ParamGroups } from '../ParamGroups'
import { Stage } from '../Stage'
import { ReferenceStrip } from '../ReferenceStrip'
import { useCreateStore, deriveIntent, MODEL_TYPE_DEFAULTS } from '../../../../stores/createStore'
import type { ClassifiedModel } from '../../../../api/comfyui'

const mlx = (name: string, type: ClassifiedModel['type'], editImages: number, ownSampling?: true): ClassifiedModel =>
  ({ name, type, source: 'checkpoint', editImages, ...(ownSampling ? { ownSampling } : {}) })
const SDTURBO = mlx('MLX SD Turbo', 'sd15', 0)
const ZIMAGE = mlx('MLX Z-Image Turbo 4-bit', 'zimage', 0, true)
const QWEN = mlx('MLX Qwen-Image 2.1 8-bit', 'qwenimage', 10)
const TURBO = mlx('MLX Qwen-Image 2.1 Turbo 8-bit', 'qwenimage', 10, true)
const BILD = { filename: '/data/videos/start-images/a.png', url: 'data:image/png;base64,AA', width: 1600, height: 900 }

function arrange(list: ClassifiedModel[], pick: ClassifiedModel) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], cloudOp: null, utilityOp: null, removebg: false,
    mode: 'image', imageSubMode: 'text2img', source: null, mask: null, references: [], batchSources: [],
    imageModelList: list, videoModelList: [],
    // No ComfyUI on the Mac, so none of its nodes was ever found.
    caps: { rmbg: false, 'inpaint-nodes': !io.mac, dwpose: false },
  } as never)
  useCreateStore.getState().setImageModel(pick.name, pick.type)
}
const intent = () => deriveIntent(useCreateStore.getState())

beforeEach(() => { io.mac = true })
afterEach(() => cleanup())

describe('Edit is a local tab on the Mac while a model takes an image', () => {
  it('shows it with such a model and not without', () => {
    const ids = (mlxEdit: boolean) => visibleIntents('local', true, true, false, mlxEdit).map((m) => m.id)
    expect(ids(false)).not.toContain('edit')
    expect(ids(true)).toContain('edit')
    expect(isIntentLocked(INTENT_MAP.edit, 'local', true, false, true)).toBe(false)
    expect(isIntentLocked(INTENT_MAP.edit, 'local', true, false, false)).toBe(true)
    expect(isIntentAvailable('edit', 'local', true, false, true)).toBe(true)
    expect(isIntentAvailable('edit', 'local', true, false, false)).toBe(false)
    // The cutout runs on Vision on every Mac, with or without it.
    expect(ids(true)).toContain('removebg')
    expect(ids(false)).toContain('removebg')
    // Windows and Linux do not ask: the tab is always there.
    expect(visibleIntents('local', false, true).map((m) => m.id)).toContain('edit')
    expect(isIntentAvailable('edit', 'local', false)).toBe(true)
  })

  it('counts only the models that edit for the setup card', () => {
    const lists = { image: [SDTURBO, ZIMAGE, QWEN], video: [], audio: [], lipsync: [], motion: [] }
    expect(laneModelCount('edit', 'image', lists)).toBe(1)
    expect(laneModelCount('image', 'image', lists)).toBe(3)
    // A ComfyUI list is counted whole on every tab.
    const comfy = { ...lists, image: [{ name: 'sdxl.safetensors' }, { name: 'flux.safetensors' }] }
    expect(laneModelCount('edit', 'image', comfy)).toBe(2)
  })

  it('a pick that cannot edit gives way to the first that can, with its own values', () => {
    arrange([SDTURBO, ZIMAGE, QWEN, TURBO], SDTURBO)
    expect(useCreateStore.getState().steps).not.toBe(MODEL_TYPE_DEFAULTS.qwenimage.steps)
    useCreateStore.getState().setIntent('edit')
    const s = useCreateStore.getState()
    expect(intent()).toBe('edit')
    expect(s.imageModel).toBe(QWEN.name)
    expect(s.imageModelType).toBe('qwenimage')
    // Where Windows opens Qwen-Image 2.1: 25 steps and CFG 1.0. The canvas
    // is 1056 and not Windows' 1024: on the Mac the model does not edit on
    // 1024 x 1024 and the engine runs 1056 (real run, 09.10.2026).
    expect([s.steps, s.cfgScale, s.width, s.height]).toEqual([25, 1.0, 1056, 1056])
  })

  it('a pick that edits is kept', () => {
    arrange([SDTURBO, QWEN, TURBO], TURBO)
    useCreateStore.getState().setIntent('edit')
    expect(useCreateStore.getState().imageModel).toBe(TURBO.name)
  })

  it('COUNTER-CHECK: a ComfyUI list keeps its pick on Edit', () => {
    io.mac = false
    const SDXL: ClassifiedModel = { name: 'sdxl_base.safetensors', type: 'sdxl', source: 'checkpoint' }
    const Q21: ClassifiedModel = { name: 'qwen_image_2.1_int8_convrot.safetensors', type: 'qwenimage', source: 'diffusion_model' }
    arrange([SDXL, Q21], SDXL)
    const before = useCreateStore.getState()
    useCreateStore.getState().setIntent('edit')
    const s = useCreateStore.getState()
    expect(s.imageModel).toBe(SDXL.name)
    expect([s.steps, s.cfgScale, s.sampler]).toEqual([before.steps, before.cfgScale, before.sampler])
  })

  it('the switch to local keeps Edit with such a model, drops a mask, and falls back to Image without one', () => {
    arrange([SDTURBO, QWEN], SDTURBO)
    useCreateStore.setState({ backend: 'cloud' })
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ mask: BILD } as never)
    useCreateStore.getState().setBackend('local')
    expect(intent()).toBe('edit')
    expect(useCreateStore.getState().imageModel).toBe(QWEN.name)
    expect(useCreateStore.getState().mask).toBeNull()

    arrange([SDTURBO, ZIMAGE], SDTURBO)
    useCreateStore.setState({ backend: 'cloud' })
    useCreateStore.getState().setIntent('edit')
    useCreateStore.getState().setBackend('local')
    expect(intent()).toBe('image')
  })

  it('removing the last model that edits takes the tab back to Image', () => {
    arrange([SDTURBO, QWEN], QWEN)
    useCreateStore.getState().setIntent('edit')
    useCreateStore.getState().setImageModelList([SDTURBO, QWEN])
    expect(intent()).toBe('edit')
    useCreateStore.getState().setImageModelList([SDTURBO])
    expect(intent()).toBe('image')
    // On a ComfyUI host the list never decides that.
    io.mac = false
    useCreateStore.getState().setIntent('edit')
    useCreateStore.getState().setImageModelList([])
    expect(intent()).toBe('edit')
  })
})

describe('the surface of the Mac\'s Edit is the one Windows has, less what the engine cannot do', () => {
  function onEdit(pick: ClassifiedModel) {
    arrange([SDTURBO, ZIMAGE, QWEN, TURBO], pick)
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ source: BILD } as never)
  }

  it('offers the reference strip with nine more images, as for Qwen-Image 2.1 on Windows (mflux reads ten)', () => {
    onEdit(QWEN)
    render(<ReferenceStrip />)
    expect(screen.getByTestId('reference-strip')).toBeTruthy()
    useCreateStore.setState({ references: Array(9).fill(BILD) } as never)
    cleanup()
    render(<ReferenceStrip />)
    // Nine are in: no room for a tenth.
    expect(screen.getByTestId('reference-strip').querySelectorAll('img')).toHaveLength(9)
    expect(screen.queryByText(/Reference/)).toBeNull()
    // The Mac keeps its canvas, so it does not say the edit comes out smaller.
    expect(screen.getByText('Name them in the prompt as image 2 to image 10. The image above is image 1. With this many images, say what each one brings, for example "the scarf from image 3".')).toBeTruthy()
  })

  it('takes a painted mask and asks for no ComfyUI node: the button is there, no install card', () => {
    onEdit(QWEN)
    render(<Stage displayed={undefined} onOpenMaskEditor={vi.fn()} onEditResult={vi.fn()} onAnimateResult={vi.fn()} onFullscreen={vi.fn()} />)
    // mflux 0.22.0 paints under a mask over the first image (--mask-image).
    expect(screen.getByText('Paint mask')).toBeTruthy()
    expect(screen.queryByText(/needs no mask/)).toBeNull()
    expect(screen.queryByText(/ComfyUI/)).toBeNull()
  })

  it('COUNTER-CHECK: the local Edit on Windows keeps Paint mask', () => {
    io.mac = false
    const SDXL: ClassifiedModel = { name: 'sdxl_base.safetensors', type: 'sdxl', source: 'checkpoint' }
    arrange([SDXL], SDXL)
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ source: BILD } as never)
    render(<Stage displayed={undefined} onOpenMaskEditor={vi.fn()} onEditResult={vi.fn()} onAnimateResult={vi.fn()} onFullscreen={vi.fn()} />)
    expect(screen.getByText('Paint mask')).toBeTruthy()
    expect(screen.queryByText(/needs no mask/)).toBeNull()
  })

  it('shows Steps and CFG for Qwen-Image 2.1, and neither for the Turbo pack', () => {
    onEdit(QWEN)
    const q = render(<ParamGroups />)
    expect(screen.getByText('Steps')).toBeTruthy()
    expect(screen.getByText('CFG scale')).toBeTruthy()
    // What the engine has no flag for is not offered. W32: Batch size neither,
    // the Mac makes one image per run; the count is the chip next to Create.
    for (const label of ['Sampler', 'Scheduler', 'VAE', 'Skip CLIP layers', 'Denoise (raw)', 'Mask edge feather', 'Batch size']) {
      expect(screen.queryByText(label), label).toBeNull()
    }
    // Since 3.0.8 Edit has Native HiRes on the Mac too: a second edit of the
    // edited picture at the larger size (Discord feature request 21.10.2026).
    expect(screen.getByText('Native HiRes')).toBeTruthy()
    q.unmount()

    onEdit(TURBO)
    render(<ParamGroups />)
    expect(screen.queryByText('Steps')).toBeNull()
    expect(screen.queryByText('CFG scale')).toBeNull()
    expect(screen.getByText('Width')).toBeTruthy()
  })

  it('COUNTER-CHECK: the same panel on Windows keeps every slider', () => {
    io.mac = false
    const Q21: ClassifiedModel = { name: 'qwen_image_2.1_int8_convrot.safetensors', type: 'qwenimage', source: 'diffusion_model' }
    arrange([Q21], Q21)
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ expertOpen: true } as never)
    render(<ParamGroups />)
    for (const label of ['Steps', 'CFG scale', 'Batch size', 'Sampler', 'Scheduler', 'Mask edge feather', 'VAE', 'Skip CLIP layers']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
    // The Qwen-Image 2.1 edit samples at denoise 1.0 through ComfyUI too, so
    // the raw denoise is not offered there either (Discord #general 23.10.2026).
    expect(screen.queryByText('Denoise (raw)')).toBeNull()
  })
})
