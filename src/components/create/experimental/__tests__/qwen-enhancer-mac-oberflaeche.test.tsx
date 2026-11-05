// @vitest-environment jsdom
/**
 * "Improve my prompt" on a Mac with Qwen-Image 2.1 (GH #148). With the MLX
 * prompt enhancer installed the same switch stands on Image and on Edit, and
 * on Image a row picks between the enhancer and the chat model. There is one
 * edition (the official one), so the row never offers "No Filter". Without an
 * enhancer the switch is what it was: the chat model on Image, nothing on Edit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: (name: string | null | undefined) => !!name && name.startsWith('MLX '),
}))
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: () => 'sdxl',
  isI2VModel: () => false,
  isT2VCapable: () => true,
  isVideoModelType: () => false,
  isInstalledVideoType: () => false,
  resolveLocalOpPick: (picked: string) => picked,
}))
vi.mock('../../../../api/providers', () => ({
  getProviderIdFromModel: () => 'ollama',
  getProviderForModel: vi.fn(),
}))

import { ImproveToggle } from '../ImproveToggle'
import { useCreateStore } from '../../../../stores/createStore'
import { useModelStore } from '../../../../stores/modelStore'

const T2I = 'qwen-image-2.1-pe-t2i-4bit'
const I2I = 'qwen-image-2.1-pe-i2i-4bit'
const QWEN = { name: 'MLX Qwen-Image 2.1 4-bit', type: 'qwenimage', source: 'checkpoint', editImages: 10 }
const TURBO = { name: 'MLX SD Turbo', type: 'sd15', source: 'checkpoint', editImages: 0 }
// A ComfyUI checkpoint of the same family, from a manual install on this Mac.
const COMFY_QWEN = { name: 'qwen_image_2.1_bf16.safetensors', type: 'qwenimage', source: 'checkpoint' }

const mac = (enhancers: string[], pick: { name: string } = QWEN) => {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, improvePrompt: false, improveWith: 'auto', cloudStudioOptions: {},
    imageModel: pick.name, imageModelList: [TURBO, QWEN, COMFY_QWEN], mlxEnhancerList: enhancers,
    // ComfyUI's files count on Windows, never on a Mac.
    textEncoderList: ['qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors'],
  } as never)
}
const theSwitch = () => screen.queryByRole('switch', { name: /improve my prompt/i })
const writers = () => screen.queryAllByRole('radio').map((r) => `${r.textContent}${r.getAttribute('aria-checked') === 'true' ? '*' : ''}`)

beforeEach(() => {
  useModelStore.setState({ activeModel: 'qwen3:8b' })
  mac([T2I, I2I])
})
afterEach(() => { cleanup() })

describe('the Mac with the enhancer installed', () => {
  it('Image: the enhancer and the chat model, the enhancer marked, and its hint', async () => {
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    expect(writers()).toEqual(['Qwen enhancer*', 'Chat model'])
    fireEvent.mouseEnter(theSwitch()!.parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/Qwen prompt enhancer rewrites your prompt/i))
  })

  it('Edit: the switch is there, works without a chat model, and has nothing to choose', () => {
    useModelStore.setState({ activeModel: null })
    useCreateStore.getState().setIntent('edit')
    render(<ImproveToggle />)
    const sw = theSwitch() as HTMLButtonElement
    expect(sw.disabled).toBe(false)
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('Edit reads the model the edit runs: the stored pick that cannot edit does not hide the switch', () => {
    mac([T2I, I2I], TURBO)
    useCreateStore.getState().setIntent('edit')
    render(<ImproveToggle />)
    expect(theSwitch()).toBeTruthy()
  })
})

describe('the Mac without the enhancer is as before', () => {
  it('Image: the chat model writes, no row', () => {
    mac([])
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    expect(theSwitch()!.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('Edit: an enhancer file in a ComfyUI list is not offered, the chat model writes (B48)', () => {
    mac([T2I])
    useCreateStore.getState().setIntent('edit')
    render(<ImproveToggle />)
    expect(theSwitch()).not.toBeNull()
    expect(screen.queryByTestId('improve-enhancer-line')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('a ComfyUI Qwen-Image on a Mac: the chat model writes, as the run does', async () => {
    mac([T2I, I2I], COMFY_QWEN)
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.mouseEnter(theSwitch()!.parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).not.toMatch(/Qwen prompt enhancer/i))
  })

  it('another model: no row, the enhancers are for Qwen-Image 2.1', () => {
    mac([T2I, I2I], TURBO)
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})
