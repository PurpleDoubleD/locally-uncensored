// @vitest-environment jsdom
/**
 * 3.0.9 P8 (Discord, 28.10.2026): the Train tab offers "Style / concept" next
 * to "Character". The switch says what the mode is for, renames the field,
 * brings its own step presets and the trigger word choice, and the photo board
 * asks for the content of each picture instead of what changes on a person.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/train-kind-oberflaeche.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../../api/mlx-image', async (orig) => ({ ...(await orig<typeof import('../../../../api/mlx-image')>()), isMlxImageHost: () => true }))
vi.mock('../../../../api/mlx-train', async (orig) => ({
  ...(await orig<typeof import('../../../../api/mlx-train')>()),
  getMacTrainStatus: vi.fn(async () => ({ engineReady: true, base: 'z-image-turbo-4bit', adapterReady: true, adapterBytes: 340_194_488, minRamGB: 24, memoryRefusal: null, running: false })),
}))

import { SpecialControls } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'
import { STYLE_MODE_NOTE, STYLE_TRIGGER_HINT_OFF } from '../../../../lib/train-kind'

function arrange() {
  useCreateStore.setState({ backend: 'local', error: null, triggerWord: '', trainImages: [], trainKind: 'character', trainSteps: 1200, trainStyleTrigger: true } as never)
  const s = useCreateStore.getState()
  s.setIntent('character')
  s.setCharacterTab('train')
}

afterEach(() => cleanup())

describe('the Style / concept mode in the Train tab', () => {
  it('starts as Character, as before', async () => {
    arrange()
    render(<SpecialControls intent="character" />)
    await screen.findByPlaceholderText('Trigger word, e.g. davechar')
    expect(screen.getByRole('radio', { name: 'Character' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('style-mode-note')).toBeNull()
    expect(screen.getByTestId('mac-train-hint').textContent).toMatch(/Standard, 1200 steps.*The character lands/)
  })

  it('switching says what it is for, renames the field and takes its own steps', async () => {
    arrange()
    render(<SpecialControls intent="character" />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Style / concept' }))
    expect(useCreateStore.getState().trainKind).toBe('style')
    expect(screen.getByTestId('style-mode-note').textContent).toBe(STYLE_MODE_NOTE)
    expect(screen.getByPlaceholderText('Name, e.g. inkwash')).toBeTruthy()
    expect(useCreateStore.getState().trainSteps).toBe(1600)
    expect(screen.getByTestId('mac-train-hint').textContent).toMatch(/Standard, 1600 steps.*The style lands/)
    fireEvent.click(screen.getByRole('radio', { name: 'Thorough' }))
    expect(useCreateStore.getState().trainSteps).toBe(3000)
  })

  it('the trigger word is a choice, and the hint says what leaving it out means', async () => {
    arrange()
    useCreateStore.getState().setTrainKind('style')
    render(<SpecialControls intent="character" />)
    const box = await screen.findByTestId('style-trigger') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(useCreateStore.getState().trainStyleTrigger).toBe(false)
    expect(screen.getByTestId('style-trigger-hint').textContent).toBe(STYLE_TRIGGER_HINT_OFF)
  })

  it('COUNTER-CHECK: the cloud trains characters only and shows no switch', async () => {
    arrange()
    useCreateStore.setState({ backend: 'cloud' } as never)
    render(<SpecialControls intent="character" />)
    await screen.findByPlaceholderText('Trigger word, e.g. davechar')
    expect(screen.queryByTestId('train-kind')).toBeNull()
  })
})
