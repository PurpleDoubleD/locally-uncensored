// @vitest-environment jsdom
/**
 * Characters everywhere (3.0.7): the character chip next to the model chip
 * on Image, Edit and every video tab, and the line above the prompt that says
 * what the run does with the character.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/character-chip-on-every-tab.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../api/mlx-image')),
  isMlxImageHost: () => false,
}))
vi.mock('../../../../api/comfyui', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/comfyui')>('../../../../api/comfyui')
  return { ...actual, getLoraModels: vi.fn(async () => ['char_mira_zimage.safetensors', 'grain.safetensors']) }
})

import { CharacterChip, CharacterNote, characterChipShown, characterMakesStart } from '../CharacterChip'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import { classifyModel, type ClassifiedModel } from '../../../../api/comfyui'

const model = (name: string): ClassifiedModel => ({ name, type: classifyModel(name), source: 'diffusion_model' })
const QWEN = model('qwen_image_2512_fp8_e4m3fn.safetensors')
const BASE = model('z_image_bf16.safetensors')
const WAN = model('wan2.2_ti2v_5B_fp16.safetensors')
const T2V = model('wan2.1_t2v_1.3B_fp16.safetensors')
const CHAR = 'char_mira_zimage.safetensors'
const MIRA = { id: `local:${CHAR}`, name: 'mira', triggerWord: 'mira', family: 'zimage' }

function on(intent: CreateIntent, list: ClassifiedModel[] = [QWEN, BASE], extra: Record<string, unknown> = {}) {
  useCreateStore.setState({
    backend: 'local', cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null,
    imageModelList: list, imageModel: QWEN.name, imageModelType: QWEN.type,
    videoModelList: [WAN, T2V], videoModel: WAN.name,
    selectedLoras: [{ name: CHAR, strength: 1 }], selectedCharacter: null,
  } as never)
  useCreateStore.getState().setIntent(intent)
  useCreateStore.setState(extra as never)
  render(<><CharacterChip /><CharacterNote /></>)
}

async function pick(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: /character/i }))
  fireEvent.click(screen.getByRole('option', { name: new RegExp(label) }))
}

beforeEach(() => cleanup())

describe('where the chip stands', () => {
  it('Image, Edit and every video tab of the local lane, not the cloud, not Music; on a Mac the tabs it runs', () => {
    for (const intent of ['image', 'edit', 'video', 'animate', 'extend', 'lipsync', 'motion']) {
      expect(characterChipShown('local', intent, false)).toBe(true)
    }
    expect(characterChipShown('cloud', 'video', false)).toBe(false)
    expect(characterChipShown('local', 'music', false)).toBe(false)
    expect(characterChipShown('local', 'character', false)).toBe(false)
    // The Mac runs the image on mflux with the LoRA and the video on MLX from
    // it; its other video tabs have no local engine. Edit neither: the Mac
    // edits with Qwen-Image 2.1 only and a local character is a Z Image one.
    for (const intent of ['image', 'video', 'animate']) expect(characterChipShown('local', intent, true)).toBe(true)
    for (const intent of ['edit', 'extend', 'lipsync', 'motion', 'music']) expect(characterChipShown('local', intent, true)).toBe(false)
  })

  it('on a Mac, Talking Character carries the character once its run can start', () => {
    // 3.0.8: step 2 is the a2v of LTX-2.3 4-bit from the character's
    // portrait, and only with that model's own download on disk.
    expect(characterChipShown('local', 'lipsync', true, false, false)).toBe(false)
    expect(characterChipShown('local', 'lipsync', true, false, true)).toBe(true)
    for (const intent of ['edit', 'extend', 'motion', 'music']) expect(characterChipShown('local', intent, true, false, true)).toBe(false)
    // Windows and Linux are not touched by it.
    expect(characterChipShown('local', 'lipsync', false, false, false)).toBe(true)
    expect(characterChipShown('cloud', 'lipsync', true, true, true)).toBe(false)
  })

  it('a video tab is ready without a start image when the character makes one', () => {
    expect(characterMakesStart('local', 'animate', MIRA, false)).toBe(true)
    expect(characterMakesStart('local', 'animate', MIRA, true)).toBe(false)
    expect(characterMakesStart('local', 'animate', null, false)).toBe(false)
    expect(characterMakesStart('local', 'image', MIRA, false)).toBe(false)
  })
})

describe('the chip', () => {
  it('on Image picks the character and brings its Z Image model', async () => {
    on('image')
    await pick('mira')
    const s = useCreateStore.getState()
    expect(s.selectedCharacter).toEqual(MIRA)
    expect(s.imageModel).toBe(BASE.name)
    // The stack is left as it is; the run adds the LoRA where it is missing.
    expect(s.selectedLoras).toEqual([{ name: CHAR, strength: 1 }])
    expect(screen.getByTestId('character-note').textContent).toBe('“mira” goes into your prompt by itself. Describe the key features too.')
  })

  it('No character takes it off again', async () => {
    on('image', [QWEN, BASE], { selectedCharacter: MIRA })
    await pick('No character')
    expect(useCreateStore.getState().selectedCharacter).toBeNull()
    // The LoRA an earlier pick left in the stack goes with the character.
    expect(useCreateStore.getState().selectedLoras).toEqual([])
    expect(screen.queryByTestId('character-note')).toBeNull()
  })

  it('without a Z Image model the model stays and the note says why', async () => {
    on('image', [QWEN])
    await pick('mira')
    expect(useCreateStore.getState().imageModel).toBe(QWEN.name)
    expect(screen.getByTestId('character-note').textContent)
      .toBe('This character was trained for Z Image, and no Z Image model is installed. Get one in the Model Manager to use it.')
  })

  it('on Video it keeps the video model and says the image comes first', async () => {
    on('video')
    await pick('mira')
    expect(useCreateStore.getState().videoModel).toBe(WAN.name)
    expect(screen.getByTestId('character-note').textContent).toBe('First an image of mira is made with Z Image, then the video starts from it.')
  })

  it('on Video with a text only model the note says why it cannot', async () => {
    on('video', [QWEN, BASE], { selectedCharacter: MIRA, videoModelList: [T2V], videoModel: T2V.name })
    expect((await screen.findByTestId('character-note')).textContent).toMatch(/makes video from text only/)
  })

  it('on Animate with an image of the user the note says that image is used', async () => {
    on('animate', [QWEN, BASE], { selectedCharacter: MIRA, source: { filename: 'a.png', url: 'blob:a', width: 1, height: 1 } })
    expect((await screen.findByTestId('character-note')).textContent).toBe('Your start image is used. Remove it to start from mira.')
  })

  it('on Edit with a mask the note says the character needs none', async () => {
    on('edit', [QWEN, BASE], {
      selectedCharacter: MIRA, imageModel: BASE.name, imageModelType: 'zimage',
      source: { filename: 'a.png', url: 'blob:a', width: 1, height: 1 }, mask: { filename: 'm.png', url: 'blob:m', width: 1, height: 1 },
    })
    expect((await screen.findByTestId('character-note')).textContent).toMatch(/works without a mask/)
  })
})
