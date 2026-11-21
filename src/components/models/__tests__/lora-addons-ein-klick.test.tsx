/**
 * @vitest-environment jsdom
 *
 * Models, LoRAs, Get new lists the catalog's own LoRAs with one click each
 * (Discord 2026-10-03: how does the MiniMax H3 turbo LoRA get
 * into the stack). Measured on the rendered list: the tile, the click, what
 * the download is told (folder, size, sha256) and the three tile states.
 *
 * Run: npx vitest run src/components/models/__tests__/lora-addons-ein-klick.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ModelBundle } from '../../../api/model-bundles'

const installBundleComplete = vi.fn(async (_b: ModelBundle) => ({} as { remote?: unknown }))
const checkBundlesInstalled = vi.fn(async (_b: ModelBundle[]) => ({} as Record<string, boolean>))

// Die Seite hat seit dem 08.10.2026 zwei Fassungen: die klassische auf
// Windows und Linux, das Redesign auf dem Mac (skin/which.ts entscheidet).
// Die Regeln, die diese Datei bewacht, gelten fuer beide, also laeuft jeder
// Fall einmal je Fassung.
const face = vi.hoisted(() => ({ name: 'classic' as 'classic' | 'mac' }))
vi.mock('../skin/which', () => ({ modelSkinName: () => face.name }))

vi.mock('../../../api/backend', () => ({ openExternal: vi.fn(), backendCall: vi.fn(), isTauri: () => false }))
vi.mock('../../../api/discover', () => ({
  installBundleComplete: (b: ModelBundle) => installBundleComplete(b),
  checkBundlesInstalled: (b: ModelBundle[]) => checkBundlesInstalled(b),
  remoteBundleNotice: (name: string) => `${name}: saved here, copy it over`,
}))

type Row = { status: string; progress?: number; total?: number }
const store = {
  downloads: {} as Record<string, Row>,
  setMeta: vi.fn(),
  setBundleGroup: vi.fn(),
  startPolling: vi.fn(),
  refresh: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
  dismiss: vi.fn(),
}
vi.mock('../../../stores/downloadStore', () => {
  const useDownloadStore = Object.assign(
    (pick: (s: typeof store) => unknown) => pick(store),
    { getState: () => store },
  )
  return { useDownloadStore }
})

import { LoraAddons } from '../LoraAddons'

const PIXEL = 'Pixel Art XL · SDXL LoRA'
const FILE = 'pixel-art-xl.safetensors'
const tile = (name: string) => document.querySelector(`[data-bundle-tile="${name}"]`) as HTMLElement

beforeEach(() => {
  store.downloads = {}
  for (const f of [store.setMeta, store.setBundleGroup, store.startPolling, store.refresh, store.retry, store.dismiss]) f.mockClear()
  installBundleComplete.mockReset().mockResolvedValue({})
  checkBundlesInstalled.mockReset().mockResolvedValue({})
})
afterEach(cleanup)

describe.each(['classic', 'mac'] as const)('Fassung %s', (fassung) => {
  beforeEach(() => { face.name = fassung })

  describe('the list', () => {
    it('shows the catalogue LoRAs, each with its size', async () => {
      render(<LoraAddons />)
      await waitFor(() => expect(checkBundlesInstalled).toHaveBeenCalled())
      expect(screen.getByText('Ready to install')).toBeTruthy()
      expect(tile(PIXEL)).toBeTruthy()
      expect(tile('Wan 2.1 14B Speed LoRAs · 4 Steps')).toBeTruthy()
      expect(tile(PIXEL).textContent).toMatch(/162\.6 MB/)
      // MiniMax H3 is no longer offered (lib/retired-models).
      expect(tile('MiniMax H3 Turbo LoRA · 8 Steps')).toBeNull()
    })

    it('follows the header search and disappears when nothing matches', async () => {
      const { rerender } = render(<LoraAddons search="pixel" />)
      await waitFor(() => expect(checkBundlesInstalled).toHaveBeenCalled())
      expect(tile(PIXEL)).toBeTruthy()
      expect(tile('Wan 2.1 14B Speed LoRAs · 4 Steps')).toBeNull()
      rerender(<LoraAddons search="film grain" />)
      expect(screen.queryByText('Ready to install')).toBeNull()
    })
  })

  describe('one click', () => {
    it('starts the install of exactly that bundle, with folder, size and sha256 on the download row', async () => {
      render(<LoraAddons />)
      await waitFor(() => expect(checkBundlesInstalled).toHaveBeenCalled())
      fireEvent.click(within(tile(PIXEL)).getByRole('button', { name: /Get/ }))
      await waitFor(() => expect(installBundleComplete).toHaveBeenCalledTimes(1))
      expect(installBundleComplete.mock.calls[0][0].name).toBe(PIXEL)
      expect(store.setMeta).toHaveBeenCalledWith(
        FILE,
        `https://huggingface.co/nerijs/pixel-art-xl/resolve/main/${FILE}`,
        'loras',
        undefined,
        { expectedBytes: Math.round(0.1588 * 1024 ** 3), sha256: '4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7' },
      )
      expect(store.setBundleGroup).toHaveBeenCalledWith(PIXEL, [FILE])
      expect(store.startPolling).toHaveBeenCalled()
    })

    it('a failed install says why, in the list', async () => {
      installBundleComplete.mockRejectedValue(new Error('Not enough space on this drive.'))
      render(<LoraAddons />)
      await waitFor(() => expect(checkBundlesInstalled).toHaveBeenCalled())
      fireEvent.click(within(tile(PIXEL)).getByRole('button', { name: /Get/ }))
      expect(await screen.findByText(`${PIXEL}: Not enough space on this drive.`)).toBeTruthy()
    })
  })

  describe('the tile states', () => {
    it('Installed when the file is on disk at its size', async () => {
      checkBundlesInstalled.mockResolvedValue({ [PIXEL]: true })
      render(<LoraAddons />)
      expect(await within(tile(PIXEL)).findByText('Installed')).toBeTruthy()
      expect(within(tile(PIXEL)).queryByRole('button', { name: /Get/ })).toBeNull()
    })

    it('Installing while the download runs, and the disk is asked again when it is done', async () => {
      store.downloads = { [FILE]: { status: 'downloading', progress: 1, total: 2 } }
      render(<LoraAddons />)
      expect(await within(tile(PIXEL)).findByText(/Installing/)).toBeTruthy()
      const before = checkBundlesInstalled.mock.calls.length
      window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))
      await waitFor(() => expect(checkBundlesInstalled.mock.calls.length).toBe(before + 1))
    })

    it('Retry after an error goes through the store, which clears the failed row first', async () => {
      store.downloads = { [FILE]: { status: 'error' } }
      render(<LoraAddons />)
      await waitFor(() => expect(checkBundlesInstalled).toHaveBeenCalled())
      fireEvent.click(within(tile(PIXEL)).getByRole('button', { name: /Retry/ }))
      expect(store.retry).toHaveBeenCalledWith(FILE)
      expect(installBundleComplete).not.toHaveBeenCalled()
      fireEvent.click(within(tile(PIXEL)).getByRole('button', { name: /Clear/ }))
      expect(store.dismiss).toHaveBeenCalledWith(FILE)
    })
  })
})
