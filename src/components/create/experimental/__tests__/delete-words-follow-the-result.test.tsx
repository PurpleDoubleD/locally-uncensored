// @vitest-environment jsdom
/**
 * C3D (14.11.2026): under a cloud 3D result the line said "Delete (moves the
 * file to the Trash)". Delete of a cloud result only takes the entry out of
 * this gallery (lib/gallery-trash.ts): no file on this computer, nothing on
 * the server. The words now follow what Delete does, for 3D and every other
 * result, under the result and on its hover button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const host = vi.hoisted(() => ({ mac: true }))
vi.mock('../../../../api/mlx-image', async (o) => ({ ...(await o<typeof import('../../../../api/mlx-image')>()), isMlxImageHost: () => host.mac }))
vi.mock('../../../three/LazyModelViewer', () => ({ LazyModelViewer: () => <div data-testid="viewer" /> }))

import { ResultView } from '../OutputView'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'

const item = (over: Partial<GalleryItem>): GalleryItem => ({
  id: 'g1', type: 'image', filename: 'lu_00001_.png', subfolder: '', prompt: 'p', negativePrompt: '',
  model: 'm', modelType: 'sdxl', seed: 1, steps: 1, cfgScale: 1, sampler: 'euler', scheduler: 'normal',
  width: 8, height: 8, batchSize: 1, createdAt: 1, ...over,
}) as GalleryItem

function show(it: GalleryItem) {
  useCreateStore.setState({ gallery: [it] })
  render(<ResultView item={it} onFullscreen={() => {}} />)
}

afterEach(() => { cleanup(); host.mac = true; useCreateStore.setState({ gallery: [] }) })

describe('the words of Delete under a result', () => {
  it('a cloud 3D result: only from this gallery, the cloud copy stays', () => {
    show(item({ type: '3d', filename: undefined, jobId: 'j1', remoteUrl: 'https://s/b.glb', model: 'trellis-2' }))
    const facts = screen.getByTestId('result-facts')
    expect(facts.textContent).toContain('Delete (only from this gallery, the cloud copy stays)')
    expect(facts.textContent).not.toMatch(/Trash|Recycle Bin/)
  })

  it('a 3D model made on this Mac: its file goes to the Trash', () => {
    show(item({ type: '3d', filename: undefined, localPath: '/out/a.glb' }))
    expect(screen.getByTestId('result-facts').textContent).toContain('Delete (moves the file to the Trash)')
  })

  it('a cloud picture: the hover button says the same as under a cloud 3D result', () => {
    show(item({ filename: undefined, jobId: 'j2', remoteUrl: 'https://s/a.png' }))
    expect(screen.getByTitle('Delete (only from this gallery, the cloud copy stays)')).toBeTruthy()
  })

  it('a local ComfyUI picture on Windows: the Recycle Bin, as always', () => {
    host.mac = false
    show(item({}))
    expect(screen.getByTitle('Delete (moves the file to the Recycle Bin)')).toBeTruthy()
  })
})
