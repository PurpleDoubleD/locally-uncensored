/**
 * B24 (3.0.9, Discord 28.10.2026): a video LoRA stayed switched on
 * after the change to Image and rode into the run of another model. The LoRA
 * picks now belong to the task and the model: leaving puts them aside, coming
 * back brings them back, a lane never visited starts empty.
 *
 * Run: npx vitest run src/stores/__tests__/createStore-lora-je-aufgabe-und-modell.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCreateStore } from '../createStore'
import { sanitizeLoraLanes, switchLoraLane, LORA_LANES_MAX } from '../../lib/render/lora-lanes'

const VIDEO_LORA = 'wan22_lightx2v_4step.safetensors'
const IMAGE_LORA = 'detail_tweaker_xl.safetensors'
const CHAR = 'char_mira_zimage.safetensors'
const names = () => useCreateStore.getState().selectedLoras.map((l) => l.name)

beforeEach(() => {
  useCreateStore.setState({
    mode: 'image', imageSubMode: 'text2img', videoSubMode: 't2v', removebg: false, utilityOp: null, cloudOp: null,
    imageModel: 'sdxl.safetensors', imageModelType: 'sdxl', videoModel: 'wan2.2_t2v_14B.safetensors',
    selectedLoras: [], loraStrengths: {}, loraLanes: {}, selectedCharacter: null,
  } as never)
})

describe('B24: LoRA picks per task and model', () => {
  it('a video LoRA does not stay on after the change to Image, and comes back on Video', () => {
    const s = useCreateStore.getState()
    s.setIntent('video')
    s.toggleLora(VIDEO_LORA)
    expect(names()).toEqual([VIDEO_LORA])
    s.setIntent('image')
    expect(names()).toEqual([])
    s.toggleLora(IMAGE_LORA)
    s.setIntent('video')
    expect(names()).toEqual([VIDEO_LORA])
    s.setIntent('image')
    expect(names()).toEqual([IMAGE_LORA])
  })

  it('another model in the same task keeps its own picks, the strength comes back too', () => {
    const s = useCreateStore.getState()
    s.toggleLora(IMAGE_LORA)
    s.setLoraStrengthFor(IMAGE_LORA, 0.35)
    s.setImageModel('flux1-dev.safetensors', 'flux')
    expect(names()).toEqual([])
    s.setImageModel('sdxl.safetensors', 'sdxl')
    expect(useCreateStore.getState().selectedLoras).toEqual([{ name: IMAGE_LORA, strength: 0.35 }])
  })

  it('Image and Edit are two tasks', () => {
    const s = useCreateStore.getState()
    s.toggleLora(IMAGE_LORA)
    s.setIntent('edit')
    expect(names()).toEqual([])
    s.setIntent('image')
    expect(names()).toEqual([IMAGE_LORA])
  })

  it('a character LoRA goes along with the character, whatever the order of the clicks', () => {
    const s = useCreateStore.getState()
    s.toggleLora(IMAGE_LORA)
    s.toggleLora(CHAR)
    s.setImageModel('z_image_turbo.safetensors', 'zimage')
    expect(names()).toEqual([CHAR])
    s.setImageModel('sdxl.safetensors', 'sdxl')
    expect(names()).toEqual([IMAGE_LORA, CHAR])
  })

  it('a change that sets the picks itself keeps them', () => {
    useCreateStore.setState({ mode: 'video', selectedLoras: [{ name: 'style_x_zimage.safetensors', strength: 1 }] })
    expect(names()).toEqual(['style_x_zimage.safetensors'])
  })

  it('while the model list loads (no model yet) the saved picks are not filed away', () => {
    useCreateStore.setState({ imageModel: '', selectedLoras: [{ name: IMAGE_LORA, strength: 1 }] })
    useCreateStore.getState().setImageModel('sdxl.safetensors', 'sdxl')
    expect(names()).toEqual([IMAGE_LORA])
  })
})

describe('lora-lanes', () => {
  it('keeps at most LORA_LANES_MAX lanes, the oldest goes', () => {
    let lanes: Record<string, { name: string; strength: number }[]> = {}
    for (let i = 0; i <= LORA_LANES_MAX + 3; i++) {
      lanes = switchLoraLane({ key: `image|m${i}`, picks: [{ name: 'a', strength: 1 }] }, { key: `image|m${i + 1}`, picks: [] }, lanes, false)!.loraLanes
    }
    expect(Object.keys(lanes)).toHaveLength(LORA_LANES_MAX)
    expect(lanes['image|m0']).toBeUndefined()
  })

  it('a damaged saved map is cleaned', () => {
    expect(sanitizeLoraLanes({ a: [{ name: 'x', strength: 1 }, { name: 2 }], b: 'no', c: [] })).toEqual({ a: [{ name: 'x', strength: 1 }] })
    expect(sanitizeLoraLanes(null)).toEqual({})
  })
})
