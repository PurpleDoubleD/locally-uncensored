// @vitest-environment jsdom
/**
 * D3b: when the cap took older unsorted entries, the gallery panel says so,
 * once, and the line can be closed. See stores/__tests__/galerie-speicher-d3b.test.ts.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-hinweis-d3b.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn(), onLoad: vi.fn() }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))

import { useCreateStore, GALLERY_TRIMMED_NOTICE, type GalleryItem } from '../../../../stores/createStore'
import { CreatePanel } from '../CreatePanel'

const ITEM = (id: string): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: 1,
})

beforeEach(() => {
  useCreateStore.setState({ backend: 'local', gallery: [ITEM('a')], galleryFolders: [], galleryFolderOpen: null, galleryNotice: null })
})
afterEach(() => { cleanup() })

const panel = () => render(<CreatePanel open onOpenChange={() => {}} activeId={null} onSelect={() => {}} />)

describe('the gallery panel', () => {
  it('shows nothing while no entry was dropped', () => {
    panel()
    expect(screen.queryByText(GALLERY_TRIMMED_NOTICE)).toBeNull()
  })

  it('says that older unsorted images were removed, and the line can be closed', () => {
    useCreateStore.setState({ galleryNotice: GALLERY_TRIMMED_NOTICE })
    panel()
    const line = screen.getByRole('status')
    expect(line.textContent).toContain(GALLERY_TRIMMED_NOTICE)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(GALLERY_TRIMMED_NOTICE)).toBeNull()
    expect(useCreateStore.getState().galleryNotice).toBeNull()
  })
})
