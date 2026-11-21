import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BundleTile } from '../ModelTiles'
import { getImageBundles, getVideoBundles, getLipsyncBundles } from '../../../api/model-bundles'

// October 2026, the owner's 12 GB box: the catalogue said "10-16 GB" about
// Z-Image and the card stood five minutes in the load. The tile now compares
// the bundle with the detected card, in the place the fit hint always had.

const bundle = (name: string) => [...getImageBundles(), ...getVideoBundles(), ...getLipsyncBundles()].find((b) => b.name === name)!

function tile(name: string, vramGb: number | null, sharedMemory = false): string {
  return renderToStaticMarkup(
    <BundleTile
      bundle={bundle(name)} vramGb={vramGb} sharedMemory={sharedMemory}
      complete={false} downloading={false} hasErrors={false}
      onInstall={() => {}} onRetry={() => {}} onClear={() => {}} onOpenUrl={() => {}}
    />,
  )
}

describe('a bundle tile compares itself with the detected card', () => {
  it('fits: says so and names the card', () => {
    const html = tile('Juggernaut XL V9 (Photorealistic)', 12)
    expect(html).toContain('data-bundle-fit="fits"')
    expect(html).toContain('Fits your 12 GB card')
    expect(html).toContain('bg-emerald-500/80')
  })

  it('tight: says it runs and what it costs', () => {
    const html = tile('Z-Image Turbo (Unfiltered, Fast)', 12)
    expect(html).toContain('data-bundle-fit="tight"')
    expect(html).toContain('Tight on your 12 GB card: runs, loading can be slow')
    expect(html).toContain('title="Runs from 10 GB. Loads fully into graphics memory from 16 GB."')
    expect(html).toContain('bg-sky-500/80')
    // Never red: a tight model is slow, not broken.
    expect(html).not.toMatch(/bg-red|text-red/)
  })

  it('needs more: says so, in the tone of slower and not of broken', () => {
    const html = tile('ERNIE-Image Turbo', 12)
    expect(html).toContain('data-bundle-fit="big"')
    expect(html).toContain('Needs more than your 12 GB card')
    expect(html).toContain('bg-orange-500/80')
    expect(html).not.toMatch(/bg-red|text-red/)
  })

  it('the same bundle reads differently on another card', () => {
    expect(tile('Z-Image Turbo (Unfiltered, Fast)', 8)).toContain('Needs more than your 8 GB card')
    expect(tile('Z-Image Turbo (Unfiltered, Fast)', 16)).toContain('Fits your 16 GB card')
  })

  it('exactly one hint per tile: the card line replaces the general one', () => {
    const html = tile('Z-Image Turbo (Unfiltered, Fast)', 12)
    expect(html).not.toContain('Tight fit')
    expect(html.match(/rounded-full bg-sky-500\/80/g)).toHaveLength(1)
  })

  it('without a detected card the tile stays as it was: no word about a card', () => {
    const html = tile('Z-Image Turbo (Unfiltered, Fast)', null)
    expect(html).not.toContain('data-bundle-fit')
    expect(html).not.toMatch(/card/)
    expect(html).toContain('Get · 19.3 GB')
  })

  it('shared memory (a Mac) has no card to name and keeps the general hint', () => {
    const html = tile('Z-Image Turbo (Unfiltered, Fast)', 32, true)
    expect(html).not.toContain('data-bundle-fit')
    expect(html).not.toMatch(/your 32 GB card/)
    expect(html).toContain('Runs on your PC')
  })

  // The box, 04.10.2026: this card had no line at all under its description,
  // neither a verdict nor what it is for.
  it('a bundle whose text names no number claims nothing and says what it is for', () => {
    const html = tile('Krea 2 Companion Files (Text Encoder + VAE)', 12)
    expect(html).not.toContain('data-bundle-fit')
    expect(html).not.toMatch(/your 12 GB card/)
    expect(html).toContain('>For Krea 2 checkpoints<')
  })

  // The same run: the tooltip of a card without a stated floor left out that
  // the model runs at all, under a verdict reading "Tight ...: runs".
  it('the tooltip of every verdict says from where it runs', () => {
    expect(tile('Wan 2.2 S2V FP8 (Talking Character)', 12)).toContain(
      'title="Runs on smaller cards too, with part of the model kept outside graphics memory. Loads fully into graphics memory from 16.8 GB."',
    )
    expect(tile('Qwen-Image 2.1 (Generate and Edit)', 12)).toContain(
      'title="Runs on smaller cards too, with part of the model kept outside graphics memory. Loads fully into graphics memory from 12 GB."',
    )
    expect(tile('Z-Image Turbo (Unfiltered, Fast)', 12)).toContain('title="Runs from 10 GB. Loads fully into graphics memory from 16 GB."')
  })

  // The same run: Pixel Art XL read 174.1 MB on its card and 162.6 MB under
  // Installed. The file has 170 543 052 bytes (Hugging Face, 03.10.2026).
  it('Pixel Art XL shows the size the file has', () => {
    const html = tile('Pixel Art XL · SDXL LoRA', 12)
    expect(html).toContain('162.6 MB')
    expect(html).not.toContain('174.1 MB')
  })

  // The box, 03.10.2026: the 1.82 GB turbo LoRA read "Needs more than your
  // 12 GB card". An add-on names what it belongs to and carries no verdict.
  it('an add-on says what it is for instead of a verdict', () => {
    const html = tile('Wan 2.1 14B Speed LoRAs · 4 Steps', 8)
    expect(html).toContain('data-bundle-addon-for="Wan 2.1 14B"')
    expect(html).toContain('>For Wan 2.1 14B<')
    expect(html).not.toContain('data-bundle-fit')
    expect(html).not.toMatch(/your 8 GB card/)
    expect(tile('Pixel Art XL · SDXL LoRA', 12)).toContain('>For SDXL models<')
  })

  it('FramePack fits a 12 GB card, as its own description says', () => {
    const html = tile('FramePack F1 (Image to Video)', 12)
    expect(html).toContain('runs on 6 GB VRAM')
    expect(html).toContain('Fits your 12 GB card')
  })
})
