// @vitest-environment jsdom
/**
 * Character Studio on the Mac (14.10.2026): the Use shelf lists the
 * characters in the Mac's LoRA folder (api/mlx-loras), never ComfyUI's list,
 * and picking one brings the Z-Image model it was trained for. The Train tab
 * trains on the Mac (api/mlx-train) once Z-Image Turbo is installed, and
 * says so above its inputs before.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/mac-character-shelf.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const io = vi.hoisted(() => ({
  files: [] as string[], comfy: vi.fn(async () => [] as string[]), open: vi.fn(async () => {}),
  train: null as null | Record<string, unknown>,
}))
vi.mock('../../../../api/mlx-image', async (orig) => ({ ...(await orig<typeof import('../../../../api/mlx-image')>()), isMlxImageHost: () => true }))
vi.mock('../../../../api/mlx-loras', async (orig) => ({
  ...(await orig<typeof import('../../../../api/mlx-loras')>()),
  listMlxLoras: vi.fn(async () => ({ loras: io.files.map((name) => ({ name, bytes: 1 })), folder: '/loras' })),
  openMlxLoraFolder: () => io.open(),
}))
vi.mock('../../../../api/mlx-train', async (orig) => ({
  ...(await orig<typeof import('../../../../api/mlx-train')>()),
  getMacTrainStatus: vi.fn(async () => io.train),
}))
vi.mock('../../../../api/comfyui', async (orig) => ({ ...(await orig<typeof import('../../../../api/comfyui')>()), getLoraModels: () => io.comfy() }))
vi.mock('../../../../api/in-tauri', () => ({ isTauri: () => true }))

import { SpecialControls } from '../SpecialIntentControls'
import { HubWho } from '../hub/CharacterHub'
import { openHubAction, useHubCharacters } from '../hub/hubCharacters'

/** Step 1 of the Character area as the app shows it: every source in one list. */
function Who() {
  const { list, loading } = useHubCharacters()
  return <HubWho list={list} loading={loading} onOpenGallery={() => {}} />
}
import { useCreateStore } from '../../../../stores/createStore'
import type { ClassifiedModel } from '../../../../api/comfyui'

const ZIMAGE: ClassifiedModel = { name: 'MLX Z-Image Turbo 4-bit', type: 'zimage', source: 'checkpoint', editImages: 0 }
const QWEN: ClassifiedModel = { name: 'MLX Qwen-Image 2.1 8-bit', type: 'qwenimage', source: 'checkpoint', editImages: 10 }
const CHAR = 'char_davechar_zimage.safetensors'

function arrange(tab: 'use' | 'train') {
  useCreateStore.setState({
    backend: 'local', error: null, selectedLoras: [], loraStrengths: {}, selectedCharacter: null,
    imageModelList: [QWEN, ZIMAGE], videoModelList: [],
  } as never)
  const s = useCreateStore.getState()
  s.setImageModel(QWEN.name, QWEN.type)
  s.setIntent('character')
  s.setCharacterTab(tab)
}

beforeEach(() => { io.files = [CHAR, 'other-style.safetensors']; io.comfy.mockClear(); io.open.mockClear() })
afterEach(() => cleanup())

describe('Character Studio on the Mac', () => {
  it('lists the characters of the Mac LoRA folder, and a pick brings its Z-Image model', async () => {
    arrange('use')
    // Step 1 lists the folder's characters (since 3.1.0 part B the rows of
    // the Character area), Image is the action that runs one.
    render(<Who />)
    const row = await screen.findByTitle('davechar, trigger word: davechar')
    expect(row.textContent).toContain('Local LoRA')
    expect(screen.queryByRole('button', { name: /other-style/ })).toBeNull()
    expect(io.comfy).not.toHaveBeenCalled()
    fireEvent.click(row)
    const picked = useCreateStore.getState().hubCharacter
    expect(picked?.key).toBe(`mlx:${CHAR}`)
    await act(async () => { await openHubAction('image', picked) })
    cleanup()
    render(<SpecialControls intent="character" />)
    const s = useCreateStore.getState()
    // A Mac character names the Mac's folder in its id (lib/characters MLX_PREFIX).
    expect(s.selectedCharacter).toMatchObject({ id: `mlx:${CHAR}`, triggerWord: 'davechar' })
    expect(s.selectedLoras.map((l) => l.name)).toEqual([CHAR])
    expect(s.imageModel).toBe(ZIMAGE.name)
    expect(await screen.findByTestId('character-use-hint')).toBeTruthy()
  })

  it('says where the files go when the folder has no character', async () => {
    io.files = ['other-style.safetensors']
    arrange('use')
    render(<SpecialControls intent="character" />)
    expect((await screen.findByTestId('mac-no-characters')).textContent).toContain('char_<name>_zimage.safetensors')
    fireEvent.click(screen.getByRole('button', { name: 'Open the LoRA folder' }))
    expect(io.open).toHaveBeenCalledTimes(1)
  })

  it('Train offers the Mac trainer once Z-Image Turbo is there, and says what is missing before', async () => {
    io.train = { engineReady: true, base: 'z-image-turbo-4bit', adapterReady: false, adapterBytes: 340_194_488, minRamGB: 24, memoryRefusal: null, running: false }
    arrange('train')
    render(<SpecialControls intent="character" />)
    expect((await screen.findByTestId('mac-train-hint')).textContent).toMatch(/Runs on this Mac.*340 MB training adapter/)
    expect(screen.getByPlaceholderText('Trigger word, e.g. davechar')).toBeTruthy()
    // No musubi setup and no base download of the Windows trainer.
    expect(screen.queryByText(/Set up trainer|Download base files/)).toBeNull()
    fireEvent.click(screen.getByTestId('mac-train-open-folder'))
    expect(io.open).toHaveBeenCalledTimes(1)
    cleanup()

    io.train = { ...io.train, base: null }
    arrange('train')
    render(<SpecialControls intent="character" />)
    expect((await screen.findByTestId('mac-train-note')).textContent).toMatch(/needs Z-Image Turbo/)
    // GH #194: the trigger word field stays (mac-train-zeigt-das-trigger-feld.test.tsx).
    expect(screen.getByPlaceholderText('Trigger word, e.g. davechar')).toBeTruthy()
    cleanup()

    io.train = { ...io.train, base: 'z-image-turbo-4bit', memoryRefusal: 'Training a character needs a Mac with 24 GB of memory, and this one has 16 GB.' }
    arrange('train')
    render(<SpecialControls intent="character" />)
    expect((await screen.findByTestId('mac-train-note')).textContent).toMatch(/24 GB/)
  })
})
