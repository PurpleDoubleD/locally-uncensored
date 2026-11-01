// @vitest-environment jsdom
/**
 * GH #209 (31.10.2026): "after downloading like 40 Gigs … the software just
 * continues to ask to download 20 Gigs of model despite already having
 * downloaded everything once". The Create setup card also opens while
 * ComfyUI is down, and then read "needs a one-time download" with a
 * Download & install button over files that were all on disk. With the
 * lane's bundle complete, the card now says the files are here and offers
 * to start ComfyUI. Without them it still offers the download.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/setup-card-knows-the-files-are-here.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'

let connected: boolean | null = false
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))

let onDisk = true
const asked: string[] = []
vi.mock('../../../../api/discover', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkBundlesOnDisk: vi.fn(async (bundles: Array<{ name: string }>) => {
    asked.push(...bundles.map((b) => b.name))
    return { installed: Object.fromEntries(bundles.map((b) => [b.name, onDisk])), files: new Set<string>() }
  }),
}))

import { Stage } from '../Stage'
import { useCreateStore } from '../../../../stores/createStore'

const stage = () => render(<Stage onOpenMaskEditor={() => {}} onFullscreen={() => {}} />)
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

beforeEach(() => {
  connected = false
  onDisk = true
  asked.length = 0
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], source: null,
    upscaleModelList: [], imageModelList: [],
  } as never)
  useCreateStore.getState().setIntent('upscale')
})
afterEach(cleanup)

describe('the Create setup card while ComfyUI is down', () => {
  it('says the files are here and offers to start ComfyUI, not a download', async () => {
    stage()
    await settle()
    expect(asked.length).toBeGreaterThan(0)
    expect(screen.getByText('Your model files are already here')).toBeTruthy()
    expect(screen.getByText(/nothing on disk is downloaded again/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Start ComfyUI/ })).toBeTruthy()
    expect(screen.queryByText('Local Enhance Image needs a one-time download')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download & install/ })).toBeNull()
  })

  it('still offers the download when the files are not there', async () => {
    onDisk = false
    stage()
    await settle()
    expect(screen.getByText('Local Enhance Image needs a one-time download')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Download & install/ })).toBeTruthy()
  })

  it('does not ask the disk at all while ComfyUI runs', async () => {
    connected = true
    stage()
    await settle()
    expect(asked).toEqual([])
    expect(screen.getByText('Local Enhance Image needs a one-time download')).toBeTruthy()
  })

  it('the image lane says the same over its 6.5 GB starter', async () => {
    useCreateStore.getState().setIntent('image')
    stage()
    await settle()
    expect(screen.getByText('Your model files are already here')).toBeTruthy()
  })
})
