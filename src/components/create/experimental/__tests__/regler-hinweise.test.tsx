// @vitest-environment jsdom
/**
 * B50 (Discord, 30.10.2026): a character trained in LU came out as noise with
 * a checker pattern. The picture's own workflow said why: CFG 30 and the LoRA
 * at 2.0, both turned up by hand. Nothing in LU said that this breaks Z-Image.
 * Now a short note stands next to the slider, with the range that works. It
 * never blocks (David, 30.10.2026).
 *
 * The rules are lib/param-hints.ts; here they are checked as rules and in the
 * real ParamGroups.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const lists = vi.hoisted(() => ({ loras: [] as string[] }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: lists.loras, vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { useCreateStore } from '../../../../stores/createStore'
import { classifyModel, MODEL_TYPE_DEFAULTS, type ModelType } from '../../../../api/comfyui'
import { cfgHint, loraStrengthHint, LOW_CFG_FAMILIES } from '../../../../lib/param-hints'

const Z_BASE = 'z_image_bf16.safetensors'
const SDXL = 'juggernautXL_v9.safetensors'
const CHAR = 'char_jolene_zimage.safetensors'
const SLIDER = 'krea2_age_slider.safetensors'

describe('the rules', () => {
  it('the low-CFG families are exactly the image families whose default CFG is at most 4', () => {
    const notImage = new Set(['wan', 'wan22', 'hunyuan', 'ltx', 'ltx25', 'minimaxh3', 'mochi', 'cosmos', 'ace', 'yue2'])
    const low = Object.entries(MODEL_TYPE_DEFAULTS)
      .filter(([family, d]) => !notImage.has(family) && d.frames === 1 && d.cfg <= 4)
      .map(([family, d]) => [family, d.cfg])
    expect(Object.fromEntries(low)).toEqual(LOW_CFG_FAMILIES)
    expect(LOW_CFG_FAMILIES['sdxl' as ModelType]).toBeUndefined()
  })

  it('Z-Image: quiet up to 10, a note with the working range above', () => {
    expect(cfgHint('zimage', 3.5)).toBeNull()
    expect(cfgHint('zimage', 10)).toBeNull()
    expect(cfgHint('zimage', 30)).toBe('This model works best at CFG 1 to 5. Above 10 the picture turns to noise or a checker pattern.')
  })

  it('a distilled family that runs at CFG 1 speaks up earlier', () => {
    expect(cfgHint('flux', 4)).toBeNull()
    expect(cfgHint('flux', 6)).toBe('This model works best at CFG 1 to 2. Above 5 the picture turns to noise or a checker pattern.')
  })

  it('families made for a high CFG and unknown models get no note', () => {
    expect(cfgHint('sdxl', 30)).toBeNull()
    expect(cfgHint('sd15', 30)).toBeNull()
    expect(cfgHint('unknown', 30)).toBeNull()
  })

  it('a LoRA above 1.5 gets a note, a slider LoRA does not', () => {
    expect(loraStrengthHint(CHAR, 1.5)).toBeNull()
    expect(loraStrengthHint(CHAR, 2)).toBe('Above 1.5 most LoRAs break the picture. 0.6 to 1.2 is the usual range.')
    expect(loraStrengthHint(SLIDER, 8)).toBeNull()
    expect(loraStrengthHint(CHAR, -2)).toBeNull()
  })
})

function setup(model: string, cfg: number, loras: { name: string; strength: number }[] = []) {
  lists.loras = loras.map((l) => l.name)
  useCreateStore.setState({
    backend: 'local', isGenerating: false, cloudOp: null, utilityOp: null, removebg: false, expertOpen: false,
    selectedLoras: loras,
    imageModel: model, imageModelList: [{ name: model, type: classifyModel(model) }],
    videoModel: '', videoModelList: [],
  } as never)
  useCreateStore.getState().setIntent('image')
  useCreateStore.setState({ cfgScale: cfg } as never)
  render(<ParamGroups />)
}

afterEach(() => { cleanup() })

describe('next to the sliders', () => {
  it('the reported case: Z-Image Base at CFG 30 says the working range, and Create stays possible', () => {
    setup(Z_BASE, 30)
    expect(screen.getByTestId('cfg-hint').textContent).toBe(cfgHint('zimage', 30))
    // A note, not a lock: the value stays what the user set.
    expect(useCreateStore.getState().cfgScale).toBe(30)
  })

  it('Z-Image at its default says nothing', () => {
    setup(Z_BASE, 3.5)
    expect(screen.queryByTestId('cfg-hint')).toBeNull()
  })

  it('SDXL at a high CFG says nothing', () => {
    setup(SDXL, 20)
    expect(screen.queryByTestId('cfg-hint')).toBeNull()
  })

  it('the character at 2.0 in the stack gets the note under its strength', () => {
    setup(Z_BASE, 3.5, [{ name: CHAR, strength: 2 }])
    fireEvent.click(screen.getByRole('button', { name: 'Expert' }))
    expect(screen.getByTestId('lora-strength-hint').textContent).toBe(loraStrengthHint(CHAR, 2))
    expect(useCreateStore.getState().selectedLoras[0].strength).toBe(2)
  })

  it('the character at 0.8 has no note', () => {
    setup(Z_BASE, 3.5, [{ name: CHAR, strength: 0.8 }])
    fireEvent.click(screen.getByRole('button', { name: 'Expert' }))
    expect(screen.queryByTestId('lora-strength-hint')).toBeNull()
  })
})
