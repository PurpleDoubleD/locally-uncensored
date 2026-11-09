/**
 * @vitest-environment jsdom
 *
 * 3.1.0, Models comfort (Discord feature requests), on the rendered
 * page:
 *  - "Better Categories": the chips filter Get new by what a model is for.
 *  - C22: the filters of a lane survive leaving the page and coming back.
 *  - C17: a bundle's bin opens a dialog that lists every file and the space,
 *    keeps a file another installed model needs, and deletes only on Uninstall.
 *
 * Lauf: npx vitest run src/components/models/__tests__/models-komfort-310.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

const backendCall = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => []))

vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  backendCall,
  openExternal: vi.fn(),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/comfyui')>()),
  getSystemVRAM: vi.fn(async () => 24),
  readComfyFolderLists: vi.fn(async () => ({})),
  refreshComfyModels: vi.fn(async () => {}),
}))
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ pullModel: vi.fn(), models: [], fetchModels: async () => {}, setActiveModel: vi.fn() }),
}))
vi.mock('../../../lib/hardware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => 24),
  getTotalRamGb: vi.fn(async () => 64),
}))
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

// The disk of the test: which bundle files exist, and how big.
const onDisk = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../api/discover', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../api/discover')>()
  return {
    ...real,
    checkBundlesOnDisk: vi.fn(async (bundles: import('../../../api/discover').ModelBundle[]) => {
      const installed: Record<string, boolean> = {}
      const files = new Set<string>()
      for (const b of bundles) {
        const fs = b.files.filter((f) => f.filename)
        for (const f of fs) if (onDisk.has(f.filename!)) files.add(f.filename!)
        installed[b.name] = fs.length > 0 && fs.every((f) => onDisk.has(f.filename!))
      }
      return { installed, files }
    }),
    comfyModelInfo: vi.fn(async (name: string) => {
      if (!onDisk.has(name)) throw new Error('not found')
      return { path: `/test-models/${name}`, folder: '/test-models', bytes: onDisk.get(name)!, modified: null, ownFolder: false, copies: 1 }
    }),
    deleteComfyModelFile: vi.fn(async (name: string) => {
      const bytes = onDisk.get(name) ?? 0
      onDisk.delete(name)
      return { bytes }
    }),
  }
})

import { DiscoverModels } from '../DiscoverModels'
import * as discover from '../../../api/discover'
import { getVideoBundles } from '../../../api/discover'

beforeEach(() => {
  onDisk.clear()
  backendCall.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The page opens on Mainstream; a bundle marked uncensored is under Unfiltered.
const MAINSTREAM_VIDEO = getVideoBundles().find((b) => !b.uncensored && !b.i2v && b.tags.includes('Quality'))!.name

describe('Better Categories', () => {
  it('the Video tab filters to Music and back to All', async () => {
    render(<DiscoverModels category="video" />)
    const music = await screen.findByTestId('discover-category-music')
    expect(music.textContent).toMatch(/Music\s*\d+/)
    fireEvent.click(music)
    expect(music.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toContain('ACE Step 1.5')
      // A video model is filtered away.
      expect(text).not.toContain(MAINSTREAM_VIDEO)
    })
    fireEvent.click(screen.getByTestId('discover-category-all'))
    await waitFor(() => expect(document.body.textContent).toContain(MAINSTREAM_VIDEO))
  })

  it('C22: the category of a lane is still picked after leaving and coming back', async () => {
    const first = render(<DiscoverModels category="video" />)
    fireEvent.click(await screen.findByTestId('discover-category-music'))
    fireEvent.change(screen.getByTestId('discover-sort'), { target: { value: 'smallest' } })
    first.unmount()
    render(<DiscoverModels category="video" />)
    expect((await screen.findByTestId('discover-category-music')).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('discover-sort') as HTMLSelectElement).value).toBe('smallest')
  })

  it('GEGENPROBE: each lane keeps its own filter', async () => {
    const first = render(<DiscoverModels category="video" />)
    fireEvent.click(await screen.findByTestId('discover-category-music'))
    first.unmount()
    render(<DiscoverModels category="image" />)
    expect((await screen.findByTestId('discover-category-all')).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('C17: uninstall a bundle with all its files', () => {
  // Two installed bundles that share their text encoder and VAE.
  const pick = () => {
    const all = getVideoBundles().filter((b) => !b.uncensored)
    const byFile = new Map<string, string[]>()
    for (const b of all) for (const f of b.files) if (f.filename) byFile.set(f.filename, [...(byFile.get(f.filename) ?? []), b.name])
    const a = all.find((b) => b.files.some((f) => f.filename && (byFile.get(f.filename)?.length ?? 0) > 1) && b.files.some((f) => f.filename && byFile.get(f.filename)?.length === 1))!
    const shared = a.files.find((f) => f.filename && (byFile.get(f.filename)?.length ?? 0) > 1)!
    const other = all.find((b) => b.name !== a.name && b.files.some((f) => f.filename === shared.filename))!
    return { a, other, shared }
  }

  it('lists the files, keeps the shared one, frees only what is the model\'s own', async () => {
    const { a, other, shared } = pick()
    for (const f of [...a.files, ...other.files]) if (f.filename) onDisk.set(f.filename, 1_000_000)
    render(<DiscoverModels category="video" />)
    const tile = await waitFor(() => {
      const bins = screen.getAllByTestId('bundle-uninstall')
      const bin = bins.find((b) => b.getAttribute('aria-label') === `Uninstall ${a.name}`)
      if (!bin) throw new Error('no bin yet')
      return bin
    })
    fireEvent.click(tile)
    const dialog = await screen.findByTestId('uninstall-dialog')
    await within(dialog).findByTestId('uninstall-summary')
    const kept = within(dialog).getAllByTestId('uninstall-file-keep').map((e) => e.textContent ?? '')
    expect(kept.some((t) => t.includes(other.name))).toBe(true)
    const going = within(dialog).getAllByTestId('uninstall-file-delete')
    expect(going.length).toBeGreaterThan(0)
    // Nothing is deleted before the click.
    expect(discover.deleteComfyModelFile).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByTestId('uninstall-confirm'))
    await within(dialog).findByTestId('uninstall-done')
    const deleted = vi.mocked(discover.deleteComfyModelFile).mock.calls.map((c) => c[0])
    expect(deleted).not.toContain(shared.filename)
    expect(onDisk.has(shared.filename!)).toBe(true)
  })

  it('GEGENPROBE: Cancel deletes nothing', async () => {
    const { a } = pick()
    for (const f of a.files) if (f.filename) onDisk.set(f.filename, 5)
    vi.mocked(discover.deleteComfyModelFile).mockClear()
    render(<DiscoverModels category="video" />)
    const bin = await waitFor(() => {
      const b = screen.getAllByTestId('bundle-uninstall').find((x) => x.getAttribute('aria-label') === `Uninstall ${a.name}`)
      if (!b) throw new Error('no bin yet')
      return b
    })
    fireEvent.click(bin)
    const dialog = await screen.findByTestId('uninstall-dialog')
    await within(dialog).findByTestId('uninstall-summary')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(discover.deleteComfyModelFile).not.toHaveBeenCalled()
  })
})
