// @vitest-environment jsdom
/**
 * D23: the number of images per run sits in the Composer's action bar, next
 * to Create, and not only in Advanced settings. It writes the same fields as
 * the sliders there (batchSize locally, cloudImageCount in the cloud) and
 * shows only on runs that really make more than one picture.
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

import { Composer } from '../Composer'
import { useCreateStore } from '../../../../stores/createStore'
import { composerImageCountMax } from '../../../../lib/render/image-count'

const composer = () => render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
const chip = () => screen.queryByRole('button', { name: /^Images per run: \d$/ })
const choices = () => screen.getByRole('radiogroup', { name: 'Images per run' })

beforeEach(() => {
  host.mac = false
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], source: null,
    batchSize: 1, cloudImageCount: 1,
  } as never)
  useCreateStore.getState().setIntent('image')
})
afterEach(cleanup)

describe('the image count in the Composer', () => {
  it('local Image: a chip next to Create shows 1 and opens 1 to 8', () => {
    composer()
    expect(chip()?.textContent).toBe('1')
    expect(screen.queryByRole('radiogroup', { name: 'Images per run' })).toBeNull()
    fireEvent.click(chip()!)
    expect(choices().textContent).toBe('12345678')
    expect(screen.getByText('1 image per run')).toBeTruthy()
  })

  it('a pick sets the batch size the run reads, and the chip shows it', () => {
    composer()
    fireEvent.click(chip()!)
    fireEvent.click(screen.getByRole('radio', { name: '4' }))
    expect(useCreateStore.getState().batchSize).toBe(4)
    expect(chip()?.textContent).toBe('4')
    expect(screen.getByText('4 images per run')).toBeTruthy()
  })

  it('shows the batch size already set in Advanced settings', () => {
    useCreateStore.setState({ batchSize: 6 })
    composer()
    expect(chip()?.getAttribute('aria-label')).toBe('Images per run: 6')
  })

  it('cloud Image: 1 to 4 and writes the cloud count', () => {
    useCreateStore.setState({ backend: 'cloud' })
    composer()
    fireEvent.click(chip()!)
    expect(choices().textContent).toBe('1234')
    fireEvent.click(screen.getByRole('radio', { name: '3' }))
    expect(useCreateStore.getState().cloudImageCount).toBe(3)
    expect(useCreateStore.getState().batchSize).toBe(1)
  })

  it('no chip where a run makes one result: video, utilities', () => {
    useCreateStore.getState().setIntent('video')
    composer()
    expect(chip()).toBeNull()
    cleanup()
    useCreateStore.getState().setIntent('removebg')
    composer()
    expect(chip()).toBeNull()
  })

  it('local Edit offers the count on ComfyUI too (B35)', () => {
    useCreateStore.getState().setIntent('edit')
    composer()
    expect(chip()).not.toBeNull()
  })

  it('the Mac edits one picture per image, so local Edit offers the count there', () => {
    host.mac = true
    useCreateStore.getState().setIntent('edit')
    composer()
    expect(chip()).not.toBeNull()
  })
})

describe('composerImageCountMax', () => {
  it('follows the lanes', () => {
    expect(composerImageCountMax('local', 'image')).toBe(8)
    // B35: a local ComfyUI edit repeats its source latent (api/edit-batch).
    expect(composerImageCountMax('local', 'edit')).toBe(8)
    expect(composerImageCountMax('cloud', 'edit')).toBe(4)
    expect(composerImageCountMax('cloud', 'video')).toBeNull()
    expect(composerImageCountMax('local', 'music')).toBeNull()
  })
})
