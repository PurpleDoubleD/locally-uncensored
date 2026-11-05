// @vitest-environment jsdom
/**
 * "Improve my prompt" with the Qwen-Image 2.1 prompt enhancer (GH #148): ONE
 * switch in the advanced settings. With a local Qwen-Image 2.1 and an enhancer
 * installed it also stands on Edit, a row under it picks who writes, and
 * without an enhancer everything is as before: the chat model writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: (name: string) => (name.includes('qwen_image_2.1') ? 'qwenimage' : 'sdxl'),
  isI2VModel: () => false,
  isT2VCapable: () => true,
  isVideoModelType: () => false,
  isInstalledVideoType: () => false,
  resolveLocalOpPick: (picked: string) => picked,
}))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))
vi.mock('../../../../api/providers', () => ({
  getProviderIdFromModel: (m: string) => (m.startsWith('lu-cloud::') ? 'lu-cloud' : 'ollama'),
  getProviderForModel: vi.fn(),
}))

import { AdvancedDrawer } from '../AdvancedDrawer'
import { ImproveToggle } from '../ImproveToggle'
import { useCreateStore } from '../../../../stores/createStore'
import { useModelStore } from '../../../../stores/modelStore'

const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const T2I = 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors'
const I2I = 'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'
const T2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_t2i_heretic.int8_convrot.safetensors'
const I2I_FREE = 'qwen3.5_9b_qwen_image_2.1_pe_i2i_heretic.int8_convrot.safetensors'

const local = (textEncoders: string[], model: { name: string; type: string } = { name: QWEN, type: 'qwenimage' }) => {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, improvePrompt: false, improveWith: 'auto', cloudStudioOptions: {},
    imageModel: model.name, imageModelList: [model], textEncoderList: textEncoders,
  } as never)
}
const theSwitch = () => screen.queryByRole('switch', { name: /improve my prompt/i })
const writers = () => screen.queryAllByRole('radio').map((r) => `${r.textContent}${r.getAttribute('aria-checked') === 'true' ? '*' : ''}`)

beforeEach(() => {
  useModelStore.setState({ activeModel: 'qwen3:8b' })
  local([T2I, I2I, T2I_FREE, I2I_FREE])
})
afterEach(() => { cleanup() })

describe('one switch, also on Edit when the enhancer is there', () => {
  it('Edit shows the switch on a local Qwen-Image 2.1 with an edit enhancer', () => {
    useCreateStore.getState().setIntent('edit')
    render(<ImproveToggle />)
    expect(theSwitch()).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('Edit without an edit enhancer, on another model or in the cloud: the chat model writes (B48)', () => {
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ improvePrompt: true })
    const chatOnly = () => {
      expect(theSwitch()).not.toBeNull()
      expect(screen.queryByTestId('improve-enhancer-line')).toBeNull()
      expect(screen.queryByRole('radiogroup')).toBeNull()
    }
    local([T2I, T2I_FREE])
    const a = render(<ImproveToggle />)
    chatOnly()
    a.unmount()
    local([T2I, I2I], { name: 'flux2-klein.safetensors', type: 'flux2' })
    const b = render(<ImproveToggle />)
    chatOnly()
    b.unmount()
    local([T2I, I2I])
    useCreateStore.setState({ backend: 'cloud' })
    render(<ImproveToggle />)
    chatOnly()
  })

  it('the enhancer needs no chat model: the switch works without one', async () => {
    useModelStore.setState({ activeModel: null })
    useCreateStore.getState().setIntent('image')
    render(<ImproveToggle />)
    const sw = theSwitch() as HTMLButtonElement
    expect(sw.disabled).toBe(false)
    fireEvent.click(sw)
    expect(useCreateStore.getState().improvePrompt).toBe(true)
    fireEvent.mouseEnter(sw.parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/Qwen prompt enhancer rewrites your prompt/i))
  })
})

describe('who writes', () => {
  it('off: no row. On: the installed enhancers and the chat model, the official one marked', () => {
    useCreateStore.getState().setIntent('image')
    render(<ImproveToggle />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.click(theSwitch()!)
    expect(screen.getByRole('radiogroup', { name: 'Rewritten by' })).toBeTruthy()
    expect(writers()).toEqual(['Qwen enhancer*', 'Qwen enhancer, No Filter', 'Chat model'])
  })

  it('a click picks the one without refusals and it is remembered in the store', () => {
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    fireEvent.click(screen.getByRole('radio', { name: 'Qwen enhancer, No Filter' }))
    expect(useCreateStore.getState().improveWith).toBe('unfiltered')
    expect(writers()).toEqual(['Qwen enhancer', 'Qwen enhancer, No Filter*', 'Chat model'])
  })

  it('picking the chat model brings the chat tooltip back', async () => {
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    fireEvent.click(screen.getByRole('radio', { name: 'Chat model' }))
    expect(useCreateStore.getState().improveWith).toBe('chat')
    fireEvent.mouseEnter(theSwitch()!.parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/your chat model rewrites your prompt/i))
  })

  it('Edit lists the enhancers only, a chat model cannot see the picture', () => {
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ improvePrompt: true, improveWith: 'chat' })
    render(<ImproveToggle />)
    expect(writers()).toEqual(['Qwen enhancer*', 'Qwen enhancer, No Filter'])
  })

  it('a single enhancer on Edit leaves nothing to choose: no row', () => {
    local([I2I_FREE])
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    expect(theSwitch()!.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('without an enhancer everything is as before', () => {
  it('no row, the chat model writes, and without a chat model the switch is locked', async () => {
    local(['qwen3vl_8b_int8_convrot.safetensors'])
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    const a = render(<ImproveToggle />)
    expect(theSwitch()!.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.mouseEnter(theSwitch()!.parentElement as HTMLElement)
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/your chat model rewrites your prompt/i))
    a.unmount()
    useModelStore.setState({ activeModel: null })
    render(<ImproveToggle />)
    expect((theSwitch() as HTMLButtonElement).disabled).toBe(true)
  })

  it('another local model with the enhancers on disk: no row', () => {
    local([T2I, I2I, T2I_FREE, I2I_FREE], { name: 'juggernaut.safetensors', type: 'sdxl' })
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<ImproveToggle />)
    expect(theSwitch()).toBeTruthy()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('where it stands', () => {
  it('switch and row are in the advanced settings drawer, on Edit too', () => {
    useCreateStore.getState().setIntent('edit')
    useCreateStore.setState({ improvePrompt: true })
    render(<AdvancedDrawer open onClose={() => {}} />)
    expect(screen.getByText('Improve my prompt')).toBeTruthy()
    expect(screen.getByText('Rewritten by')).toBeTruthy()
  })

  it('closed, neither is anywhere, so not at the prompt field either', () => {
    useCreateStore.getState().setIntent('image')
    useCreateStore.setState({ improvePrompt: true })
    render(<AdvancedDrawer open={false} onClose={() => {}} />)
    expect(screen.queryByText('Improve my prompt')).toBeNull()
    expect(screen.queryByText('Rewritten by')).toBeNull()
  })
})
