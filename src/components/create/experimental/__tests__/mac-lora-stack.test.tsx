// @vitest-environment jsdom
/**
 * The LoRA stack in Create on the Mac (09.10.2026). Windows has it in
 * Advanced settings, Expert. The Mac had no Expert section at all, because
 * nothing in it reached its engines. Its second image engine takes LoRAs, so
 * for a model of that engine the section is back with the stack in it and
 * nothing else. What these cases hold:
 *
 *   the stack stands for a model of the second engine, in Image and in Edit,
 *   it does not for a model of the first engine or in the cloud,
 *   for video it stands for the models whose engine takes `--lora` (since
 *   14.10.2026, see the last block),
 *   it is handled as on Windows: tick, strength, untick, Clear, Rescan,
 *   it names the Mac's folder and opens it, and never ComfyUI,
 *   and Windows shows what it showed before.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/mac-lora-stack.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const io = vi.hoisted(() => ({ mac: true, loras: [] as string[], keys: {} as Record<string, 'peft' | 'kohya' | 'other' | 'unreadable'>, alpha: {} as Record<string, 'none' | 'uniform' | 'mixed'>, refresh: vi.fn(), open: vi.fn(async () => {}) }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => io.mac, MLX_MODEL_PREFIX: 'MLX ' }))
vi.mock('../../../../api/mlx-loras', async (original) => ({ ...(await original<typeof import('../../../../api/mlx-loras')>()), openMlxLoraFolder: () => io.open() }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: io.loras, loraKeys: io.keys, loraAlpha: io.alpha, vaeList: [], refreshModelLists: io.refresh,
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { useCreateStore } from '../../../../stores/createStore'
import type { ClassifiedModel } from '../../../../api/comfyui'

const mlx = (name: string, type: ClassifiedModel['type'], extra: Partial<ClassifiedModel> = {}): ClassifiedModel =>
  ({ name, type, source: 'checkpoint', editImages: 0, ...extra })
/** The first engine (diffusers): no place for a LoRA. */
const SDTURBO = mlx('MLX SD Turbo', 'sd15')
const QWEN = mlx('MLX Qwen-Image 2.1 8-bit', 'qwenimage', { editImages: 10, mlxLoras: true })
const TURBO = mlx('MLX Qwen-Image 2.1 Turbo 8-bit', 'qwenimage', { editImages: 10, ownSampling: true, mlxLoras: true })
const ZIMAGE = mlx('MLX Z-Image Turbo 4-bit', 'zimage', { ownSampling: true, mlxLoras: true })
const BILD = { filename: '/data/videos/start-images/a.png', url: 'data:image/png;base64,AA', width: 1600, height: 900 }
const DETAIL = 'qwen/detail.safetensors'
const SLIDER = 'slider.safetensors'

function arrange(pick: ClassifiedModel, intent: 'image' | 'edit' = 'image') {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], cloudOp: null, utilityOp: null, removebg: false,
    mode: 'image', imageSubMode: 'text2img', source: null, mask: null, references: [], batchSources: [],
    imageModelList: [SDTURBO, ZIMAGE, QWEN, TURBO], videoModelList: [],
    caps: { rmbg: false, 'inpaint-nodes': !io.mac, dwpose: false },
    selectedLoras: [], loraStrengths: {}, expertOpen: true,
  } as never)
  useCreateStore.getState().setImageModel(pick.name, pick.type)
  if (intent === 'edit') {
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ source: BILD } as never)
  }
  useCreateStore.setState({ expertOpen: true } as never)
}
const stack = () => useCreateStore.getState().selectedLoras

beforeEach(() => { io.mac = true; io.loras = [DETAIL, SLIDER]; io.keys = {}; io.alpha = {}; io.refresh.mockClear(); io.open.mockClear() })
afterEach(() => cleanup())

describe('where the Mac shows the LoRA stack', () => {
  it('for a model of the second engine, in Image and in Edit, with nothing else in Expert', () => {
    for (const [pick, intent] of [[QWEN, 'image'], [QWEN, 'edit'], [TURBO, 'image'], [TURBO, 'edit'], [ZIMAGE, 'image']] as const) {
      arrange(pick, intent)
      render(<ParamGroups />)
      expect(screen.getByText('Expert'), `${pick.name} ${intent}`).toBeTruthy()
      expect(screen.getByText(/^LoRA stack/), `${pick.name} ${intent}`).toBeTruthy()
      expect(screen.getByRole('button', { name: /qwen\/detail/ })).toBeTruthy()
      // What the engine has no flag for stays away.
      for (const label of ['Sampler', 'Scheduler', 'VAE', 'Skip CLIP layers', 'Denoise (raw)', 'Text encoder']) {
        expect(screen.queryByText(label), `${label} for ${pick.name} ${intent}`).toBeNull()
      }
      // Edit has two of its own: the strength and the soft edge of a mask
      // (--strength, --mask-image). Image has neither.
      for (const label of ['Edit strength', 'Mask edge feather']) {
        if (intent === 'edit') expect(screen.getByText(label), `${label} for ${pick.name}`).toBeTruthy()
        else expect(screen.queryByText(label), `${label} for ${pick.name} image`).toBeNull()
      }
      cleanup()
    }
  })

  it('not for a model of the first engine: no stack and no Expert section', () => {
    arrange(SDTURBO)
    render(<ParamGroups />)
    expect(screen.queryByText('Expert')).toBeNull()
    expect(screen.queryByText(/LoRA stack/)).toBeNull()
  })

  it('not for a list that does not say so (a backend from before the stack)', () => {
    arrange(QWEN)
    useCreateStore.setState({ imageModelList: [{ ...QWEN, mlxLoras: undefined }] } as never)
    render(<ParamGroups />)
    expect(screen.queryByText(/LoRA stack/)).toBeNull()
  })

  it('not for local video and not in the cloud', () => {
    arrange(QWEN)
    useCreateStore.setState({ mode: 'video' } as never)
    useCreateStore.getState().setIntent('video')
    render(<ParamGroups />)
    expect(screen.queryByText(/LoRA stack/)).toBeNull()
    cleanup()

    arrange(QWEN)
    useCreateStore.setState({ backend: 'cloud' } as never)
    render(<ParamGroups />)
    expect(screen.queryByText(/LoRA stack/)).toBeNull()
    expect(screen.queryByText('Expert')).toBeNull()
  })
})

describe('the stack is handled as on Windows', () => {
  it('tick adds in the order of the clicks, the strength is a number, untick removes', () => {
    arrange(QWEN)
    render(<ParamGroups />)
    fireEvent.click(screen.getByRole('button', { name: /slider/ }))
    fireEvent.click(screen.getByRole('button', { name: /qwen\/detail/ }))
    expect(stack().map((l) => l.name)).toEqual([SLIDER, DETAIL])
    expect(screen.getByText('· 2 active')).toBeTruthy()

    const strength = screen.getByRole('textbox', { name: 'Strength of slider' }) as HTMLInputElement
    fireEvent.change(strength, { target: { value: '-4' } })
    fireEvent.blur(strength)
    expect(stack()[0]).toEqual({ name: SLIDER, strength: -4 })
    expect(strength.value).toBe('-4.00')

    fireEvent.click(screen.getByRole('button', { name: /^slider/ }))
    expect(stack().map((l) => l.name)).toEqual([DETAIL])
    expect(screen.getByText('· 1 active')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(stack()).toEqual([])
    expect(screen.queryByText(/active/)).toBeNull()
  })

  it('Rescan reads the folder again and Open folder shows it in Finder', () => {
    arrange(QWEN)
    render(<ParamGroups />)
    fireEvent.click(screen.getByRole('button', { name: /Rescan/ }))
    expect(io.refresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /Open folder/ }))
    expect(io.open).toHaveBeenCalledTimes(1)
  })

  it('an empty folder says where the files go, and never names ComfyUI', () => {
    io.loras = []
    arrange(QWEN)
    render(<ParamGroups />)
    expect(screen.getByText(/Put \.safetensors files into the LoRA folder/)).toBeTruthy()
    expect(screen.queryByText(/ComfyUI/)).toBeNull()
    expect(screen.getByRole('button', { name: /Rescan/ }).getAttribute('title')).toBe('Read the LoRA folder again')
  })

  it('a Z-Image character is offered to Z-Image and says "Z-Image only" on Qwen-Image 2.1', () => {
    io.loras = ['char_mira_zimage.safetensors']
    arrange(QWEN)
    render(<ParamGroups />)
    expect(screen.getByRole('button', { name: /char_mira_zimage/ }).textContent).toContain('Z-Image only')
    cleanup()
    arrange(ZIMAGE)
    render(<ParamGroups />)
    expect(screen.getByRole('button', { name: /char_mira_zimage/ }).textContent).toContain('off')
  })
})

describe('COUNTER-CHECK: Windows and Linux show what they showed before', () => {
  const Q21: ClassifiedModel = { name: 'qwen_image_2.1_int8_convrot.safetensors', type: 'qwenimage', source: 'diffusion_model' }

  it('the whole Expert section with ComfyUI\'s words, and no Open folder', () => {
    io.mac = false
    io.loras = []
    arrange(Q21, 'edit')
    useCreateStore.setState({ imageModelList: [Q21] } as never)
    useCreateStore.getState().setImageModel(Q21.name, Q21.type)
    render(<ParamGroups />)
    for (const label of ['Sampler', 'Scheduler', 'Mask edge feather', 'VAE', 'Skip CLIP layers']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
    // The Qwen-Image 2.1 edit samples at denoise 1.0, so the slider that set
    // nothing is gone (Discord #general 23.10.2026).
    expect(screen.queryByText('Denoise (raw)')).toBeNull()
    expect(screen.getByText(/Drop \.safetensors files into ComfyUI's models\/loras folder and hit Rescan/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rescan/ }).getAttribute('title')).toBe("Re-scan ComfyUI's models/loras folder")
    expect(screen.queryByRole('button', { name: /Open folder/ })).toBeNull()
    expect(io.open).not.toHaveBeenCalled()
  })

  it('a model that carries the Mac\'s mark changes nothing there', () => {
    // The mark is only read on a Mac. Even a list that had it keeps the
    // ComfyUI stack on a ComfyUI host.
    io.mac = false
    arrange(QWEN)
    render(<ParamGroups />)
    expect(screen.getByText('Sampler')).toBeTruthy()
    expect(screen.getByText(/^LoRA stack/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open folder/ })).toBeNull()
  })
})

/**
 * Review of the LoRA stack with the eyes of the persona walk (09.10.2026).
 * The Model Manager said "Kohya format. Qwen-Image 2.1 does not read it" and
 * "Not a readable safetensors file", the stack in Create offered both files
 * as plain "off" rows, and the run refused them after the click on Create.
 */
describe('a file the run would refuse says so on its row', () => {
  const KEYS = { [DETAIL]: 'peft', [SLIDER]: 'kohya', 'broken.safetensors': 'unreadable' } as const

  it('Qwen-Image 2.1: a Kohya file and an unreadable file cannot be turned on', () => {
    io.loras = [DETAIL, SLIDER, 'broken.safetensors']
    io.keys = { ...KEYS }
    arrange(QWEN)
    render(<ParamGroups />)
    const refused = screen.getAllByTestId('lora-stack-refused')
    expect(refused.map((r) => r.textContent)).toEqual(['sliderKohya format', 'brokennot readable'])
    fireEvent.click(screen.getByRole('button', { name: /slider/ }))
    fireEvent.click(screen.getByRole('button', { name: /broken/ }))
    expect(stack()).toEqual([])
    expect(screen.getByRole('button', { name: /slider/ }).getAttribute('title')).toContain('lora_A and lora_B')
    // The one that fits is handled as ever.
    fireEvent.click(screen.getByRole('button', { name: /qwen\/detail/ }))
    expect(stack().map((l) => l.name)).toEqual([DETAIL])
  })

  it('a refused file that is still on says so and can be turned off', () => {
    io.keys = { ...KEYS }
    arrange(QWEN)
    useCreateStore.setState({ selectedLoras: [{ name: SLIDER, strength: 0.8 }] } as never)
    render(<ParamGroups />)
    const row = screen.getByRole('button', { name: /slider/ })
    expect(row.textContent).toBe('slideron, Kohya format')
    fireEvent.click(row)
    expect(stack()).toEqual([])
  })

  it('Z-Image reads the Kohya naming: the same file is an ordinary row there', () => {
    io.keys = { ...KEYS }
    arrange(ZIMAGE)
    render(<ParamGroups />)
    expect(screen.queryAllByTestId('lora-stack-refused')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /slider/ }))
    expect(stack().map((l) => l.name)).toEqual([SLIDER])
  })

  it('Qwen-Image 2.1: a file whose layers carry different alphas says under its strength that it runs in full', () => {
    io.keys = { ...KEYS }
    io.alpha = { [DETAIL]: 'mixed', [SLIDER]: 'mixed' }
    arrange(QWEN)
    render(<ParamGroups />)
    // Not before it is on: the note belongs to the strength.
    expect(screen.queryByTestId('lora-alpha-note')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /qwen\/detail/ }))
    expect(screen.getByTestId('lora-alpha-note').textContent).toMatch(/runs every layer at the strength you set/)
    cleanup()
    // One share for every layer goes into the strength of the run, unsaid.
    io.alpha = { [DETAIL]: 'uniform' }
    render(<ParamGroups />)
    expect(stack().map((l) => l.name)).toEqual([DETAIL])
    expect(screen.queryByTestId('lora-alpha-note')).toBeNull()
    cleanup()
    // For Z-Image the engine reads the alpha of a file itself.
    io.alpha = { [DETAIL]: 'mixed', [SLIDER]: 'mixed' }
    arrange(ZIMAGE)
    render(<ParamGroups />)
    fireEvent.click(screen.getByRole('button', { name: /slider/ }))
    expect(stack().map((l) => l.name)).toEqual([SLIDER])
    expect(screen.queryByTestId('lora-alpha-note')).toBeNull()
  })

  it('no label of the stack head breaks in two on the Mac', () => {
    arrange(QWEN)
    render(<ParamGroups />)
    const head = screen.getByText(/^LoRA stack/)
    expect(head.className).toContain('whitespace-nowrap')
    expect(head.parentElement!.className).toContain('flex-wrap')
    expect(head.parentElement!.className).toContain('[&_button]:whitespace-nowrap')
  })

  it('COUNTER-CHECK: Windows asks no folder listing and keeps its head and its rows', () => {
    io.mac = false
    io.keys = { ...KEYS }
    arrange({ ...QWEN, name: 'qwen_image_2.1.safetensors' })
    useCreateStore.setState({ imageModelList: [{ ...QWEN, name: 'qwen_image_2.1.safetensors' }] } as never)
    useCreateStore.getState().setImageModel('qwen_image_2.1.safetensors', 'qwenimage')
    useCreateStore.setState({ expertOpen: true } as never)
    render(<ParamGroups />)
    expect(screen.queryAllByTestId('lora-stack-refused')).toHaveLength(0)
    const head = screen.getByText(/^LoRA stack/)
    expect(head.className).toBe('t-control text-gray-400')
    expect(head.parentElement!.className).toBe('flex items-center justify-between')
    fireEvent.click(screen.getByRole('button', { name: /slider/ }))
    expect(stack().map((l) => l.name)).toEqual([SLIDER])
  })
})

// M12 (14.10.2026): the Mac's video engines take LoRAs too. The quantized LTX
// packs on the second engine and Wan on the first take `--lora` (`loras` of
// their entry, `takes_loras` in video.rs), the first engine's LTX takes none.
// The case "not for local video" above still holds where no such model is
// installed.
describe('the stack for the video models of the Mac', () => {
  const clip = (loras: boolean) => ({ frames: 49, fps: 24, frameStep: 8, width: 768, height: 512, negativePrompt: false, loras })
  const LTXQ = mlx('MLX LTX-2.3 Distilled 4-bit', 'ltx', { startImage: 'optional', mlxVideo: clip(true) })
  const LTX_FIRST = mlx('MLX LTX-2.3 Distilled', 'ltx', { startImage: 'none', mlxVideo: clip(false) })
  const WAN = mlx('MLX Wan 2.1 T2V 1.3B', 'wan', { startImage: 'none', mlxVideo: { ...clip(true), frames: 81, fps: 16, frameStep: 4, width: 832, height: 480 } })

  function arrangeVideo(pick: ClassifiedModel, list: ClassifiedModel[]) {
    arrange(QWEN)
    useCreateStore.setState({ videoModelList: list } as never)
    useCreateStore.getState().setIntent('video')
    useCreateStore.getState().setVideoModel(pick.name)
    useCreateStore.setState({ expertOpen: true } as never)
  }

  it('an LTX pack of the second engine and a Wan show it, with nothing else in Expert', () => {
    for (const pick of [LTXQ, WAN]) {
      arrangeVideo(pick, [LTXQ, LTX_FIRST, WAN])
      render(<ParamGroups />)
      expect(screen.getByText(/^LoRA stack/), pick.name).toBeTruthy()
      expect(screen.getByRole('button', { name: /qwen\/detail/ })).toBeTruthy()
      for (const label of ['Sampler', 'Scheduler', 'VAE', 'Skip CLIP layers', 'Edit strength']) {
        expect(screen.queryByText(label), `${label} for ${pick.name}`).toBeNull()
      }
      cleanup()
    }
  })

  it('COUNTER-CHECK: the first engine\'s LTX shows no stack and no Expert section', () => {
    arrangeVideo(LTX_FIRST, [LTX_FIRST])
    render(<ParamGroups />)
    expect(screen.queryByText(/LoRA stack/)).toBeNull()
    expect(screen.queryByText('Expert')).toBeNull()
  })

  it('LTX refuses a Kohya file on its row, Wan reads it', () => {
    io.keys = { [DETAIL]: 'kohya' }
    arrangeVideo(LTXQ, [LTXQ, WAN])
    render(<ParamGroups />)
    expect(screen.getByTestId('lora-stack-refused').textContent).toContain('Kohya format')
    cleanup()

    arrangeVideo(WAN, [LTXQ, WAN])
    render(<ParamGroups />)
    expect(screen.queryByTestId('lora-stack-refused')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /qwen\/detail/ }))
    expect(stack().map((l) => l.name)).toEqual([DETAIL])
  })

  it('a file that is no plain LoRA is refused for both', () => {
    io.keys = { [DETAIL]: 'other' }
    for (const pick of [LTXQ, WAN]) {
      arrangeVideo(pick, [LTXQ, WAN])
      render(<ParamGroups />)
      expect(screen.getByTestId('lora-stack-refused').textContent, pick.name).toContain('not a plain LoRA')
      cleanup()
    }
  })
})
