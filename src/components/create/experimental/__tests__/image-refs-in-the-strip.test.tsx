// @vitest-environment jsdom
/**
 * Two Discord questions from 23.10.2026 about a Qwen edit with references:
 *   - help-18: "it says IMAGE 2 is the reference photo, should i just put
 *     image 2, or IMAGE 2.?" Each tile now carries its name, says how to use
 *     it, and a click adds it to the prompt.
 *   - #general: "even with strength at 95% and cfg 3" on Qwen Image 2.1
 *     Edit. Through ComfyUI both Qwen edit families sampled at denoise 1.0,
 *     so the slider set nothing there and 3.0.8 took it out. B46 (3.0.9,
 *     Discord 30.10.2026): it is back on its own field, `editStrength`
 *     (1 = as before), which the graph now reads (qwen-edit-strength.test.ts).
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/image-refs-in-the-strip.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

const host = vi.hoisted(() => ({ mac: false }))

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isMlxImageHost: () => host.mac,
}))
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openExternal: vi.fn(),
}))
vi.mock('../../../../hooks/useGraphicsMemory', () => ({ useGraphicsCardGb: () => null }))

import { Composer } from '../Composer'
import { ReferenceStrip } from '../ReferenceStrip'
import { useCreateStore } from '../../../../stores/createStore'
import { readsEditStrength } from '../../../../lib/edit-references'

const SOURCE = { filename: 'scene.png', url: 'data:image/png;base64,scene', width: 8, height: 8 }
const QWEN21 = 'qwen_image_2.1_int8_convrot.safetensors'
const EDIT_PLUS = 'qwen_image_edit_2509_fp8_e4m3fn.safetensors'
const QWEN1 = 'qwen_image_fp8_e4m3fn.safetensors'
const SDXL = 'juggernautXL_v9.safetensors'
const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ ...SOURCE, filename: `r${i}.png`, url: `data:image/png;base64,r${i}` }))

function editWith(model: string, type: string, references = 0) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], prompt: '',
    imageModel: model, imageModelType: type, imageModelList: [{ name: model, type }] as never, references: [],
  } as never)
  useCreateStore.getState().setIntent('edit')
  useCreateStore.getState().setSource(SOURCE)
  useCreateStore.setState({ references: refs(references) })
}

beforeEach(() => { host.mac = false })
afterEach(cleanup)

describe('each reference tile names itself', () => {
  it('shows Image 2 and Image 3, with the hint, and the source is named image 1', () => {
    editWith(QWEN21, 'qwenimage', 2)
    render(<ReferenceStrip />)
    const two = screen.getByRole('button', { name: 'Add image 2 to the prompt' })
    expect(two.textContent).toBe('Image 2')
    expect(two.getAttribute('title')).toBe('Refer to it as image 2 in your prompt. Click to add it.')
    expect(screen.getByRole('button', { name: 'Add image 3 to the prompt' }).textContent).toBe('Image 3')
    expect(screen.getByText('Name them in the prompt as image 2, image 3. The image above is image 1.')).toBeTruthy()
  })

  it('a click adds the name to the end of the prompt, a space between', () => {
    editWith(QWEN21, 'qwenimage', 2)
    useCreateStore.setState({ prompt: 'the person in image 1 takes the pose of the person in' })
    render(<ReferenceStrip />)
    fireEvent.click(screen.getByRole('button', { name: 'Add image 2 to the prompt' }))
    expect(useCreateStore.getState().prompt).toBe('the person in image 1 takes the pose of the person in image 2')
    fireEvent.click(screen.getByRole('button', { name: 'Add image 3 to the prompt' }))
    expect(useCreateStore.getState().prompt).toBe('the person in image 1 takes the pose of the person in image 2 image 3')
  })

  it('on an empty prompt the name is the whole prompt', () => {
    editWith(EDIT_PLUS, 'qwenimage1', 1)
    render(<ReferenceStrip />)
    fireEvent.click(screen.getByRole('button', { name: 'Add image 2 to the prompt' }))
    expect(useCreateStore.getState().prompt).toBe('image 2')
  })

  it('removing a tile still works next to the name', () => {
    editWith(QWEN21, 'qwenimage', 2)
    render(<ReferenceStrip />)
    fireEvent.click(screen.getByLabelText('Remove image 2'))
    expect(useCreateStore.getState().references).toHaveLength(1)
    expect(useCreateStore.getState().prompt).toBe('')
  })
})

describe('the Edit strength shows only where the run reads it', () => {
  const slider = () => screen.queryByRole('slider', { name: 'Edit strength' }) ?? screen.queryByText('Edit strength')
  const composer = () => render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
  const value = () => screen.getByText('Edit strength').parentElement!.parentElement!.textContent

  it('B46: Qwen-Image 2.1 through ComfyUI has it again, on editStrength, at 1.00 by default', () => {
    editWith(QWEN21, 'qwenimage')
    useCreateStore.setState({ editStrength: 1, denoise: 0.7 })
    composer()
    expect(slider()).toBeTruthy()
    // Not the img2img denoise (0.70): the Qwen edit's own field.
    expect(value()).toContain('1.00')
    expect(value()).not.toContain('0.70')
  })

  it('B46: Qwen-Image-Edit 2509 through ComfyUI has it too', () => {
    editWith(EDIT_PLUS, 'qwenimage1')
    useCreateStore.setState({ editStrength: 0.4 })
    composer()
    expect(value()).toContain('0.40')
  })

  it('COUNTER-CHECK: an SDXL edit and plain Qwen-Image keep the denoise slider', () => {
    editWith(SDXL, 'sdxl')
    useCreateStore.setState({ editStrength: 1, denoise: 0.7 })
    const first = composer()
    expect(value()).toContain('0.70')
    first.unmount()
    editWith(QWEN1, 'qwenimage1')
    composer()
    expect(value()).toContain('0.70')
  })

  it('which families read editStrength', () => {
    expect(readsEditStrength('qwenimage', QWEN21)).toBe(true)
    expect(readsEditStrength('qwenimage1', EDIT_PLUS)).toBe(true)
    expect(readsEditStrength('qwenimage1', QWEN1)).toBe(false)
    expect(readsEditStrength('sdxl', SDXL)).toBe(false)
    expect(readsEditStrength(null, QWEN21)).toBe(false)
  })
})

describe('the line under the strip', () => {
  it('is set in sentence case, so "image 2" is not shown as IMAGE 2', () => {
    editWith(QWEN21, 'qwenimage', 1)
    render(<ReferenceStrip />)
    const line = screen.getByTestId('reference-strip-names')
    // t-label sets text-transform: uppercase (index.css).
    expect(line.className).not.toMatch(/\bt-label\b/)
    expect(line.textContent).toBe('Name them in the prompt as image 2. The image above is image 1.')
  })
})
