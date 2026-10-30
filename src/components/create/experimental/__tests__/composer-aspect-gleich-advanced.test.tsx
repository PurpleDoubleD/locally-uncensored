// @vitest-environment jsdom
/**
 * B49 (3.0.9, Discord 30.10.2026): 16:9 in the Composer set
 * 1024x576, 16:9 in Advanced settings 1360x768 for the same model. Both now
 * keep the pixel budget the user has set (lib/create-resolution applyAspect).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

const host = vi.hoisted(() => ({ mac: false }))

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isMlxImageHost: () => host.mac,
}))
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openExternal: vi.fn(),
}))

import { Composer } from '../Composer'
import { useCreateStore } from '../../../../stores/createStore'
import { applyAspect, ASPECT_RATIOS } from '../../../../lib/create-resolution'

beforeEach(() => {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], source: null,
    imageModel: 'sd_xl_base_1.0.safetensors', imageModelType: 'sdxl', width: 1024, height: 1024,
  } as never)
  useCreateStore.getState().setIntent('image')
})
afterEach(cleanup)

describe('B49: one 16:9 for the Composer and Advanced settings', () => {
  it('every ratio of the Composer gives the size the button in Advanced gives', () => {
    render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
    for (const label of ['16:9', '4:3', '3:4', '1:1']) {
      useCreateStore.setState({ width: 1024, height: 1024 })
      const r = ASPECT_RATIOS.find((a) => a.label === label)!
      const advanced = applyAspect(1024, 1024, r.w, r.h)
      fireEvent.click(screen.getByRole('radio', { name: label }))
      const s = useCreateStore.getState()
      expect([label, s.width, s.height]).toEqual([label, advanced.width, advanced.height])
    }
    useCreateStore.setState({ width: 1024, height: 1024 })
    fireEvent.click(screen.getByRole('radio', { name: '16:9' }))
    expect([useCreateStore.getState().width, useCreateStore.getState().height]).toEqual([1360, 768])
  })
})
