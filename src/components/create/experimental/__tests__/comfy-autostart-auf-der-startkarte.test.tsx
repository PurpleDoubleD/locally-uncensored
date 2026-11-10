// @vitest-environment jsdom
/**
 * C50 (3.1.0, Discord 06.11.): "Start ComfyUI when LU starts"
 * was only in Settings → AI Backends → ComfyUI, folded away under the port.
 * The Create card that offers "Start ComfyUI" now carries the same switch,
 * reading and writing the setting Settings uses.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/comfy-autostart-auf-der-startkarte.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'

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
vi.mock('../../../../api/discover', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkBundlesOnDisk: vi.fn(async (bundles: Array<{ name: string }>) =>
    ({ installed: Object.fromEntries(bundles.map((b) => [b.name, onDisk])), files: new Set<string>() })),
}))

let comfy: Record<string, unknown> = {}
let failWrite = false
const calls: Array<[string, unknown]> = []
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  backendCall: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push([cmd, args])
    if (cmd === 'comfyui_status') return comfy
    if (cmd === 'set_comfyui_autostart') {
      if (failWrite) throw new Error('no')
      return { status: 'saved' }
    }
    return null
  }),
}))

import { Stage } from '../Stage'
import { useCreateStore } from '../../../../stores/createStore'

const stage = () => render(<Stage onOpenMaskEditor={() => {}} onFullscreen={() => {}} />)
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
const box = () => screen.queryByRole('checkbox', { name: 'Start ComfyUI when LU starts' }) as HTMLInputElement | null

beforeEach(() => {
  connected = false
  onDisk = true
  failWrite = false
  calls.length = 0
  comfy = { found: true, running: false, isLocal: true, autostart: false }
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], source: null,
    upscaleModelList: [], imageModelList: [],
  } as never)
  useCreateStore.getState().setIntent('image')
})
afterEach(cleanup)

describe('C50: the Start ComfyUI card carries the autostart switch', () => {
  it('shows it under Start ComfyUI, with the saved answer', async () => {
    stage()
    await settle()
    expect(screen.getByRole('button', { name: /Start ComfyUI/ })).toBeTruthy()
    expect(box()?.checked).toBe(false)
    cleanup()
    comfy = { ...comfy, autostart: true }
    stage()
    await settle()
    expect(box()?.checked).toBe(true)
  })

  it('a click saves it the way Settings does', async () => {
    stage()
    await settle()
    fireEvent.click(box()!)
    await settle()
    expect(calls).toContainEqual(['set_comfyui_autostart', { enabled: true }])
    expect(box()?.checked).toBe(true)
  })

  it('a failed save puts the box back', async () => {
    failWrite = true
    stage()
    await settle()
    fireEvent.click(box()!)
    await settle()
    expect(box()?.checked).toBe(false)
  })

  it('not for a remote ComfyUI, an unknown install, or the download card', async () => {
    comfy = { found: true, isLocal: false, autostart: false }
    stage()
    await settle()
    expect(screen.getByRole('button', { name: /Start ComfyUI/ })).toBeTruthy()
    expect(box()).toBeNull()
    cleanup()
    comfy = { found: false, isLocal: true, autostart: false }
    stage()
    await settle()
    expect(box()).toBeNull()
    cleanup()
    comfy = { found: true, isLocal: true, autostart: false }
    onDisk = false
    stage()
    await settle()
    expect(screen.getByRole('button', { name: /Download & install/ })).toBeTruthy()
    expect(box()).toBeNull()
  })
})
