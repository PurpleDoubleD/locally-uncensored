/**
 * The picture on the stage of a source tool takes the height that is left
 * (persona walk, 09.10.2026, Funde 14 and 15). The rule holds on every
 * platform.
 *
 * Measured on the Mac in a 1440 × 900 window: stage 451 px high, content 771 px,
 * reference strip from 722 px on. The picture took 52 % of the window height
 * whatever stood under it.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/fit-stage-height.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIT_MIN_PICTURE, fitPictureHeight } from '../FitStage'

const source = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf-8')

describe('the height a picture may take', () => {
  it('beside the controls it keeps the stage, less the padding and what stands under it', () => {
    expect(fitPictureHeight({ frame: 451, under: 0, side: 260, beside: true })).toBe(411)
    // The facts of a result stay under the picture and cost it their height.
    expect(fitPictureHeight({ frame: 451, under: 38, side: 260, beside: true })).toBe(373)
  })

  it('over the controls it gives up as much as they need, so they are on screen', () => {
    const height = fitPictureHeight({ frame: 451, under: 0, side: 251, beside: false })
    expect(height).toBe(168)
    // Picture, controls and padding together are the stage, not more.
    expect(height + 251 + 32).toBeLessThanOrEqual(451)
  })

  it('a picture is never squeezed to nothing: below the floor the stage scrolls', () => {
    expect(fitPictureHeight({ frame: 300, under: 0, side: 400, beside: false })).toBe(FIT_MIN_PICTURE)
    expect(fitPictureHeight({ frame: 0, under: 0, side: 0, beside: true })).toBe(FIT_MIN_PICTURE)
  })
})

describe('who uses it', () => {
  it('the source preview and the result of a source tool, on every platform', () => {
    const stage = source('Stage.tsx')
    expect(stage).toContain('return <FitStage picture={picture} side={controls} capVh={52} onDragOver={onDragOver} onDrop={onDrop} />')
    // B45: the Image tab hands the result its reference images as the side.
    expect(stage).toContain('side={meta.needsSource && source ? <ResultInputs /> : imageRefSide ? <ImageReferenceStrip /> : undefined}')
    // No host is asked, and the column that scrolled is gone.
    expect(stage).not.toMatch(/isMlxImageHost\(\)[^\n]*FitStage|FitStage[^\n]*isMlxImageHost\(\)/)
    expect(stage).not.toContain('ResultSourceActions')
    expect(stage).not.toContain('m-auto flex flex-col items-center p-6 max-w-full')
    expect(source('OutputView.tsx')).not.toMatch(/\bfooter\b/)
    // The result view takes the layout when it is handed a side.
    expect(source('OutputView.tsx')).toContain('return <FitStage picture={media} under={facts} side={side} capVh={62} />')
  })

  // How-to recording 12.10.2026, 1440 × 900: a 16:9 result with no source
  // beside it kept 62 % of the window height on a stage of 451 px, so its
  // lower edge and the prompt fold under it were cut off.
  it('a result with no source beside it is fitted too, with what stands under it', () => {
    const view = source('OutputView.tsx')
    expect(view).not.toContain('if (side) return <FitStage')
    expect(view).not.toContain('{media()}')
    // 62 % of the window stays the cap, and the size until the stage is measured.
    expect(view.match(/!maxHeight && 'max-h-\[62vh\]'/g)).toHaveLength(2)
    // The facts and the folded prompt cost the picture their height.
    expect(fitPictureHeight({ frame: 451, under: 76, side: 0, beside: false })).toBe(343)
  })
})
