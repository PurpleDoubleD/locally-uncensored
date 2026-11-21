// @vitest-environment jsdom
/**
 * The three dots next to the picked character (David, 19.11.2026): no card
 * on the stage, what a character can do sits in a list of the model choice's
 * make (lu-elevated lu-picker), lifted to the body.
 *   - "Just use a photo" has no dots;
 *   - the rows follow the kind of character: Rename for all, Train a model
 *     for saved photo characters, Delete for photo characters, local LoRA
 *     files and cloud LoRAs, Download and Use locally for cloud LoRAs;
 *   - Escape and a click beside close it;
 *   - Rename puts the field where the name of the tab was;
 *   - Delete asks in one plain line under the row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const io = vi.hoisted(() => ({ deletedLoras: [] as string[], localDeletePressed: 0, downloads: 0 }))
vi.mock('../../../../../api/cloud/loras', async (orig) => ({
  ...(await orig<typeof import('../../../../../api/cloud/loras')>()),
  deleteLora: vi.fn(async (id: string) => { io.deletedLoras.push(id) }),
}))
vi.mock('../../CharacterUseLocally', () => ({
  CharacterUseLocally: () => <button type="button" data-testid="character-use-locally" />,
  refreshLocalShelves: vi.fn(async () => undefined),
}))
vi.mock('../../SpecialIntentControls', () => ({
  CharacterDownload: () => <button type="button" data-testid="character-download" onClick={() => { io.downloads++ }} />,
  LocalCharacterDelete: ({ trigger }: { trigger: string }) => (
    <button type="button" data-testid="local-character-delete" aria-label={`Delete character ${trigger}`} onClick={() => { io.localDeletePressed++ }}>Delete</button>
  ),
}))

import { HubTabs } from '../HubStage'
import { useCreateStore } from '../../../../../stores/createStore'
import { useCharacterNames } from '../../../../../lib/create/character-names'
import { __resetSavedCharacters, listSavedCharacters, saveCharacter } from '../../../../../lib/saved-characters'
import { hubFromSaved, type HubCharacter } from '../../../../../lib/create/character-hub'
import type { CloudLora } from '../../../../../api/cloud/loras'

const photoChar: HubCharacter = { key: 'saved:1', kind: 'saved', name: 'Oma', meta: 'Photos · 2', image: null, photos: [new Blob(['a']), new Blob(['b'])] }
const localChar: HubCharacter = {
  key: 'local:char_opa_zimage.safetensors', kind: 'local', name: 'opa', meta: 'Local LoRA', image: null,
  ref: { id: 'local:char_opa_zimage.safetensors', name: 'opa', triggerWord: 'opa', family: 'zimage' },
}
const cloudChar: HubCharacter = {
  key: 'cloud:7', kind: 'cloud', name: 'seven', meta: 'Trained · Flux', image: null,
  ref: { id: '7', name: 'seven', triggerWord: 'sevenchar', family: 'flux' },
  lora: { id: '7', name: 'seven', triggerWord: 'sevenchar' } as unknown as CloudLora,
}

const stage = (c: HubCharacter | null, list: HubCharacter[] = c ? [c] : [photoChar]) =>
  render(
    <div className="lu-hub">
      <HubTabs list={list} loading={false} current={c?.key ?? null} photoOnly={!c} onPick={() => {}} onPhotoOnly={() => {}} onNew={() => {}} />
    </div>,
  )

const dots = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-hub-menu]')!
const list = () => document.querySelector<HTMLElement>('[data-hub-menu-list]')
const isOpen = () => !!list() && !list()!.parentElement!.className.split(' ').includes('hidden')
const rows = () => [...list()!.querySelectorAll('[role=menuitem]')].map((r) => r.textContent)
const open = (container: HTMLElement) => { fireEvent.click(dots(container)); expect(isOpen()).toBe(true) }

beforeEach(() => {
  __resetSavedCharacters()
  useCharacterNames.setState({ names: {} })
  io.deletedLoras = []
  io.localDeletePressed = 0
  io.downloads = 0
  useCreateStore.setState({ backend: 'local' } as never)
})
afterEach(() => cleanup())

describe('the three dots', () => {
  it('stand next to the picked tab only, and open the list of the model choice under them', () => {
    const { container } = stage(photoChar, [photoChar, { ...localChar }])
    expect(container.querySelectorAll('[data-hub-menu]')).toHaveLength(1)
    const pair = dots(container).parentElement!
    expect(pair.querySelector('[data-hub-character="saved:1"]')).not.toBeNull()
    expect(dots(container).getAttribute('aria-expanded')).toBe('false')
    expect(dots(container).getAttribute('aria-haspopup')).toBe('menu')
    open(container)
    expect(dots(container).getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu')
    expect(menu.getAttribute('data-hub-menu-list')).not.toBeNull()
    expect(menu.className).toContain('lu-picker-list')
    // Lifted to the body, on the floating sheet of the model choice.
    const sheet = menu.parentElement!
    expect(sheet.parentElement).toBe(document.body)
    expect(sheet.className).toContain('lu-elevated')
    expect(sheet.className).toContain('lu-picker')
    for (const r of screen.getAllByRole('menuitem')) expect(r.className).toContain('lu-picker-row')
    // No card, no portrait on the stage.
    expect(container.querySelector('.hub-card, .hub-portrait, [data-hub-card]')).toBeNull()
  })

  it('"Just use a photo" has none', () => {
    const { container } = stage(null)
    expect(container.querySelector('[data-hub-menu]')).toBeNull()
    expect(list()).toBeNull()
  })

  it('close with Escape and with a click beside, and a second press on the dots', () => {
    const { container } = stage(photoChar)
    open(container)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(isOpen()).toBe(false)
    expect(dots(container).getAttribute('aria-expanded')).toBe('false')
    open(container)
    fireEvent.pointerDown(document.body)
    expect(isOpen()).toBe(false)
    open(container)
    fireEvent.click(dots(container))
    expect(isOpen()).toBe(false)
  })

  it('a click inside the list does not close it by itself', () => {
    const { container } = stage(photoChar)
    open(container)
    fireEvent.pointerDown(list()!)
    expect(isOpen()).toBe(true)
  })
})

describe('the rows follow the character', () => {
  it('a saved photo character: Rename, Train a model, Delete', () => {
    const { container } = stage(photoChar)
    open(container)
    expect(rows()).toEqual(['Rename', 'Train a model', 'Delete'])
    expect(list()!.querySelector('[data-hub-rename]')).not.toBeNull()
    expect(list()!.querySelector('[data-hub-train]')).not.toBeNull()
    expect(list()!.querySelector('[data-hub-delete]')).not.toBeNull()
  })

  it('a local LoRA file: Rename and Delete; Delete asks the question of the file', () => {
    const { container } = stage(localChar)
    open(container)
    expect(rows()).toEqual(['Rename', 'Delete'])
    // Its own button is out of sight; the row presses it.
    expect(container.querySelector('[data-hub-local-delete]')!.className).toContain('[&>button]:hidden')
    fireEvent.click(list()!.querySelector('[data-hub-delete]')!)
    expect(io.localDeletePressed).toBe(1)
    expect(isOpen()).toBe(false)
    // No second question of its own.
    expect(container.querySelector('[data-hub-delete-ask]')).toBeNull()
  })

  it('a cloud LoRA in the cloud: Rename, Download, Use locally, Delete', async () => {
    useCreateStore.setState({ backend: 'cloud' } as never)
    const { container } = stage(cloudChar)
    open(container)
    expect(rows()).toEqual(['Rename', 'Download', 'Use locally', 'Delete'])
    // Download shows how far it is in its row: the list stays open.
    fireEvent.click(list()!.querySelector('[data-hub-download] .lu-picker-name')!)
    expect(io.downloads).toBe(1)
    expect(isOpen()).toBe(true)
    fireEvent.click(list()!.querySelector('[data-hub-delete]')!)
    expect(isOpen()).toBe(false)
    expect(container.querySelector('[data-hub-delete-ask]')!.textContent).toContain('Delete seven?')
    fireEvent.click(container.querySelector('[data-hub-delete-yes]')!)
    await waitFor(() => expect(io.deletedLoras).toEqual(['7']))
    await waitFor(() => expect(useCreateStore.getState().hubStep).toBe('who'))
  })

  it('a cloud LoRA on the local lane: only Rename, as the file actions had it', () => {
    const { container } = stage(cloudChar)
    open(container)
    expect(rows()).toEqual(['Rename'])
  })

  it('Train a model sends the photos to the training', () => {
    const { container } = stage(photoChar)
    open(container)
    fireEvent.click(list()!.querySelector('[data-hub-train]')!)
    expect(isOpen()).toBe(false)
    expect(useCreateStore.getState().hubStep).toBe('panel')
    expect(useCreateStore.getState().characterTab).toBe('train')
  })
})

describe('Rename', () => {
  it('puts the field where the name of the tab was, and saves the photo character', async () => {
    const { character } = await saveCharacter('Oma', [new Blob(['a'], { type: 'image/png' })])
    const c = hubFromSaved(character, null)
    const { container } = stage(c)
    open(container)
    fireEvent.click(list()!.querySelector('[data-hub-rename]')!)
    expect(isOpen()).toBe(false)
    const field = container.querySelector('[data-hub-rename-field]')!
    // In the row, in place of the tab: no card, no line of its own.
    expect(field.closest('[role=tablist]')).not.toBeNull()
    expect(container.querySelector(`button[data-hub-character="${c.key}"]`)).toBeNull()
    fireEvent.change(screen.getByLabelText('New name for Oma'), { target: { value: 'Greta' } })
    fireEvent.click(container.querySelector('[data-hub-rename-save]')!)
    await waitFor(async () => expect((await listSavedCharacters())[0].name).toBe('Greta'))
    await waitFor(() => expect(container.querySelector('[data-hub-rename-field]')).toBeNull())
  })

  it('Escape leaves it as it was; an empty name says so under the row', () => {
    const { container } = stage(cloudChar)
    open(container)
    fireEvent.click(list()!.querySelector('[data-hub-rename]')!)
    expect(container.querySelector('[data-hub-tabs-line]')!.textContent).toBe('The trigger word stays.')
    const input = screen.getByLabelText('New name for seven')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(container.querySelector('[data-hub-rename-save]')!)
    expect(screen.getByRole('alert').textContent).toBe('Give the character a name.')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(container.querySelector('[data-hub-rename-field]')).toBeNull()
    expect(useCharacterNames.getState().names).toEqual({})
  })
})

describe('Delete of a photo character', () => {
  it('asks in one plain line under the row; Keep leaves it, Delete removes it', async () => {
    const { character } = await saveCharacter('Oma', [new Blob(['a'], { type: 'image/png' })])
    const { container } = stage(hubFromSaved(character, null))
    open(container)
    fireEvent.click(list()!.querySelector('[data-hub-delete]')!)
    const ask = container.querySelector('[data-hub-delete-ask]')!
    expect(ask.textContent).toContain('Delete Oma?')
    // A line, not a box: it sits in the one quiet line under the row.
    expect(ask.parentElement!.hasAttribute('data-hub-tabs-line')).toBe(true)
    expect(ask.parentElement!.className).not.toMatch(/border|rounded|bg-|shadow/)
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(container.querySelector('[data-hub-delete-ask]')).toBeNull()
    expect(await listSavedCharacters()).toHaveLength(1)
    open(container)
    fireEvent.click(list()!.querySelector('[data-hub-delete]')!)
    fireEvent.click(container.querySelector('[data-hub-delete-yes]')!)
    await waitFor(async () => expect(await listSavedCharacters()).toHaveLength(0))
    expect(useCreateStore.getState().hubStep).toBe('who')
  })
})

describe('the quiet line', () => {
  it('a local LoRA has no second line under the row (David, 21.11.): its word is the tooltip of its tab', () => {
    const { container } = stage(localChar)
    expect(container.querySelector('[data-hub-tabs-line]')).toBeNull()
    expect(container.querySelector('[data-hub-character]')?.getAttribute('title')).toContain('trigger word: opa')
  })

  it('a photo character has none', () => {
    const { container } = stage(photoChar)
    expect(container.querySelector('[data-hub-tabs-line]')).toBeNull()
  })
})
