// @vitest-environment jsdom
/**
 * D6 (3.0.7): ein trainierter lokaler Charakter laesst sich loeschen.
 *
 * Seit 3.1.0 Teil B steht der Knopf unter "More options" des Bereichs
 * Character, Aktion Image, fuer den in Schritt 1 gewaehlten Charakter.
 *
 * Create, Character, Use character zeigt die lokalen Charaktere aus
 * `models/loras` (`char_<name>_zimage.safetensors`). Die Cloud-Liste hatte
 * einen Papierkorb-Knopf, die lokale nicht: wer einen misslungenen Charakter
 * loswerden wollte, musste die Datei im Ordner suchen.
 *
 * Diese Datei nagelt fest: der Knopf fragt erst nach, die Datei geht ueber
 * delete_comfy_model mit `trash: true` in den Papierkorb (nie endgueltig),
 * danach sind Auswahl und LoRA-Haken los und die Liste wird neu gelesen.
 * Abbrechen tut nichts, ein Fehler wird gezeigt und laesst die Auswahl stehen.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/ein-lokaler-charakter-laesst-sich-loeschen.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const backendCall = vi.fn(async (..._a: unknown[]) => ({ status: 'trashed', bytes: 1 }))
vi.mock('../../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  backendCall: (...a: unknown[]) => backendCall(...a),
}))
const loraFiles = ['char_anna_zimage.safetensors', 'chars/char_bob_zimage.safetensors', 'style.safetensors']
const getLoraModels = vi.fn(async () => loraFiles)
const refreshComfyModels = vi.fn(async () => true)
vi.mock('../../../../api/comfyui', () => ({
  getLoraModels: () => getLoraModels(),
  refreshComfyModels: () => refreshComfyModels(),
}))
vi.mock('../../../../api/cloud/loras', () => ({ listLoras: vi.fn(async () => []), deleteLora: vi.fn() }))

import { SpecialMore } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'
import { listLocalCharacters, characterFromLora } from '../../../../lib/characters'
import { hubFromLocal } from '../../../../lib/create/character-hub'

/** The character picked in step 1, and its More options. */
function showMore(file: string) {
  useCreateStore.setState({ hubCharacter: hubFromLocal(characterFromLora(file)!) })
  return render(<SpecialMore intent="character" />)
}

const ANNA = 'char_anna_zimage.safetensors'

beforeEach(() => {
  cleanup()
  backendCall.mockClear()
  getLoraModels.mockClear()
  refreshComfyModels.mockClear()
  useCreateStore.setState({
    backend: 'local',
    characterTab: 'use',
    selectedCharacter: { id: `local:${ANNA}`, name: 'anna', triggerWord: 'anna', family: 'z-image' },
    selectedLoras: [{ name: ANNA, strength: 1 }, { name: 'style.safetensors', strength: 1 }],
    charactersVersion: 0,
  })
})

async function deleteButton(file = ANNA) {
  showMore(file)
  return screen.findByTestId('local-character-delete')
}

describe('ein lokaler Charakter laesst sich loeschen', () => {
  it('jeder lokale Charakter hat einen Loeschknopf, die fremde LoRA ist keiner', async () => {
    const refs = await listLocalCharacters()
    expect(refs.map((r) => r.name)).toEqual(['anna', 'bob'])
    const labels: (string | null)[] = []
    for (const ref of refs) {
      useCreateStore.setState({ hubCharacter: hubFromLocal(ref) })
      const view = render(<SpecialMore intent="character" />)
      labels.push((await screen.findByTestId('local-character-delete')).getAttribute('aria-label'))
      view.unmount()
    }
    expect(labels).toEqual(['Delete character anna', 'Delete character bob'])
  })

  it('der Knopf fragt erst nach, Abbrechen loescht nichts', async () => {
    fireEvent.click(await deleteButton())
    expect(screen.getByText(/Recycle Bin, so you can put it back/)).toBeTruthy()
    expect(backendCall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => expect(screen.queryByTestId('local-character-delete-confirm')).toBeNull())
    expect(backendCall).not.toHaveBeenCalled()
    expect(useCreateStore.getState().selectedCharacter?.id).toBe(`local:${ANNA}`)
  })

  it('bestaetigt geht die Datei in den Papierkorb, Auswahl und LoRA-Haken sind los, die Liste wird neu gelesen', async () => {
    fireEvent.click(await deleteButton())
    fireEvent.click(screen.getByTestId('local-character-delete-confirm'))

    await waitFor(() => expect(useCreateStore.getState().charactersVersion).toBe(1))
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(backendCall.mock.calls[0][0]).toBe('delete_comfy_model')
    expect(backendCall.mock.calls[0][1]).toMatchObject({ filename: ANNA, trash: true })
    const s = useCreateStore.getState()
    expect(s.selectedCharacter).toBeNull()
    expect(s.selectedLoras.map((l) => l.name)).toEqual(['style.safetensors'])
    expect(refreshComfyModels).toHaveBeenCalled()
    // The list of step 1 reads the folder again (charactersVersion), and the
    // area goes back to it: the character is gone.
    expect(s.hubCharacter).toBeNull()
    expect(s.hubStep).toBe('who')
  })

  it('ein Charakter im Unterordner wird mit seinem vollen Namen geloescht', async () => {
    fireEvent.click(await deleteButton('chars/char_bob_zimage.safetensors'))
    fireEvent.click(screen.getByTestId('local-character-delete-confirm'))
    await waitFor(() => expect(backendCall).toHaveBeenCalledTimes(1))
    expect(backendCall.mock.calls[0][1]).toMatchObject({ filename: 'chars/char_bob_zimage.safetensors', trash: true })
    // Ein anderer Charakter geht, die Auswahl von anna bleibt.
    await waitFor(() => expect(useCreateStore.getState().charactersVersion).toBe(1))
    expect(useCreateStore.getState().selectedCharacter?.id).toBe(`local:${ANNA}`)
  })

  it('ein Fehler wird gezeigt, die Auswahl bleibt stehen', async () => {
    backendCall.mockImplementationOnce(async () => { throw new Error('Could not move char_anna_zimage.safetensors to the Recycle Bin: busy') })
    fireEvent.click(await deleteButton())
    fireEvent.click(screen.getByTestId('local-character-delete-confirm'))
    expect(await screen.findByText(/Could not move char_anna_zimage.safetensors/)).toBeTruthy()
    const s = useCreateStore.getState()
    expect(s.selectedCharacter?.id).toBe(`local:${ANNA}`)
    expect(s.selectedLoras.map((l) => l.name)).toContain(ANNA)
    expect(s.charactersVersion).toBe(0)
  })
})
