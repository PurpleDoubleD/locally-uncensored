// @vitest-environment jsdom
/**
 * 3.0.8 D28 und D20 an der Oberflaeche und im Zustand: die Textzeile unter
 * jedem Trainingsfoto, die Erklaerzeile, der Weg der Beschriftung bis zum
 * Trainer, und der Schalter Normal / Low VRAM mit dem Vorschlag zur Karte.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/beschriftung-und-wenig-vram-oberflaeche.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const h = vi.hoisted(() => ({ mac: false, cardGb: 8 as number | null }))

vi.mock('../../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  backendCall: vi.fn(async () => ({ status: 'ok' })),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => h.mac }))
vi.mock('../../../../hooks/useGraphicsMemory', () => ({ useGraphicsCardGb: () => h.cardGb }))
vi.mock('../../../../lib/render/describe-train-photos', () => ({
  describeAvailability: vi.fn(async () => ({ available: false, hint: 'Pick a local chat model that can see images in Chat first.' })),
  describeTrainPhoto: vi.fn(async () => null),
}))
vi.mock('../../../../api/trainer', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/trainer')>('../../../../api/trainer')
  return {
    ...actual,
    characterTrainerStatus: vi.fn(async () => ({
      envReady: true, basesReady: true, dit: 'd', textEncoder: 't', vae: 'v',
      root: '/data/lu/musubi', customized: false, suggestedRoot: null,
      install: { status: 'done', logs: [] },
    })),
  }
})
vi.mock('../../../../api/comfyui', () => ({ getLoraModels: vi.fn(async () => []) }))
vi.mock('../../../../api/cloud/loras', () => ({ listLoras: vi.fn(async () => []), deleteLora: vi.fn() }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ generate: vi.fn(), cancel: vi.fn(), quota: null, connected: true, modelsLoaded: true }),
}))

import { TrainSetBoard } from '../Stage'
import { SpecialControls } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'
import type { MediaRef } from '../../../../stores/createStore'

const photo = (name: string): MediaRef => ({ name, url: `blob:${name}`, blob: new Blob([name], { type: 'image/png' }) } as MediaRef)

beforeEach(() => {
  cleanup()
  h.mac = false
  h.cardGb = 8
  useCreateStore.setState({
    backend: 'local', characterTab: 'train', isGenerating: false,
    trainImages: [photo('a.png'), photo('b.png'), photo('c.png'), photo('d.png')],
    trainCaptions: {}, trainVramPreset: 'standard', triggerWord: 'davechar', trainKind: 'character', trainSteps: 1200,
  } as never)
})

describe('die Textzeile unter jedem Foto (D28)', () => {
  it('lokal: ein Feld je Foto, eine Erklaerzeile, und der Knopf Describe photos', async () => {
    render(<TrainSetBoard />)
    const fields = screen.getAllByPlaceholderText('e.g. red jacket, short hair, beach')
    expect(fields).toHaveLength(4)
    expect(screen.getByTestId('train-caption-help').textContent).toContain('What you name there is not learned into the trigger word')
    const describeBtn = screen.getByRole('button', { name: 'Describe photos' }) as HTMLButtonElement
    // Ohne lokales Vision-Modell aus, mit dem Grund im Tooltip.
    await vi.waitFor(() => expect(describeBtn.title).toContain('local chat model'))
    expect(describeBtn.disabled).toBe(true)
  })

  it('was getippt wird, landet je Foto im Zustand und geht mit dem Foto', () => {
    render(<TrainSetBoard />)
    const [first] = screen.getAllByPlaceholderText('e.g. red jacket, short hair, beach')
    fireEvent.change(first, { target: { value: 'red jacket, beach' } })
    expect(useCreateStore.getState().trainCaptions).toEqual({ 'a.png': 'red jacket, beach' })
    useCreateStore.getState().removeTrainImage('a.png')
    expect(useCreateStore.getState().trainCaptions).toEqual({})
  })

  it('leer geraeumt heisst: kein Eintrag, also die bisherige Zeile', () => {
    useCreateStore.getState().setTrainCaption('b.png', 'blue dress')
    useCreateStore.getState().setTrainCaption('b.png', '   ')
    expect(useCreateStore.getState().trainCaptions).toEqual({})
    // Fuer ein Foto, das es nicht gibt, wird nichts gemerkt.
    useCreateStore.getState().setTrainCaption('nope.png', 'x')
    expect(useCreateStore.getState().trainCaptions).toEqual({})
  })

  it('Cloud zeigt kein Feld (der Cloud-Trainer nimmt nur Fotos), der Mac schon (mflux liest die .txt)', () => {
    useCreateStore.setState({ backend: 'cloud' })
    const { unmount } = render(<TrainSetBoard />)
    expect(screen.queryAllByPlaceholderText('e.g. red jacket, short hair, beach')).toHaveLength(0)
    expect(screen.queryByTestId('train-caption-help')).toBeNull()
    unmount()
    useCreateStore.setState({ backend: 'local' })
    h.mac = true
    render(<TrainSetBoard />)
    expect(screen.getAllByPlaceholderText('e.g. red jacket, short hair, beach')).toHaveLength(4)
  })

  it('der Lauf gibt jedem Foto seine Zeile und dem Trainer das Rezept', () => {
    const src = readFileSync(resolve(__dirname, '../../../../hooks/useCreate.ts'), 'utf8')
    expect(src).toContain('buildTrainCaption(trigger, state.trainCaptions[img.name])')
    expect(src).toContain('startCharacterTraining(setId, trigger, trigger, state.trainSteps, state.trainVramPreset, kind)')
    expect(src).not.toContain('`${trigger}, a photo of ${trigger}`')
  })
})

describe('Normal / Low VRAM (D20)', () => {
  it('eine 8-GB-Karte bekommt den Vorschlag, ein Klick waehlt Low VRAM, dann steht der Satz zu Dauer und Qualitaet da', async () => {
    render(<SpecialControls intent="character" />)
    const hint = await screen.findByTestId('low-vram-suggestion')
    expect(hint.textContent).toContain('This card has 8 GB. Normal training needs 11 GB')
    fireEvent.click(screen.getByRole('button', { name: 'Use Low VRAM' }))
    expect(useCreateStore.getState().trainVramPreset).toBe('low-vram')
    expect(screen.queryByTestId('low-vram-suggestion')).toBeNull()
    expect(screen.getByTestId('low-vram-note').textContent).toContain('Each step takes clearly longer than Normal')
  })

  it('auf dem Mac gibt es weder Schalter noch Vorschlag (D20 gilt nur fuer CUDA)', async () => {
    h.mac = true
    render(<SpecialControls intent="character" />)
    await screen.findAllByTestId(/mac-train/)
    expect(screen.queryByRole('radio', { name: 'Low VRAM' })).toBeNull()
    expect(screen.queryByTestId('low-vram-suggestion')).toBeNull()
  })

  it('der Schalter selbst waehlt beide Rezepte', async () => {
    h.cardGb = 12
    render(<SpecialControls intent="character" />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Low VRAM' }))
    expect(useCreateStore.getState().trainVramPreset).toBe('low-vram')
    fireEvent.click(screen.getByRole('radio', { name: 'Normal' }))
    expect(useCreateStore.getState().trainVramPreset).toBe('standard')
    expect(screen.queryByTestId('low-vram-suggestion'), 'eine 12-GB-Karte braucht keinen Vorschlag').toBeNull()
  })

  it('das Rezept wird gespeichert (create-store, also auch im Backup), die Beschriftungen nicht', async () => {
    useCreateStore.setState({ trainVramPreset: 'low-vram', trainCaptions: { 'a.png': 'red jacket' } })
    const persist = (useCreateStore as unknown as { persist: { getOptions: () => { partialize: (s: unknown) => Record<string, unknown>; merge: (p: unknown, c: unknown) => Record<string, unknown> } } }).persist
    const saved = persist.getOptions().partialize(useCreateStore.getState())
    expect(saved.trainVramPreset).toBe('low-vram')
    expect('trainCaptions' in saved).toBe(false)
    const backup = readFileSync(resolve(__dirname, '../../../../lib/store-backup.ts'), 'utf8')
    expect(backup).toContain("'create-store'")
    // Ein fremder Blob bringt weder Beschriftungen noch einen unbekannten Namen zurueck.
    const merged = persist.getOptions().merge({ trainVramPreset: 'ultra', trainCaptions: { x: 'y' } }, { ...useCreateStore.getState(), trainCaptions: {} })
    expect(merged.trainVramPreset).toBe('standard')
    expect(merged.trainCaptions).toEqual({})
  })
})

describe('3.0.9 P8: Style / concept', () => {
  it('fragt je Bild nach dem Inhalt, nicht nach dem, was sich an einer Person aendert', () => {
    useCreateStore.getState().setTrainKind('style')
    render(<TrainSetBoard />)
    expect(screen.getAllByPlaceholderText('e.g. a fox in a forest')).toHaveLength(4)
    expect(screen.queryAllByPlaceholderText('e.g. red jacket, short hair, beach')).toHaveLength(0)
    expect(screen.getByTestId('train-caption-help').textContent).toContain('what is left unnamed is what the LoRA learns')
    expect(screen.getByText(/lands the style in your local LoRAs/)).toBeTruthy()
  })

  it('der Waehler steht auch im Windows-Trainer, mit den Stufen des Stils', async () => {
    render(<SpecialControls intent="character" />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Style / concept' }))
    expect(screen.getByPlaceholderText('Name, e.g. inkwash')).toBeTruthy()
    expect(screen.getByText(/Standard, 1600 steps.*The style lands in your local LoRAs/)).toBeTruthy()
    // Normal / Low VRAM bleibt, der Stil laeuft auf demselben Rezept.
    expect(screen.getByRole('radio', { name: 'Low VRAM' })).toBeTruthy()
  })
})
