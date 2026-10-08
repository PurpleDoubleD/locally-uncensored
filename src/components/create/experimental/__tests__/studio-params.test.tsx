// @vitest-environment jsdom
//
// Der Studio-Zweig in AdvancedDrawer (Portplan Abschnitt 3b/3c): ein
// Studio-Modell hat keinen Sampler, keinen Scheduler, kein VAE und keine
// LoRA-Liste aus ComfyUI. Bei gesetztem `studioModel` ERSETZT StudioParams
// WorkflowFinder + ParamGroups vollstaendig, statt sie zu ergaenzen, und
// zwar nur dort. Ohne `studioModel` (die lokale Spur, oder Wolke ohne
// Studio-Wahl) bleibt der Drawer, was er war: ParamGroups.tsx selbst wird
// von diesem Paket nicht angefasst, e2e/create-expert-section.spec.ts ist
// der eigentliche Beweis dafuer.
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useCreateStore } from '../../../../stores/createStore'
import { AdvancedDrawer } from '../AdvancedDrawer'
import { StudioParams } from '../StudioParams'
import { studioFieldsInOrder } from '../SchemaControl'
import { useStudioPrice } from '../useStudioPrice'

vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: () => 'sdxl',
  isI2VModel: () => false,
  isT2VCapable: () => false,
}))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

const STUDIO_EXTEND_MODEL = 'preset-wan-2.2-spicy-extend'

afterEach(() => {
  cleanup()
  useCreateStore.setState({ cloudStudioOptions: {}, isGenerating: false })
})

describe('AdvancedDrawer, Studio-Zweig', () => {
  it('rendert StudioParams statt WorkflowFinder+ParamGroups, wenn studioModel gesetzt ist', () => {
    useCreateStore.setState({ backend: 'cloud', mode: 'video' })
    render(createElement(AdvancedDrawer, { open: true, onClose: () => {}, studioModel: STUDIO_EXTEND_MODEL }))
    // Die Ueberschrift der Studio-Regler traegt den Modellnamen.
    expect(screen.getByText(/Wan 2.2 Uncensored Extend/i)).toBeTruthy()
    // Kein einziges Wort des Experten-Abschnitts (der ist ParamGroups' Sache).
    expect(screen.queryByText('Sampler')).toBeNull()
    expect(screen.queryByText('Scheduler')).toBeNull()
    expect(screen.queryByText('Expert')).toBeNull()
    expect(screen.queryByText('LoRA stack')).toBeNull()
  })

  it('zeigt die eigenen Felder des Modells (Resolution, Duration, Seed)', () => {
    useCreateStore.setState({ backend: 'cloud', mode: 'video' })
    render(createElement(AdvancedDrawer, { open: true, onClose: () => {}, studioModel: STUDIO_EXTEND_MODEL }))
    const fields = studioFieldsInOrder(STUDIO_EXTEND_MODEL).map(([key]) => key)
    expect(fields).toContain('resolution')
    expect(fields).toContain('duration')
    for (const key of fields) {
      const label = key.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
      expect(screen.getByText(label), `field "${key}" not rendered`).toBeTruthy()
    }
  })

  it('schreibt eine Aenderung in cloudStudioOptions, nicht in ein eigenes Zwischenlager', () => {
    useCreateStore.setState({ backend: 'cloud', mode: 'video', cloudStudioOptions: {} })
    render(createElement(StudioParams, { model: STUDIO_EXTEND_MODEL }))
    const seedField = screen.getByLabelText(/seed/i, { selector: 'input' }) as HTMLInputElement | null
    if (seedField) {
      fireEvent.change(seedField, { target: { value: '42' } })
      expect(useCreateStore.getState().cloudStudioOptions.seed).toBe(42)
    }
  })

  it('bleibt ohne studioModel bei ParamGroups (lokale Spur unveraendert)', () => {
    useCreateStore.setState({ backend: 'local', mode: 'image' })
    useCreateStore.getState().setIntent('image')
    render(createElement(AdvancedDrawer, { open: true, onClose: () => {} }))
    fireEvent.click(screen.getByText('Expert'))
    expect(screen.getByText('Sampler')).toBeTruthy()
  })

  it('bleibt mit X und Escape schliessbar wie jeder andere Drawer', () => {
    const onClose = vi.fn()
    useCreateStore.setState({ backend: 'cloud', mode: 'video' })
    render(createElement(AdvancedDrawer, { open: true, onClose, studioModel: STUDIO_EXTEND_MODEL }))
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('useStudioPrice, lokale Spur', () => {
  // Portplan P7: "useStudioPrice darf auf der lokalen Spur KEINEN einzigen
  // Netzabruf ausloesen, sonst haengt eine Offline-Installation 500 ms je
  // Tastendruck an einem toten Aufruf." Composer only ever passes a model
  // when `backend === 'cloud' && studioPick`. Undefined stands in for
  // every local-lane render (and every cloud render with no Studio pick).
  it('calls fetch zero times when no model is given', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useStudioPrice(undefined, {}, 'a prompt', undefined))
    expect(result.current).toBeNull()
    // Give the debounce timer (500ms) a chance to fire if it were wrongly
    // armed. Flush microtasks and macrotasks without a real 500ms sleep.
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
