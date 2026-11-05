/**
 * @vitest-environment jsdom
 *
 * Discord #bug-reports, 30.10.2026: the Details button that shows a model's
 * whole description existed on chat tiles only. Image, video and add-on
 * bundles (both faces) and the Mac media tiles cut their description at two
 * lines, and the rest could not be read anywhere in LU. Each of them has the
 * button now, and the dialog holds the full text.
 *
 * Run: npx vitest run src/components/models/__tests__/a-cut-description-has-details.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { BundleTile } from '../ModelTiles'
import { ClassicBundleTile } from '../skin/ClassicTiles'
import { MacMediaTile } from '../MacMediaTile'
import { getImageBundles, getVideoBundles } from '../../../api/model-bundles'

afterEach(cleanup)

const noop = () => {}
// The longest catalogue descriptions: those two lines cut.
const longest = (list: ReturnType<typeof getImageBundles>) => [...list].sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))[0]
const image = longest(getImageBundles())
const video = longest(getVideoBundles())

const bundleProps = (bundle: typeof image) => ({
  bundle, vramGb: 16, complete: false, downloading: false, hasErrors: false,
  onInstall: noop, onRetry: noop, onClear: noop, onOpenUrl: noop,
})

const MAC_TEXT = 'A video model for the Mac. ' + 'It renders short clips from a prompt or a start image and keeps the motion steady over the whole length. '.repeat(4)

function opensFullText(ui: ReactElement, name: string, description: string) {
  render(ui)
  fireEvent.click(screen.getByRole('button', { name: `Details for ${name}` }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByTestId('description-details').textContent).toBe(description)
}

describe('a tile that cuts its description offers the whole text', () => {
  it('the catalogue really has long descriptions here', () => {
    expect(image.description!.length).toBeGreaterThan(120)
    expect(video.description!.length).toBeGreaterThan(120)
  })

  it('image bundle, Mac face', () => opensFullText(<BundleTile {...bundleProps(image)} />, image.name, image.description!))
  it('video bundle, Mac face', () => opensFullText(<BundleTile {...bundleProps(video)} />, video.name, video.description!))
  it('image bundle, classic face', () => opensFullText(<ClassicBundleTile {...bundleProps(image)} />, image.name, image.description!))
  it('video bundle, classic face', () => opensFullText(<ClassicBundleTile {...bundleProps(video)} />, video.name, video.description!))

  it('Mac media tile', () => opensFullText(
    <MacMediaTile
      model={{ id: 'm', name: 'Mac Video', repo: 'x/y', sizeBytes: 1e9, minRamGB: 16, unfiltered: false, description: MAC_TEXT }}
      memoryGb={48} state={{ kind: 'idle' }} onGet={noop} onCancel={noop} onRemove={noop} onOpenUrl={noop}
    />,
    'Mac Video', MAC_TEXT,
  ))

  it('a bundle without a description has no empty Details', () => {
    render(<BundleTile {...bundleProps({ ...image, description: '' })} />)
    expect(screen.queryByRole('button', { name: /^Details for/ })).toBeNull()
  })
})
