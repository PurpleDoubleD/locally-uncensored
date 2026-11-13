// @vitest-environment jsdom
/**
 * "Text encoder" in the Expert settings (03.10.2026): on a local
 * Qwen-Image 2.1 with both editions of its text encoder installed, the user
 * says which one reads the prompt. One row, in the advanced settings, never
 * at the prompt field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const host = vi.hoisted(() => ({ mlx: false }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => host.mlx }))
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: (n: string) => (/qwen_image_2\.1/.test(n) ? 'qwenimage' : 'sdxl'),
  // B18: the video length controls ask for the card size.
  getSystemVRAM: async () => null,
  isI2VModel: () => false,
  isT2VCapable: () => true,
  getImageUrl: (f: string) => `http://127.0.0.1:8188/view?filename=${f}`,
}))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { useCreateStore } from '../../../../stores/createStore'

const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const SDXL = 'sdxl_base.safetensors'
const OFFICIAL = 'qwen3vl_8b_int8_convrot.safetensors'
const FREE = 'qwen3vl_8b_int8_convrot_heretic.safetensors'

function setup(model: string, type: string, extra: Record<string, unknown> = {}) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, qwenTextEncoder: 'auto',
    imageModel: model, imageModelList: [{ name: model, type }], cloudOp: null, utilityOp: null, removebg: false,
    textEncoderList: [OFFICIAL, FREE],
    ...extra,
  } as never)
  useCreateStore.getState().setMode('image')
}

/** The Expert section is closed until the user opens it. */
function openExpert() {
  fireEvent.click(screen.getByRole('button', { name: 'Expert' }))
}
const row = () => screen.queryByRole('button', { name: 'Text encoder' })

beforeEach(() => { host.mlx = false })
afterEach(() => { cleanup() })

describe('row Text encoder', () => {
  it('sits in the Expert section, not on the open surface', () => {
    setup(QWEN, 'qwenimage')
    render(<ParamGroups />)
    expect(row()).toBeNull()
    openExpert()
    expect(row()).not.toBeNull()
    expect(screen.getByText('Text encoder')).toBeTruthy()
  })

  it('shows the official encoder by default and offers both editions', () => {
    setup(QWEN, 'qwenimage')
    render(<ParamGroups />)
    openExpert()
    expect(row()!.textContent).toContain('Qwen3-VL 8B')
    expect(row()!.textContent).not.toContain('No Filter')
    fireEvent.click(row()!)
    const list = screen.getByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Qwen3-VL 8B', 'Qwen3-VL 8B, No Filter'])
  })

  it('picking the edition without refusals is stored and shown', () => {
    setup(QWEN, 'qwenimage')
    render(<ParamGroups />)
    openExpert()
    fireEvent.click(row()!)
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Qwen3-VL 8B, No Filter' }))
    expect(useCreateStore.getState().qwenTextEncoder).toBe('unfiltered')
    expect(row()!.textContent).toContain('Qwen3-VL 8B, No Filter')
  })

  it('is there for an edit too', () => {
    setup(QWEN, 'qwenimage')
    useCreateStore.getState().setIntent('edit')
    render(<ParamGroups />)
    openExpert()
    expect(row()).not.toBeNull()
  })

  it('with one edition installed there is nothing to choose and no row', () => {
    for (const only of [[OFFICIAL], [FREE], []]) {
      setup(QWEN, 'qwenimage', { textEncoderList: only })
      const view = render(<ParamGroups />)
      openExpert()
      expect(row()).toBeNull()
      view.unmount()
    }
  })

  it('is missing on every other model, in the cloud, on video and on the Mac', () => {
    setup(SDXL, 'sdxl')
    let view = render(<ParamGroups />)
    openExpert()
    expect(row()).toBeNull()
    view.unmount()

    setup(QWEN, 'qwenimage', { backend: 'cloud' })
    view = render(<ParamGroups />)
    expect(row()).toBeNull()
    view.unmount()

    setup(QWEN, 'qwenimage')
    useCreateStore.getState().setMode('video')
    view = render(<ParamGroups />)
    openExpert()
    expect(row()).toBeNull()
    view.unmount()

    setup(QWEN, 'qwenimage')
    host.mlx = true
    render(<ParamGroups />)
    expect(row()).toBeNull()
  })
})

describe('the setting in the store', () => {
  it('takes the three values and nothing else', () => {
    const s = useCreateStore.getState()
    s.setQwenTextEncoder('unfiltered')
    expect(useCreateStore.getState().qwenTextEncoder).toBe('unfiltered')
    s.setQwenTextEncoder('official')
    expect(useCreateStore.getState().qwenTextEncoder).toBe('official')
    s.setQwenTextEncoder('something else' as never)
    expect(useCreateStore.getState().qwenTextEncoder).toBe('auto')
  })

  it('is remembered across restarts', () => {
    useCreateStore.getState().setQwenTextEncoder('unfiltered')
    const kept = useCreateStore.persist.getOptions().partialize!(useCreateStore.getState()) as Record<string, unknown>
    expect(kept.qwenTextEncoder).toBe('unfiltered')
    // The list of files is read from ComfyUI every time, never stored.
    expect('textEncoderList' in kept).toBe(false)
  })
})
