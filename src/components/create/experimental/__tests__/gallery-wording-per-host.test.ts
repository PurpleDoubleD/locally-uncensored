/**
 * The result view names the host it runs on.
 *
 * Persona walk of the Mac app, 09.10.2026: a video whose file could not be
 * read said "It shows up again as soon as ComfyUI is running" on a Mac, and
 * Delete promised the Recycle Bin. A Mac has neither: its renders go to the
 * Trash (lib/gallery-trash.ts, commands/mlx_outputs.rs).
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/gallery-wording-per-host.test.ts
 */
import { describe, it, expect } from 'vitest'
import { deleteTitle, unavailableLine, unavailableTitle } from '../galleryWording'

describe('on a Mac', () => {
  it('no sentence names ComfyUI, an engine to wait for, or the Recycle Bin', () => {
    const all = [unavailableLine(true, true), unavailableLine(false, true), unavailableTitle(true, true), unavailableTitle(false, true), deleteTitle(true, 'trash'), deleteTitle(true, 'cloud'), deleteTitle(true, 'entry')]
    for (const line of all) expect(line).not.toMatch(/ComfyUI|Recycle Bin|local engine/)
    expect(unavailableLine(true, true)).toBe('This file is no longer on this Mac.')
  })

  it('Delete names the Trash, where the file goes', () => {
    expect(deleteTitle(true, 'trash')).toBe('Delete (moves the file to the Trash)')
  })
})

describe('COUNTER-CHECK: Windows and Linux read what they always did', () => {
  it('the four sentences and the Delete tooltip are unchanged', () => {
    expect(unavailableLine(true, false)).toBe('This file is no longer in the ComfyUI output folder.')
    expect(unavailableLine(false, false)).toBe("This render lives on the local engine, which isn't reachable right now. It shows up again as soon as ComfyUI is running.")
    expect(unavailableTitle(true, false)).toBe('No longer in the ComfyUI output folder')
    expect(unavailableTitle(false, false)).toBe("Local render, but the local engine isn't reachable")
    expect(deleteTitle(false, 'trash')).toBe('Delete (moves the file to the Recycle Bin)')
  })
})

describe('a video whose file cannot be read (Fund 26)', () => {
  it('draws no player controls under the sentence, on every platform', async () => {
    const { playerHasControls } = await import('../galleryWording')
    expect(playerHasControls(true)).toBe(false)
    expect(playerHasControls.length).toBe(1)
  })

  it('COUNTER-CHECK: a video that plays keeps them', async () => {
    const { playerHasControls } = await import('../galleryWording')
    expect(playerHasControls(false)).toBe(true)
  })

  it('the result view asks before it draws them, and gives the sentence room', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve(__dirname, '../OutputView.tsx'), 'utf-8')
    expect(source).toContain('controls={playerHasControls(!!item.unavailable)}')
    expect(source).toContain('!playerHasControls(!!item.unavailable) && UNAVAILABLE_VIDEO_BOX')
  })
})

// C3D (14.11.2026): under a cloud result Delete said the file goes to the
// Trash. A cloud result only leaves this gallery (lib/gallery-trash.ts).
describe('Delete says what it does to the entry', () => {
  it('a cloud result: only from this gallery, on every host', () => {
    for (const mac of [true, false]) {
      expect(deleteTitle(mac, 'cloud')).toBe('Delete (only from this gallery, the cloud copy stays)')
      expect(deleteTitle(mac, 'entry')).toBe('Delete (only from the gallery)')
      for (const fate of ['cloud', 'entry'] as const) expect(deleteTitle(mac, fate)).not.toMatch(/Trash|Recycle Bin|moves the file/)
    }
  })
})
