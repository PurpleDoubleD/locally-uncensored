// @vitest-environment jsdom
/**
 * Local Enhance Image (3.0.7) in the Composer: a size menu instead of the
 * cloud's target resolution (2x/4x until 3.1.0, see
 * upscale-groesse-und-modell.test.tsx), no prompt field, no image model
 * picker, and a Create button that waits for the source and an upscale model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openExternal: vi.fn(),
}))

import { Composer } from '../Composer'
import { Stage } from '../Stage'
import { useCreateStore } from '../../../../stores/createStore'

const ref = { filename: 'photo.png', url: 'data:image/png;base64,AA', width: 640, height: 480 }
const create = () => screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement
const composer = () => render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)

beforeEach(() => {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], upscaleFactor: 2,
    upscaleModelList: ['RealESRGAN_x4plus.safetensors'], source: null,
  } as never)
  useCreateStore.getState().setIntent('upscale')
})
afterEach(cleanup)

describe('the local Enhance composer', () => {
  it('offers a size, 2x picked, and not the cloud target resolution', () => {
    composer()
    expect(screen.getByRole('button', { name: 'Upscale size' }).textContent).toContain('2x')
    expect(screen.queryByText('8K')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Upscale factor' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Upscale size' }))
    fireEvent.click(screen.getByRole('option', { name: /^4x/ }))
    expect(useCreateStore.getState().upscaleFactor).toBe(4)
  })

  it('has no prompt field and no model picker', () => {
    composer()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByTitle('Advanced settings')).toBeNull()
    expect(screen.getByText('No prompt needed. Just hit Create to enhance the image.')).toBeTruthy()
  })

  it('Create waits for the image, then runs', () => {
    composer()
    expect(create().disabled).toBe(true)
    cleanup()
    useCreateStore.getState().setSource(ref)
    composer()
    expect(create().disabled).toBe(false)
  })

  it('Create waits for an upscale model and says where to get one', () => {
    useCreateStore.setState({ upscaleModelList: [] })
    useCreateStore.getState().setSource(ref)
    composer()
    expect(create().disabled).toBe(true)
    expect(create().parentElement?.getAttribute('title')).toBe('Get the upscale model first: Download & install, above.')
  })

  it('the cloud keeps its target resolution and does not wait on a local model', () => {
    useCreateStore.setState({ backend: 'cloud', upscaleModelList: [] })
    composer()
    expect(screen.queryByRole('radiogroup', { name: 'Upscale factor' })).toBeNull()
    expect(screen.getByText('8K')).toBeTruthy()
  })
})

describe('the local Enhance stage', () => {
  const stage = () => render(<Stage onOpenMaskEditor={() => {}} onFullscreen={() => {}} />)

  it('offers the upscale model download while none is there', () => {
    useCreateStore.setState({ upscaleModelList: [] })
    stage()
    expect(screen.getByText('Local Enhance Image needs a one-time download')).toBeTruthy()
    expect(screen.getByText(/Real-ESRGAN x4plus upscale model \(~67 MB/)).toBeTruthy()
  })

  it('with a model there it asks for the image to enhance', () => {
    stage()
    expect(screen.queryByText('Local Enhance Image needs a one-time download')).toBeNull()
    expect(screen.getByText('Drop an image to enhance')).toBeTruthy()
  })
})
