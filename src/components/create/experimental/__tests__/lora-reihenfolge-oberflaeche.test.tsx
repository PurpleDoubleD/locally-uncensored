// @vitest-environment jsdom
/**
 * D4 (3.0.9, Discord, a follow-up to B24): the LoRA stack shows the picks in
 * the order the run chains them, with a button to move each one up or down.
 * A pick kept for another model is not shown and never swallows a click.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/lora-reihenfolge-oberflaeche.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const lists = vi.hoisted(() => ({ loras: [] as string[] }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: lists.loras, vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { resetLoraStackView } from '../loraStackView'
import { useCreateStore } from '../../../../stores/createStore'
import { classifyModel } from '../../../../api/comfyui'

const MODEL = 'juggernautXL_v9.safetensors'
const GRAIN = 'styles/film_grain_xl.safetensors'
const DETAIL = 'detail_slider_xl.safetensors'
const AGE = 'age_slider_xl.safetensors'
const CHAR = 'char_mira_zimage.safetensors'

function open() {
  render(<ParamGroups />)
  if (!screen.queryByRole('searchbox', { name: 'Search LoRAs' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Expert' }))
  }
}
const order = () => within(screen.getByTestId('lora-order')).getAllByRole('listitem').map((li) => li.textContent?.replace(/^\d+/, ''))
const picked = () => useCreateStore.getState().selectedLoras.map((l) => l.name)

beforeEach(() => {
  lists.loras = [GRAIN, DETAIL, AGE, CHAR]
  resetLoraStackView()
  useCreateStore.setState({
    backend: 'local', isGenerating: false, cloudOp: null, utilityOp: null, removebg: false,
    expertOpen: false, selectedLoras: [], loraStrengths: {}, loraLanes: {}, selectedCharacter: null,
    imageModel: MODEL, imageModelList: [{ name: MODEL, type: classifyModel(MODEL) }],
  } as never)
  useCreateStore.getState().setIntent('image')
})
afterEach(() => cleanup())

describe('D4: the order of the picked LoRAs', () => {
  it('one pick shows no order, two show it in the order of the clicks', () => {
    useCreateStore.getState().toggleLora(DETAIL)
    open()
    expect(screen.queryByTestId('lora-order')).toBeNull()
    cleanup()
    useCreateStore.getState().toggleLora(GRAIN)
    open()
    expect(order()).toEqual(['detail_slider_xl', 'styles/film_grain_xl'])
  })

  it('up and down move the pick, the run order follows', () => {
    const s = useCreateStore.getState()
    s.toggleLora(DETAIL)
    s.toggleLora(GRAIN)
    s.toggleLora(AGE)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Move age_slider_xl up' }))
    expect(order()).toEqual(['detail_slider_xl', 'age_slider_xl', 'styles/film_grain_xl'])
    fireEvent.click(screen.getByRole('button', { name: 'Move detail_slider_xl down' }))
    expect(picked()).toEqual([AGE, DETAIL, GRAIN])
    expect((screen.getByRole('button', { name: 'Move age_slider_xl up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move styles/film_grain_xl down' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a pick this model does not run is left out of the order and skipped by a move', () => {
    // A Z-Image character stays picked on SDXL (it runs on Z-Image only).
    useCreateStore.setState({ selectedLoras: [{ name: DETAIL, strength: 0.8 }, { name: CHAR, strength: 1 }, { name: GRAIN, strength: 0.8 }] } as never)
    open()
    expect(order()).toEqual(['detail_slider_xl', 'styles/film_grain_xl'])
    fireEvent.click(screen.getByRole('button', { name: 'Move styles/film_grain_xl up' }))
    expect(order()).toEqual(['styles/film_grain_xl', 'detail_slider_xl'])
    expect(picked()).toEqual([GRAIN, CHAR, DETAIL])
  })
})
