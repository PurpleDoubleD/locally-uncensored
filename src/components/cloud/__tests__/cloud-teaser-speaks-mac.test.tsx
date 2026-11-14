// @vitest-environment jsdom
/**
 * The Cloud sheet on a Mac says Mac and memory, not PC, GPU and VRAM.
 *
 * Fehlerkontrolle Mac 2, Fund 10: the sheet read "Runs on your PC with
 * downloaded models" on a Mac, and it was one probe away from "Your GPU has
 * 16 GB" there too: the line prints whatever `detect_gpus` reports as card
 * memory. A Mac now reads its shared pool instead and is never asked for a
 * card.
 *
 * Negative control: with the fixed PC sentence and the unconditional
 * "Your GPU has" line, the three Mac cases are red.
 *
 * Run: npx vitest run src/components/cloud/__tests__/cloud-teaser-speaks-mac.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

const platform = vi.hoisted(() => ({ mac: true }))
const probe = vi.hoisted(() => ({ card: 0, ram: 0 }))
const openExternal = vi.hoisted(() => vi.fn())

vi.mock('../../../api/backend', async () => ({
  ...(await vi.importActual<typeof import('../../../api/backend')>('../../../api/backend')),
  openExternal,
  isMacOS: () => platform.mac,
}))
vi.mock('../../../lib/hardware', () => ({
  getMaxVramGb: () => Promise.resolve(probe.card),
  getSharedMemoryGb: () => Promise.resolve(probe.ram),
}))

import { CloudTeaserModal, teaserWhereLine } from '../CloudTeaserModal'
import { useUIStore, type CloudTeaserTarget } from '../../../stores/uiStore'
import { useSettingsStore } from '../../../stores/settingsStore'

async function openSheet(target: CloudTeaserTarget) {
  useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: true })
  useUIStore.getState().setCloudTeaser(target)
  await act(async () => { render(<CloudTeaserModal />) })
  return screen.getByRole('dialog').textContent ?? ''
}

/** A lane that also runs locally on both platforms, so the "runs here" sentence shows. */
const LOCAL_LANE: CloudTeaserTarget = { surface: 'create-model', kind: 'image', modelId: 'does-not-matter' }
const UPSCALE: CloudTeaserTarget = { surface: 'intent', intent: 'upscale' }

beforeEach(() => { platform.mac = true; probe.card = 0; probe.ram = 0; openExternal.mockReset() })
afterEach(() => cleanup())

describe('the sentence that says where a tool runs', () => {
  it('on a Mac: this Mac, and memory instead of VRAM', () => {
    expect(teaserWhereLine(true, true)).toBe('Runs on this Mac with downloaded models, or on LU Cloud where datacenter GPUs do the heavy lifting.')
    expect(teaserWhereLine(false, true)).toBe('Runs on LU Cloud, where datacenter GPUs do the heavy lifting and memory is not the limit.')
  })

  it('WINDOWS CONTROL: both sentences as they were', () => {
    expect(teaserWhereLine(true, false)).toBe('Runs on your PC with downloaded models, or on LU Cloud where datacenter GPUs do the heavy lifting.')
    expect(teaserWhereLine(false, false)).toBe('Runs on LU Cloud, where datacenter GPUs do the heavy lifting and VRAM is not the limit.')
  })
})

describe('on a Mac', () => {
  it('says how much memory this Mac has, never what its GPU has', async () => {
    probe.ram = 16
    const text = await openSheet(UPSCALE)
    expect(text).toContain('This Mac has 16 GB of memory.')
    expect(text).not.toContain('Your GPU has')
  })

  it('stays that way even if a card size were reported for the chip', async () => {
    probe.card = 16
    probe.ram = 16
    const text = await openSheet(UPSCALE)
    expect(text).toContain('This Mac has 16 GB of memory.')
    expect(text).not.toContain('Your GPU has')
  })

  it('names no PC and no VRAM anywhere on the sheet', async () => {
    probe.ram = 16
    for (const target of [UPSCALE, LOCAL_LANE]) {
      const text = await openSheet(target)
      expect(text, JSON.stringify(target)).not.toMatch(/your PC|VRAM|Your GPU/)
      cleanup()
    }
  })

  it('does not file the memory of a Mac as a card size in the checkout tag', async () => {
    probe.card = 16
    probe.ram = 16
    await openSheet(UPSCALE)
    fireEvent.click(screen.getByTestId('buy-sub'))
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(String(openExternal.mock.calls[0][0])).toContain('src=gpu-unknown')
  })
})

describe('WINDOWS CONTROL', () => {
  it('the card line and the VRAM wording are the old ones, word for word', async () => {
    platform.mac = false
    probe.card = 12
    probe.ram = 32
    const text = await openSheet(UPSCALE)
    expect(text).toContain('Blow any image up to crisp 2K, 4K or 8K. No VRAM needed.')
    expect(text).toContain('Your GPU has 12 GB. ')
    expect(text).not.toContain('This Mac')
    expect(screen.getByTestId('cloud-teaser-where').textContent).toMatch(
      /^Your GPU has 12 GB\. (Runs on your PC with downloaded models, or on LU Cloud where datacenter GPUs do the heavy lifting\.|Runs on LU Cloud, where datacenter GPUs do the heavy lifting and VRAM is not the limit\.)$/,
    )
    fireEvent.click(screen.getByTestId('buy-sub'))
    expect(String(openExternal.mock.calls[0][0])).toContain('src=gpu12')
  })
})
